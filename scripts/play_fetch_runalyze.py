#!/usr/bin/env python3
"""
play_fetch_runalyze.py

Interactive helper to create Playwright storage_state files (one-time per account)
and a convenience fetch command to use that storage_state to fetch Runalyze endpoints
(marathon-shape, vo2max) and the Prognosis panel HTML (parsed into JSON + raw HTML saved).

Usage (interactive login -> produce storage JSON):
  python scripts/play_fetch_runalyze.py login --storage storage_kristin.json

Usage (headless fetch using an existing storage JSON):
  python scripts/play_fetch_runalyze.py fetch --storage storage_kristin.json --user kristin \
    --from-date 2025-08-10 --to-date 2025-11-08
"""
import argparse
import json
from pathlib import Path
import datetime
import calendar
import sys
import re
from playwright.sync_api import sync_playwright

# Write fetched data into docs/data so the workflow can commit it for GitHub Pages
DATA_DIR = Path("docs/data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

MARATHON_TEMPLATE = "https://runalyze.com/_internal/data/athlete/history/marathon-shape/{from_date}/{to_date}"
VO2_TEMPLATE = "https://runalyze.com/_internal/data/athlete/history/vo2max/{from_ts}/{to_ts}"
PROG_URL = "https://runalyze.com/plugin/RunalyzePluginPanel_Prognose/window.plot.php"

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

def fetch_with_storage(storage_state_path: str, url: str, browser_type: str = "chromium"):
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
            text = resp.text()
        except Exception as e:
            return {"error": "playwright_error", "exception": str(e)}
        finally:
            browser.close()
        try:
            return json.loads(text)
        except Exception:
            return {"error": "non_json_response", "text": text}

def parse_prognosis_html(html_text: str):
    """
    Parse the Prognosis panel HTML to extract predicted distances, times and paces.
    Returns list of entries like:
      [{ "distance_mi": 1.86, "distance_label": "1,86 mi", "time": "13:13", "pace": "7:05/mi" }, ...]
    """
    if not html_text or not isinstance(html_text, str):
        return {"error": "no_html"}

    # Quick login detection to surface when storage_state is stale
    lower = html_text.lower()
    login_indicators = ['login', 'signin', 'sign in', 'two-factor', '2fa']
    login_detected = any(tok in lower for tok in login_indicators)

    # Try to extract the panel-content block first (safer than scanning whole page)
    panel_match = re.search(r'<div[^>]+class=["\']panel-content["\'][^>]*>(.*?)</div>', html_text, re.S | re.I)
    block = panel_match.group(1) if panel_match else html_text

    entries = []
    # Find <p>...</p> blocks inside the panel content
    p_blocks = re.findall(r'<p[^>]*>(.*?)</p>', block, re.S | re.I)
    # tolerant regex for the common structure: time in <strong> inside right span, pace in <small>, distance in <strong> later
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

    # fallback: if none found in <p>s, try a more global regex
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

    # Final fallback: look for lines that contain 'mi' and a time pattern "mm:ss" or "h:mm:ss"
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

    # sort entries by numeric distance when possible
    try:
        entries.sort(key=lambda e: (e.get("distance_mi") is None, e.get("distance_mi") or 0))
    except Exception:
        pass

    return {"meta": {"login_detected": bool(login_detected), "found": len(entries) > 0}, "entries": entries}

def fetch_prognosis(storage_state_path: str, user_label: str):
    """
    Fetch the prognosis panel HTML using the provided storage_state.
    Save raw HTML to docs/data/<user>_prognosis.html and parsed JSON to docs/data/<user>_prognosis.json.
    Return the parsed structure (same as written to JSON).
    """
    storage_state_path = Path(storage_state_path)
    if not storage_state_path.exists():
        return {"error": "storage_state_missing", "path": str(storage_state_path)}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(storage_state_path))
        page = context.new_page()
        try:
            resp = page.goto(PROG_URL, wait_until="networkidle", timeout=30000)
            if resp is None:
                return {"error": "no_response", "url": PROG_URL}
            # prefer page.content() for full HTML
            text = page.content()
        except Exception as e:
            return {"error": "playwright_error", "exception": str(e)}
        finally:
            browser.close()

    # save raw html for debugging
    prog_out_html = DATA_DIR / f"{user_label}_prognosis.html"
    prog_out_html.write_text(text, encoding='utf-8')

    # parse
    parsed = parse_prognosis_html(text)

    # write JSON with debug meta
    prog_out = DATA_DIR / f"{user_label}_prognosis.json"
    prog_out.write_text(json.dumps(parsed, indent=2), encoding="utf-8")

    return parsed

def run_fetch(storage_path: str, user_label: str, from_date="2025-08-10", to_date="2025-11-08"):
    user_label = user_label.replace(" ", "_").lower()
    storage_path = Path(storage_path)
    marathon_url = MARATHON_TEMPLATE.format(from_date=from_date, to_date=to_date)

    vo2_from_ts = to_epoch_seconds(from_date)
    vo2_to_ts = to_epoch_seconds(to_date) + 86399
    vo2_url = VO2_TEMPLATE.format(from_ts=vo2_from_ts, to_ts=vo2_to_ts)

    print(f"[{user_label}] Fetching marathon-shape: {marathon_url}")
    marathon_json = fetch_with_storage(str(storage_path), marathon_url)
    marathon_out = DATA_DIR / f"{user_label}_marathon.json"
    marathon_out.write_text(json.dumps(marathon_json, indent=2), encoding="utf-8")
    print(f"[{user_label}] Wrote {marathon_out}")

    print(f"[{user_label}] Fetching vo2max: {vo2_url}")
    vo2_json = fetch_with_storage(str(storage_path), vo2_url)
    vo2_out = DATA_DIR / f"{user_label}_vo2.json"
    vo2_out.write_text(json.dumps(vo2_json, indent=2), encoding="utf-8")
    print(f"[{user_label}] Wrote {vo2_out}")

    print(f"[{user_label}] Fetching prognosis panel: {PROG_URL}")
    prog_parsed = fetch_prognosis(str(storage_path), user_label)
    print(f"[{user_label}] Wrote prognosis for {user_label} (entries: {prog_parsed.get('entries') and len(prog_parsed.get('entries')) or 0})")

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
