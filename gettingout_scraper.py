#!/usr/bin/env python3
"""
GettingOut / ViaPath API scraper
Pulls full inmate rosters for all PA facilities via the public pay.gettingout.com API.
No authentication required. Deduplicates by booking_code.
Usage:
  python3 gettingout_scraper.py --facility 176171
  python3 gettingout_scraper.py --all
  python3 gettingout_scraper.py --list
"""

import urllib.request
import json
import time
import argparse
import os
import sys
from datetime import datetime

BASE_URL = "https://pay.gettingout.com"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Origin": "https://my.viapath.com",
    "Referer": "https://my.viapath.com/"
}
SEARCH_CHARS = "abcdefghijklmnopqrstuvwxyz"
DELAY = 0.15  # seconds between requests

# Output directory — use /data if available (Railway volume), else cwd
DATA_DIR = "/data" if os.path.exists("/data") else os.path.dirname(os.path.abspath(__file__))


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def get_pa_facilities():
    data = fetch(f"{BASE_URL}/pay/get_fac_list?facility_state=PA")
    return [f for f in data if not f.get("is_closed") and not f.get("is_juve") and not f.get("is_ice")]


def scrape_facility(facility_id, facility_label):
    seen = {}
    for ch in SEARCH_CHARS:
        try:
            url = f"{BASE_URL}/pay/search_inmates?facility_id={facility_id}&name_query={ch}"
            results = fetch(url)
            for inmate in results:
                key = str(inmate.get("booking_code") or inmate.get("id", ""))
                if key and key not in seen:
                    seen[key] = {
                        "id":            inmate.get("id"),
                        "name":          f"{inmate.get('first_name', '')} {inmate.get('last_name', '')}".strip(),
                        "firstName":     inmate.get("first_name", ""),
                        "lastName":      inmate.get("last_name", ""),
                        "dob":           inmate.get("date_of_birth", ""),
                        "bookingNumber": inmate.get("booking_code", ""),
                        "bookDate":      inmate.get("book_date", ""),
                        "facility":      facility_label,
                        "facilityId":    facility_id,
                        "source":        "gettingout"
                    }
            time.sleep(DELAY)
        except Exception as e:
            print(f"  Warning: search '{ch}' failed — {e}", file=sys.stderr)
            time.sleep(1)

    return list(seen.values())


def save_facility(facility_id, facility_label, inmates):
    # Build a safe filename key from facility label
    safe = facility_label.lower()
    safe = safe.replace(" county", "").replace(" jail", "").replace(" prison", "")
    safe = safe.replace(" pa", "").replace(" correctional facility", "").replace(",", "")
    safe = "".join(c if c.isalnum() else "-" for c in safe.strip())
    safe = safe.strip("-")

    out = {
        "facility":      facility_label,
        "facilityId":    facility_id,
        "facilityKey":   safe,
        "count":         len(inmates),
        "lastUpdated":   datetime.utcnow().isoformat() + "Z",
        "source":        "gettingout",
        "contacts":      sorted(inmates, key=lambda x: x.get("lastName", ""))
    }

    path = os.path.join(DATA_DIR, f"go_{safe}.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2)

    print(f"  Saved {len(inmates)} inmates → {path}")
    return path, safe


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--facility", type=int, help="Scrape a single facility by ID")
    parser.add_argument("--all", action="store_true", help="Scrape all PA facilities")
    parser.add_argument("--list", action="store_true", help="List all PA facilities and exit")
    parser.add_argument("--exclude", nargs="*", default=[], help="Facility IDs to exclude")
    args = parser.parse_args()

    facilities = get_pa_facilities()

    if args.list:
        print(f"{'ID':>8}  Facility")
        print("-" * 60)
        for f in sorted(facilities, key=lambda x: x["label"]):
            print(f"  {f['id']:>6}  {f['label']}")
        return

    exclude_ids = set(int(x) for x in args.exclude)

    if args.facility:
        fac = next((f for f in facilities if f["id"] == args.facility), None)
        if not fac:
            print(f"Facility {args.facility} not found in PA list", file=sys.stderr)
            sys.exit(1)
        targets = [fac]
    elif args.all:
        targets = [f for f in facilities if f["id"] not in exclude_ids]
    else:
        parser.print_help()
        return

    results = {}
    for fac in sorted(targets, key=lambda x: x["label"]):
        fid = fac["id"]
        label = fac["label"]
        print(f"\nScraping: {label} (ID: {fid})")
        try:
            inmates = scrape_facility(fid, label)
            path, key = save_facility(fid, label, inmates)
            results[key] = {"label": label, "id": fid, "count": len(inmates), "file": path}
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)

    # Write index file for the backend to discover
    index_path = os.path.join(DATA_DIR, "go_facilities_index.json")
    with open(index_path, "w") as f:
        json.dump({
            "lastUpdated": datetime.utcnow().isoformat() + "Z",
            "facilities": results
        }, f, indent=2)
    print(f"\nIndex saved → {index_path}")
    print(f"\nDone. Scraped {len(results)} facilities.")


if __name__ == "__main__":
    main()
