#!/usr/bin/env python3
"""
play_fetch_runalyze.py

Interactive helper to create Playwright storage_state files (one-time per account)
and a convenience fetch command to use that storage_state to fetch Runalyze internal
JSON endpoints (marathon-shape and vo2max) and the Prognosis panel HTML (parsed into JSON).

Usage (interactive login -> produce storage JSON):
  python scripts/play_fetch_runalyze.py login --storage storage_kristin.json

Usage (headless fetch using an existing storage JSON):
  python scripts/play_fetch_runalyze.py fetch --storage storage_kristin.json --user kristin \
    --from-date 2025-08-10 --to-date 2025-11-08

Notes:
 - Install Playwright: pip install playwright
 - Install browsers: playwright install
 - login opens a visible browser so you can sign in and complete 2FA if required.
 - fetch runs headless using the saved storage_state file and writes JSON to docs/data/<user>_marathon.json and docs/data/<user>_vo2.json
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
    """
    Opens a visible browser so user can sign in. After you complete login (and 2FA if needed),
    return to the terminal and press ENTER to save storage_state to storage_path.
    """
    storage_path = Path(storage_path)
    with sync_playwright() as p:
        browser = getattr(p, browser_type).launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.goto("https://runalyze.com/login")
        print("Interactive login opened. Sign in (complete 2FA if required).")
        print("When you're fully logged in and redirected to your Runalyze account, return here and press ENTER to save storage_state.")
        input("Press ENTER after you've logged in and Runalyze shows your account page... ")
        context.storage_state(path=str(storage_path))
        print(f"Saved logged-in storage_state to: {storage_path}")
        browser.close()

def to_epoch_seconds(date_str: str):
    dt = datetime.datetime.strptime(date_str, "%Y-%m-%d")
    return int(calendar.timegm(dt.timetuple()))

def fetch_with_storage(storage_state_path: str, url: str, browser_type: str = "chromium"):
    """
    Use a saved storage_state file to fetch an endpoint and return parsed JSON (or raw text on error).
    """
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
            # Return raw text for debugging (e.g., login HTML)
            return {"error": "non_json_response", "text": text}

def parse_prognosis_html(html_text: str):
    """
    Parse the Prognosis panel HTML to extract predicted distances, times and paces.

    Returns list of entries like:
      [{ "distance_mi": 1.86, "distance_label": "1.86 mi", "time": "13:13", "pace": "7:05/mi" }, ...]
    """
    if not html_text or not isinstance(html_text, str):
        return {"error": "no_html"}

    # Very tolerant regex to extract blocks that look like the snippet:
    # <p> <span class="right"> ... <strong>13:13</strong> <small>(7:05/mi)</small> </span> <strong>1,86&nbsp;mi</strong> </p>
    pattern = re.compile(
        r'<p[^>]*>.*?<span[^>]*class=["\']right["\'][^>]*>.*?<strong[^>]*>\s*([^<]+?)\s*</strong>.*?<small[^>]*>\s*\(?([^<\)]+?)\)?\s*</small>.*?</span>.*?<strong[^>]*>\s*([^<]+?mi)\s*</strong>',
        re.S | re.I
    )

    matches = pattern.findall(html_text)
    entries = []
    for m in matches:
        time_str = m[0].strip()
        pace_str = m[1].strip()
        dist_label = m[2].strip()
        # Normalize distance: convert "1,86 mi" (commas, NBSP) to float miles
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

    # Fallback: try a simpler pattern if above found nothing (some layouts differ)
    if not entries:
        # find paragraphs with "mi" and try to extract time and pace next to them
        simple_pattern = re.compile(r'<p[^>]*>(.*?)</p>', re.S | re.I)
        for block in simple_pattern.findall(html_text):
            if 'mi' not in block:
                continue
            # try to find the distance
            d_match = re.search(r'([0-9\.,]+\s*mi)', block, re.I)
            t_match = re.search(r'<strong[^>]*>\s*([^<]+?)\s*</strong>', block, re.I)
            p_match = re.search(r'\(([^)]+/mi)\)', block, re.I)
            if d_match:
                dist_label = d_match.group(1).strip()
                dist_clean = re.sub(r'[^\d,\.]', '', dist_label).replace(',', '.')
                try:
                    dist_num = float(dist_clean)
                except Exception:
                    dist_num = None
                time_str = t_match.group(1).strip() if t_match else None
                pace_str = p_match.group(1).strip() if p_match else None
                entries.append({
                    "distance_label": dist_label,
                    "distance_mi": dist_num,
                    "time": time_str,
                    "pace": pace_str
                })

    # sort entries by distance if distance available
    try:
        entries.sort(key=lambda e: (e.get("distance_mi") is None, e.get("distance_mi") or 0))
    except Exception:
        pass

    return entries

def fetch_prognosis(storage_state_path: str):
    """
    Fetch the prognosis panel HTML using the provided storage_state. Returns parsed list or raw response on error.
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
            text = resp.text()
        except Exception as e:
            return {"error": "playwright_error", "exception": str(e)}
        finally:
            browser.close()

    # parse the HTML
    parsed = parse_prognosis_html(text)
    return parsed

def run_fetch(storage_path: str, user_label: str, from_date="2025-08-10", to_date="2025-11-08"):
    user_label = user_label.replace(" ", "_").lower()
    storage_path = Path(storage_path)
    # Build URLs
    marathon_url = MARATHON_TEMPLATE.format(from_date=from_date, to_date=to_date)

    vo2_from_ts = to_epoch_seconds(from_date)
    # include full to_date until 23:59:59
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

    # Fetch prognosis panel HTML and parse
    print(f"[{user_label}] Fetching prognosis panel: {PROG_URL}")
    prog_parsed = fetch_prognosis(str(storage_path))
    prog_out = DATA_DIR / f"{user_label}_prognosis.json"
    prog_out.write_text(json.dumps(prog_parsed, indent=2), encoding="utf-8")
    print(f"[{user_label}] Wrote {prog_out}")

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
