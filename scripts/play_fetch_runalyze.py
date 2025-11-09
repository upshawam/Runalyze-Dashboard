#!/usr/bin/env python3
"""
play_fetch_runalyze.py

Helper to create Playwright storage_state files (one-time per account)
and to fetch Runalyze endpoints/pages using that storage_state.

This script:
 - fetches marathon-shape data (internal JSON endpoint),
 - fetches vo2max trend JSON,
 - fetches the Prognosis plugin HTML and parses it into JSON,
 - fetches the Marathon Shape page HTML and parses the requirements table (including "Optimum")
   and writes it to docs/data/<user>_marathon_requirements.json.

It now also records a UTC last-updated timestamp into each generated JSON under the "_meta.last_updated" key.

Usage:
  python scripts/play_fetch_runalyze.py login --storage storage_kristin.json
  python scripts/play_fetch_runalyze.py fetch --storage storage_kristin.json --user kristin

Notes:
 - Requires Playwright: pip install playwright
 - Install browsers: playwright install
"""
import argparse
import json
from pathlib import Path
import datetime
import calendar
import sys
import re
from playwright.sync_api import sync_playwright

DATA_DIR = Path("docs/data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

MARATHON_TEMPLATE = "https://runalyze.com/_internal/data/athlete/history/marathon-shape/{from_date}/{to_date}"
VO2_TEMPLATE = "https://runalyze.com/_internal/data/athlete/history/vo2max/{from_ts}/{to_ts}"
PROG_URL = "https://runalyze.com/plugin/RunalyzePluginPanel_Prognose/window.plot.php"
MAR_SHAPE_PAGE = "https://runalyze.com/my/marathon-shape"

def utc_now_iso():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def interactive_login(storage_path: str, browser_type: str = "chromium"):
    storage_path = Path(storage_path)
    with sync_playwright() as p:
        browser = getattr(p, browser_type).launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.goto("https://runalyze.com/login")
        print("Interactive login opened. Sign in (complete 2FA if required).")
        input("Press ENTER after you've logged in and Runalyze shows your account page... ")
        context.storage_state(path=str(storage_path))
        print(f"Saved logged-in storage_state to: {storage_path}")
        browser.close()

def to_epoch_seconds(date_str: str):
    dt = datetime.datetime.strptime(date_str, "%Y-%m-%d")
    return int(calendar.timegm(dt.timetuple()))

def fetch_with_storage(storage_state_path: str, url: str, browser_type: str = "chromium", prefer_page_content=False):
    storage_state_path = Path(storage_state_path)
    if not storage_state_path.exists():
        return {"error": "storage_state_missing", "path": str(storage_state_path)}
    with sync_playwright() as p:
        browser = getattr(p, browser_type).launch(headless=True)
        context = browser.new_context(storage_state=str(storage_state_path))
        page = context.new_page()
        try:
            resp = page.goto(url, wait_until="networkidle", timeout=30000)
            if resp is None:
                return {"error": "no_response", "url": url}
            if prefer_page_content:
                text = page.content()
            else:
                text = resp.text()
        except Exception as e:
            return {"error": "playwright_error", "exception": str(e)}
        finally:
            browser.close()
        try:
            return json.loads(text)
        except Exception:
            # Return raw text for debugging (e.g., login HTML or page HTML)
            return {"error": "non_json_response", "text": text}

def parse_prognosis_html(html_text: str):
    """
    Parse Prognosis plugin HTML into entries:
      [{ distance_label, distance_mi, time, pace }, ...]
    Also returns meta: login_detected, found
    """
    if not html_text or not isinstance(html_text, str):
        return {"meta": {"login_detected": False, "found": False}, "entries": []}

    lower = html_text.lower()
    login_indicators = ['login', 'signin', 'sign in', 'two-factor', '2fa']
    login_detected = any(tok in lower for tok in login_indicators)

    # Try to extract the panel-content block first
    panel_match = re.search(r'<div[^>]+class=["\']panel-content["\'][^>]*>(.*?)</div>', html_text, re.S | re.I)
    block = panel_match.group(1) if panel_match else html_text

    entries = []
    p_blocks = re.findall(r'<p[^>]*>(.*?)</p>', block, re.S | re.I)
    p_re = re.compile(
        r'<span[^>]*class=["\']right["\'][^>]*>.*?<strong[^>]*>\s*([^<]+?)\s*</strong>.*?<small[^>]*>\s*\(?([^<\)]+?)\)?\s*</small>.*?</span>.*?<strong[^>]*>\s*([^<]+?mi)\s*</strong>',
        re.S | re.I)

    for pb in p_blocks:
        m = p_re.search(pb)
        if m:
            time_str = m.group(1).strip()
            pace_str = m.group(2).strip()
            dist_label = m.group(3).strip()
            dist_clean = re.sub(r'[^\d,\.]', '', dist_label).replace(',', '.')
            try:
                dist_num = float(dist_clean)
            except Exception:
                dist_num = None
            entries.append({
                "distance_label": dist_label,
                "distance_mi": dist_num,
                "time": time_str,
                "pace": pace_str
            })

    # fallback global regex
    if not entries:
        global_pattern = re.compile(
            r'<p[^>]*>.*?(?:<strong[^>]*>\s*([^<]+?)\s*</strong>).*?(?:<small[^>]*>\s*\(?([^<\)]+?)\)?\s*</small>).*?(?:<strong[^>]*>\s*([^<]+?mi)\s*</strong>).*?</p>',
            re.S | re.I)
        for m in global_pattern.findall(html_text):
            time_str = m[0].strip() if m[0] else None
            pace_str = m[1].strip() if m[1] else None
            dist_label = m[2].strip() if m[2] else None
            dist_num = None
            if dist_label:
                dist_clean = re.sub(r'[^\d,\.]', '', dist_label).replace(',', '.')
                try:
                    dist_num = float(dist_clean)
                except Exception:
                    dist_num = None
            entries.append({
                "distance_label": dist_label,
                "distance_mi": dist_num,
                "time": time_str,
                "pace": pace_str
            })

    # final fallback: look for lines that contain 'mi' and a time pattern
    if not entries:
        simple_pattern = re.compile(r'([0-9\.,]+\s*mi).*?([0-9]{1,2}:[0-5][0-9](?::[0-5][0-9])?).*?(\([0-9]{1,2}:[0-5][0-9]\/mi\))', re.S | re.I)
        for m in simple_pattern.findall(html_text):
            dist_label = m[0].strip()
            time_str = m[1].strip()
            pace_str = m[2].strip().strip('()')
            dist_num = None
            dist_clean = re.sub(r'[^\d,\.]', '', dist_label).replace(',', '.')
            try:
                dist_num = float(dist_clean)
            except Exception:
                dist_num = None
            entries.append({
                "distance_label": dist_label,
                "distance_mi": dist_num,
                "time": time_str,
                "pace": pace_str
            })

    try:
        entries.sort(key=lambda e: (e.get("distance_mi") is None, e.get("distance_mi") or 0))
    except Exception:
        pass

    return {"meta": {"login_detected": bool(login_detected), "found": len(entries) > 0}, "entries": entries}

def parse_marathon_requirements_html(html_text: str):
    """
    Parse the Marathon Shape page table rows into structured entries.
    Expected columns (based on Runalyze HTML):
      Distance | Marathon Shape (required %) | Weekly mileage | Long Run | Achieved (%) | Achieved icon | Prognosis (time) | Optimum (time)

    Returns structure: { meta: {...}, entries: [ { distance_label, distance_mi, required_pct, weekly, long_run, achieved_pct, achieved_ok, prognosis_time, optimum_time }, ... ] }
    """
    if not html_text or not isinstance(html_text, str):
        return {"meta": {"login_detected": False, "found": False}, "entries": []}

    lower = html_text.lower()
    login_indicators = ['login', 'signin', 'sign in', 'two-factor', '2fa']
    login_detected = any(tok in lower for tok in login_indicators)

    # Try to extract the table block first
    table_match = re.search(r'<table[^>]*class=["\'][^"\']*zebra-style[^"\']*["\'][^>]*>(.*?)</table>', html_text, re.S | re.I)
    block = table_match.group(1) if table_match else html_text

    entries = []
    # Find table rows
    tr_pattern = re.compile(r'<tr[^>]*class=["\'][^"\']*r[^"\']*["\'][^>]*>(.*?)</tr>', re.S | re.I)
    td_pattern = re.compile(r'<td[^>]*>(.*?)</td>', re.S | re.I)

    for tr in tr_pattern.findall(block):
        # extract all <td> contents in the row
        tds = td_pattern.findall(tr)
        # normalize and strip tags inside cells
        def clean_html(s):
            s = re.sub(r'<[^>]+>', '', s)  # remove any inner tags
            s = s.replace('&nbsp;', ' ')
            return s.strip()

        if len(tds) < 7:
            # try to skip header or malformed rows
            continue

        try:
            distance_cell = clean_html(tds[0])
            required_cell = clean_html(tds[1])
            weekly_cell = clean_html(tds[2])
            longrun_cell = clean_html(tds[3])
            achieved_cell = clean_html(tds[4])
            # tds[5] is icon cell (check or x)
            prognosis_cell = clean_html(tds[6]) if len(tds) > 6 else None
            optimum_cell = clean_html(tds[7]) if len(tds) > 7 else None
        except Exception:
            continue

        # parse numbers
        distance_mi = None
        try:
            dist_clean = re.sub(r'[^\d,\.]', '', distance_cell).replace(',', '.')
            distance_mi = float(dist_clean) if dist_clean else None
        except Exception:
            distance_mi = None

        required_pct = None
        try:
            req_clean = re.sub(r'[^\d\.]', '', required_cell)
            required_pct = int(req_clean) if req_clean else None
        except Exception:
            required_pct = None

        achieved_pct = None
        try:
            ach_clean = re.sub(r'[^\d\.]', '', achieved_cell)
            achieved_pct = int(ach_clean) if ach_clean else None
        except Exception:
            achieved_pct = None

        # achieved icon: check for 'fa-check' in original tds[5]
        achieved_ok = False
        try:
            if re.search(r'fa-check', tds[5], re.I):
                achieved_ok = True
            elif re.search(r'fa-xmark|fa-times|xmark|minus', tds[5], re.I):
                achieved_ok = False
        except Exception:
            achieved_ok = False

        prognosis_time = prognosis_cell if prognosis_cell and prognosis_cell != '-' else None
        optimum_time = optimum_cell if optimum_cell and optimum_cell != '-' else None

        entries.append({
            "distance_label": distance_cell,
            "distance_mi": distance_mi,
            "required_pct": required_pct,
            "weekly": weekly_cell,
            "long_run": longrun_cell,
            "achieved_pct": achieved_pct,
            "achieved_ok": achieved_ok,
            "prognosis_time": prognosis_time,
            "optimum_time": optimum_time
        })

    return {"meta": {"login_detected": bool(login_detected), "found": len(entries) > 0}, "entries": entries}

def fetch_prognosis(storage_state_path: str, user_label: str):
    storage_state_path = Path(storage_state_path)
    if not storage_state_path.exists():
        return {"error": "storage_state_missing", "path": str(storage_state_path)}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(storage_state_path))
        page = context.new_page()
        try:
            page.goto(PROG_URL, wait_until="networkidle", timeout=30000)
            text = page.content()
        except Exception as e:
            return {"error": "playwright_error", "exception": str(e)}
        finally:
            browser.close()

    parsed = parse_prognosis_html(text)
    # add last-updated meta
    if isinstance(parsed, dict):
        parsed.setdefault('_meta', {})
        parsed['_meta']['last_updated'] = utc_now_iso()
    out = DATA_DIR / f"{user_label}_prognosis.json"
    out.write_text(json.dumps(parsed, indent=2), encoding="utf-8")
    # write raw html for debugging
    raw_html_out = DATA_DIR / f"{user_label}_prognosis.html"
    raw_html_out.write_text(text, encoding="utf-8")
    return parsed

