#!/usr/bin/env python3
"""
Non-interactive CI fetch script for GitHub Actions.

Usage:
  python scripts/ci_fetch_runalyze.py --storage tmp/storage_alice.json --user alice --from-date YYYY-MM-DD --to-date YYYY-MM-DD

This script:
 - loads a Playwright storage_state json file (saved from an interactive login)
 - uses it to request the two internal endpoints (marathon-shape and vo2max)
 - writes results to docs/data/<user>_marathon.json and docs/data/<user>_vo2.json

Note: storage json must be created locally with an interactive login and uploaded to repo secrets (base64-encoded).
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
import datetime, calendar
import sys

MARATHON_TEMPLATE = "https://runalyze.com/_internal/data/athlete/history/marathon-shape/{from_date}/{to_date}"
VO2_TEMPLATE = "https://runalyze.com/_internal/data/athlete/history/vo2max/{from_ts}/{to_ts}"

OUT_DIR = Path("docs/data")
OUT_DIR.mkdir(parents=True, exist_ok=True)

def to_epoch_seconds(date_str):
    dt = datetime.datetime.strptime(date_str, "%Y-%m-%d")
    return int(calendar.timegm(dt.timetuple()))

def fetch_with_storage(storage_state_path: str, url: str):
    if not storage_state_path or not Path(storage_state_path).exists():
        return {"error": "storage_state_missing", "path": str(storage_state_path)}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=storage_state_path)
        page = context.new_page()
        resp = page.goto(url, wait_until="networkidle")
        text = resp.text()
        browser.close()
        try:
            return json.loads(text)
        except Exception:
            return {"error": "non_json_response", "text": text}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--storage", required=True, help="path to Playwright storage_state json")
    parser.add_argument("--user", required=True, help="label for the account (used in output filenames)")
    parser.add_argument("--from-date", required=True)
    parser.add_argument("--to-date", required=True)
    args = parser.parse_args()

    user_label = args.user.replace(" ", "_")
    from_date = args.from_date
    to_date = args.to_date

    # marathon URL
    marathon_url = MARATHON_TEMPLATE.format(from_date=from_date, to_date=to_date)

    # vo2 timestamps: from_date -> start of day, to_date -> end of day
    vo2_from_ts = to_epoch_seconds(from_date)
    # end of to_date day (23:59:59)
    vo2_to_ts = to_epoch_seconds(to_date) + 86399
    vo2_url = VO2_TEMPLATE.format(from_ts=vo2_from_ts, to_ts=vo2_to_ts)

    print(f"[{user_label}] Fetching marathon: {marathon_url}")
    marathon_json = fetch_with_storage(args.storage, marathon_url)
    marathon_out = OUT_DIR / f"{user_label}_marathon.json"
    marathon_out.write_text(json.dumps(marathon_json, indent=2), encoding="utf-8")
    print(f"[{user_label}] Wrote {marathon_out}")

    print(f"[{user_label}] Fetching vo2: {vo2_url}")
    vo2_json = fetch_with_storage(args.storage, vo2_url)
    vo2_out = OUT_DIR / f"{user_label}_vo2.json"
    vo2_out.write_text(json.dumps(vo2_json, indent=2), encoding="utf-8")
    print(f"[{user_label}] Wrote {vo2_out}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR:", e, file=sys.stderr)
        sys.exit(2)