def fetch_marathon_requirements(storage_state_path: str, user_label: str):
    storage_state_path = Path(storage_state_path)
    if not storage_state_path.exists():
        return {"error": "storage_state_missing", "path": str(storage_state_path)}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(storage_state_path))
        page = context.new_page()
        try:
            page.goto(MAR_SHAPE_PAGE, wait_until="networkidle", timeout=30000)
            text = page.content()
        except Exception as e:
            return {"error": "playwright_error", "exception": str(e)}
        finally:
            browser.close()

    parsed = parse_marathon_requirements_html(text)
    # add last-updated meta
    if isinstance(parsed, dict):
        parsed.setdefault('_meta', {})
        parsed['_meta']['last_updated'] = utc_now_iso()
    out = DATA_DIR / f"{user_label}_marathon_requirements.json"
    out.write_text(json.dumps(parsed, indent=2), encoding="utf-8")
    raw_html_out = DATA_DIR / f"{user_label}_marathon_requirements.html"
    raw_html_out.write_text(text, encoding="utf-8")
    return parsed

def write_json_with_meta(path: Path, content):
    """
    Ensure we add a safe _meta.last_updated field without disturbing content.
    If content is a dict, insert _meta; otherwise wrap.
    """
    if isinstance(content, dict):
        content.setdefault('_meta', {})
        content['_meta']['last_updated'] = utc_now_iso()
        path.write_text(json.dumps(content, indent=2), encoding="utf-8")
    else:
        wrapper = {"value": content, "_meta": {"last_updated": utc_now_iso()}}
        path.write_text(json.dumps(wrapper, indent=2), encoding="utf-8")

def run_fetch(storage_path: str, user_label: str, from_date="2025-08-10", to_date="2025-11-08"):
    user_label = user_label.replace(" ", "_").lower()
    storage_path = Path(storage_path)
    marathon_url = MARATHON_TEMPLATE.format(from_date=from_date, to_date=to_date)

    vo2_from_ts = to_epoch_seconds(from_date)
    vo2_to_ts = to_epoch_seconds(to_date) + 86399
    vo2_url = VO2_TEMPLATE.format(from_ts=vo2_from_ts, to_ts=vo2_to_ts)

    print(f"[{user_label}] Fetching marathon-shape (internal JSON): {marathon_url}")
    marathon_json = fetch_with_storage(str(storage_path), marathon_url)
    marathon_out = DATA_DIR / f"{user_label}_marathon.json"
    # add _meta.last_updated safely
    write_json_with_meta(marathon_out, marathon_json)
    print(f"[{user_label}] Wrote {marathon_out}")

    print(f"[{user_label}] Fetching vo2max: {vo2_url}")
    vo2_json = fetch_with_storage(str(storage_path), vo2_url)
    vo2_out = DATA_DIR / f"{user_label}_vo2.json"
    write_json_with_meta(vo2_out, vo2_json)
    print(f"[{user_label}] Wrote {vo2_out}")

    print(f"[{user_label}] Fetching prognosis panel: {PROG_URL}")
    prog_parsed = fetch_prognosis(str(storage_path), user_label)
    print(f"[{user_label}] Wrote prognosis (entries: {prog_parsed.get('entries') and len(prog_parsed.get('entries')) or 0})")

    print(f"[{user_label}] Fetching marathon requirements page: {MAR_SHAPE_PAGE}")
    mr_parsed = fetch_marathon_requirements(str(storage_path), user_label)
    print(f"[{user_label}] Wrote marathon requirements (entries: {mr_parsed.get('entries') and len(mr_parsed.get('entries')) or 0})")

def main():
    parser = argparse.ArgumentParser(description="Playwright helper for Runalyze storage and fetch")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="Interactive login and save Playwright storage_state")
    p_login.add_argument("--storage", required=True, help="output storage_state json file (e.g., storage_kristin.json)")
    p_login.add_argument("--browser", choices=["chromium", "firefox", "webkit"], default="chromium", help="browser to use for interactive login")

    p_fetch = sub.add_parser("fetch", help="Fetch endpoints using saved storage_state (non-interactive)")
    p_fetch.add_argument("--storage", required=True, help="path to Playwright storage_state json")
    p_fetch.add_argument("--user", required=True, help="user label for output filenames (e.g., kristin or aaron)")
    p_fetch.add_argument("--from-date", default="2025-08-10", help="YYYY-MM-DD")
    p_fetch.add_argument("--to-date", default="2025-11-08", help="YYYY-MM-DD")

    args = parser.parse_args()

    if args.cmd == "login":
        try:
            interactive_login(args.storage, browser_type=args.browser)
        except KeyboardInterrupt:
            print("Interrupted, exiting.")
            sys.exit(1)
    elif args.cmd == "fetch":
        try:
            run_fetch(args.storage, args.user, args.from_date, args.to_date)
        except Exception as e:
            print("Fetch error:", e, file=sys.stderr)
            sys.exit(2)

if __name__ == "__main__":
    main()
