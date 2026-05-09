#!/usr/bin/env python3
"""
PA County Jail Inmate Lookup
Fetches current inmate rosters from York, Lancaster, and Dauphin county jails.

Usage:
  python pa_jail_lookup.py --facility york
  python pa_jail_lookup.py --facility york --bookings
  python pa_jail_lookup.py --facility dauphin
  python pa_jail_lookup.py --facility lancaster
  python pa_jail_lookup.py --facility york --export output.csv
"""

import sys
import re
import time
import argparse
import csv
import urllib3
from datetime import datetime

import requests
from bs4 import BeautifulSoup

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ─────────────────────────────────────────────────────────────────────────────
#  Facility Registry
# ─────────────────────────────────────────────────────────────────────────────

FACILITIES = {
    "york": {
        "name": "York County Detention Center",
        "url": "https://inmatesinjail.yorkcountygov.com/detentioncenter/inmatesinjail.aspx",
        "type": "york_aspnet",
    },
    "york-prison": {
        "name": "York County Prison (sentenced)",
        "url": "https://inmatesinjail.yorkcountygov.com/prison/inmatesinjail.aspx",
        "type": "york_aspnet",
    },
    "dauphin": {
        "name": "Dauphin County Prison",
        "url": "https://www.dauphinc.org:9443/IML",
        "type": "dauphin_iml",
    },
    "lancaster": {
        "name": "Lancaster County Prison",
        "url": "https://inmatesearch.lancastercountypa.gov",
        "type": "lancaster_atims",
    },
    "crawford": {
        "name": "Crawford County Correctional Facility",
        "url": "https://www.crawfordcountypa.net/CCCF/Pages/Inmate-Lists.aspx",
        "type": "crawford_pdf",
    },
    "monroe": {
        "name": "Monroe County Jail",
        "url": "https://www.monroecounty.gov/files/inmate/roster.pdf",
        "type": "monroe_pdf",
    },
    "erie": {
        "name": "Erie County Prison",
        "url": "https://www2.erie.gov/sheriff/sites/www2.erie.gov.sheriff/files/uploads/data/inmatelist.pdf",
        "type": "erie_pdf",
    },
    "cumberland": {
        "name": "Cumberland County Prison",
        "url": "https://ccweb.ccpa.net/inmatelisting/",
        "type": "cumberland_html",
    },
    "mercer": {
        "name": "Mercer County Jail",
        "url": "https://www.mercercountypa.gov/jail/jailreport/Alphabetical.cfm",
        "type": "mercer_cfm",
    },
    "westmoreland": {
        "name": "Westmoreland County Prison",
        "url": "https://apps.westmorelandcountypa.gov/prison/PrisonInmates/PRISON_INMATES.ASP",
        "type": "westmoreland_asp",
    },
    "luzerne": {
        "name": "Luzerne County (PA DOC)",
        "url": "https://inmatelocator.cor.pa.gov/#/",
        "type": "padoc_county",
        "county_id": "LUZ",
    },
    "padoc": {
        "name": "PA Dept. of Corrections (State Prisons)",
        "url": "https://inmatelocator.cor.pa.gov/#/",
        "type": "padoc_api",
    },
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    )
}


# ─────────────────────────────────────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────────────────────────────────────

def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def get_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.verify = False
    return s


def get_asp_fields(soup: BeautifulSoup) -> dict:
    fields = {}
    for name in ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"]:
        tag = soup.find("input", {"name": name})
        if tag:
            fields[name] = tag.get("value", "")
    return fields


# ─────────────────────────────────────────────────────────────────────────────
#  York County — ASP.NET paginated GridView
# ─────────────────────────────────────────────────────────────────────────────

def parse_york_page(soup: BeautifulSoup, facility_name: str) -> list[dict]:
    inmates = []
    main_tbl = soup.find("table", class_="dgMain")
    if not main_tbl:
        return inmates

    for row in main_tbl.find_all("tr", recursive=False):
        if row.get("class") and any(c in ["pager", "header"] for c in row["class"]):
            continue
        cells = row.find_all("td", recursive=False)
        if len(cells) < 3:
            continue

        # Name + age from nested info table
        name, age = "", ""
        for it in cells[0].find_all("table"):
            first_row = it.find("tr")
            if not first_row:
                continue
            name_td = first_row.find("td")
            if not name_td:
                continue
            raw = clean(name_td.get_text(" "))
            if "," in raw and any(c.isalpha() for c in raw) and len(raw) < 80:
                name = raw
                tds_i = first_row.find_all("td")
                age = clean(tds_i[1].get_text()) if len(tds_i) > 1 else ""
                break

        if not name:
            continue

        # Gender from Race/Sex field in cell 0  e.g. "Race/Sex: W M"
        gender = ""
        cell0_text = clean(cells[0].get_text(" "))
        sex_m = re.search(r'Race/Sex:\s*\S+\s+(M|F)\b', cell0_text)
        if sex_m:
            gender = "M" if sex_m.group(1) == "M" else "F"

        # Bookings from third cell
        bookings = []
        for b_tbl in cells[2].find_all("table"):
            b_rows = b_tbl.find_all("tr")
            if len(b_rows) < 2:
                continue
            hdrs = [clean(td.get_text()) for td in b_rows[0].find_all("td")]
            for br in b_rows[1:]:
                vals = [clean(td.get_text()) for td in br.find_all("td")]
                if vals:
                    bookings.append(dict(zip(hdrs, vals)))

        inmates.append({"name": name, "age": age, "gender": gender, "facility": facility_name, "bookings": bookings})
    return inmates


def get_york_pager(soup: BeautifulSoup):
    """Return (current_page, ordered_items). Each item: ('current'|'page'|'dots', val, target)."""
    pager_row = soup.find("tr", class_="pager")
    if not pager_row:
        return None, []
    td = pager_row.find("td")
    if not td:
        return None, []
    items, current = [], None
    for el in td.children:
        if not hasattr(el, "name"):
            continue
        txt = el.get_text(strip=True)
        if el.name == "span" and txt.isdigit():
            current = int(txt)
            items.append(("current", int(txt), None))
        elif el.name == "a":
            href = el.get("href", "")
            m = re.search(r"'(dgJackets[^']+)'", href)
            target = m.group(1) if m else None
            if txt.isdigit():
                items.append(("page", int(txt), target))
            elif txt == "...":
                items.append(("dots", "...", target))
    return current, items


def fetch_york(url: str, facility_name: str) -> list[dict]:
    sess = get_session()
    all_inmates, visited = [], set()

    print(f"  Page 1 ...", end="", flush=True)
    resp = sess.get(url, timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    page = parse_york_page(soup, facility_name)
    all_inmates.extend(page)
    visited.add(1)
    print(f" {len(page)} records")

    for _ in range(60):  # safety cap
        current, items = get_york_pager(soup)
        if not items:
            break

        current_idx = next((i for i, (t, _, _) in enumerate(items) if t == "current"), None)

        # Try direct link to next page first
        next_target = None
        for typ, val, target in items:
            if typ == "page" and isinstance(val, int) and val == current + 1 and val not in visited:
                next_target = (val, target)
                break

        # Fall back to forward "..."
        if not next_target and current_idx is not None:
            for typ, val, target in items[current_idx:]:
                if typ == "dots":
                    next_target = ("...", target)
                    break

        if not next_target:
            break

        _, target = next_target
        asp = get_asp_fields(soup)
        resp = sess.post(url, data={"__EVENTTARGET": target, "__EVENTARGUMENT": "", **asp}, timeout=20)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        new_current, _ = get_york_pager(soup)
        if new_current is None or new_current in visited:
            break

        page = parse_york_page(soup, facility_name)
        all_inmates.extend(page)
        visited.add(new_current)
        print(f"  Page {new_current} ... {len(page)} records (total: {len(all_inmates)})")
        time.sleep(0.25)

    return all_inmates


# ─────────────────────────────────────────────────────────────────────────────
#  Dauphin County — IML offset-based pagination
# ─────────────────────────────────────────────────────────────────────────────

def parse_dauphin_page(soup: BeautifulSoup, facility_name: str) -> list[dict]:
    """Extract inmate rows from IML results — deduplicated by booking number."""
    seen_bookings = set()
    inmates = []
    # IML duplicates content across nested tables; deduplicate on booking number
    for tbl in soup.find_all("table"):
        for row in tbl.find_all("tr"):
            cells = [clean(td.get_text()) for td in row.find_all("td")]
            # Valid inmate row: name has comma, booking number matches pattern
            if (len(cells) >= 4
                    and "," in cells[0]
                    and re.match(r"[A-Z]{2}\d", cells[1])):
                bnum = cells[1]
                if bnum in seen_bookings:
                    continue
                seen_bookings.add(bnum)
                inmates.append({
                    "name": cells[0],
                    "booking_number": bnum,
                    "dob": cells[3] if len(cells) > 3 else "",
                    "release_date": cells[4] if len(cells) > 4 else "",
                    "gender": "",
                    "facility": facility_name,
                    "bookings": [],
                })
    return inmates


def fetch_dauphin(url: str, facility_name: str) -> list[dict]:
    sess = get_session()
    all_inmates = []

    # Initial search — blank last name returns all current inmates
    search_payload = {
        "flow_action": "searchbyname",
        "quantity": "30",
        "systemUser_identifiervalue": "",
        "searchtype": "NAME",
        "systemUser_includereleasedinmate": "",
        "systemUser_includereleasedinmate2": "",
        "systemUser_firstName": "",
        "systemUser_lastName": "",
        "systemUser_dateOfBirth": "",
    }

    print(f"  Page 1 ...", end="", flush=True)
    resp = sess.post(url, data=search_payload, timeout=20)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    page = parse_dauphin_page(soup, facility_name)
    all_inmates.extend(page)
    print(f" {len(page)} records")

    # Determine total
    total_match = re.search(r"of\s+([\d,]+)\s+results", resp.text)
    total = int(total_match.group(1).replace(",", "")) if total_match else 0
    if total:
        print(f"  Total reported by server: {total}")

    # Paginate via offset — hidden fields flow_action=next & currentStart
    current_start = 31
    page_num = 2

    while current_start <= total:
        next_payload = {
            "flow_action": "next",
            "currentStart": str(current_start),
            "quantity": "30",
        }
        print(f"  Page {page_num} ...", end="", flush=True)
        resp = sess.post(url, data=next_payload, timeout=20)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        page = parse_dauphin_page(soup, facility_name)
        if not page:
            break
        all_inmates.extend(page)
        print(f" {len(page)} records (total: {len(all_inmates)})")

        current_start += 30
        page_num += 1
        time.sleep(0.25)

    return all_inmates


# ─────────────────────────────────────────────────────────────────────────────
#  Lancaster County — ATIMS API (reCAPTCHA v3 bypassed via Playwright)
# ─────────────────────────────────────────────────────────────────────────────

LANCASTER_API = "https://lcp-inmatesearch-api.atimsle.com/"
LANCASTER_LOGIN = "https://inmatesearch.lancastercountypa.gov/login"


def get_lancaster_token() -> str:
    """Use Playwright to click the reCAPTCHA v3 checkbox and capture the auth token."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError("playwright not installed; run: pip install playwright && playwright install chromium")

    token = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()

        def on_req(req):
            nonlocal token
            if "GetCaptchaResponse" in req.url and req.method == "POST":
                try:
                    import json as _json
                    token = _json.loads(req.post_data).get("captchaResponse")
                except Exception:
                    pass

        page.on("request", on_req)
        print("  Launching headless browser for Lancaster auth...", end="", flush=True)
        page.goto(LANCASTER_LOGIN, wait_until="networkidle")
        page.wait_for_timeout(3000)
        page.locator(".mdc-checkbox__native-control").first.click()
        page.wait_for_url("**/InmateSearch/**", timeout=15000)
        page.wait_for_timeout(2000)
        browser.close()

    if not token:
        raise RuntimeError("Failed to capture Lancaster auth token from browser")
    print(f" done.")
    return token


def fetch_lancaster(url: str, facility_name: str) -> list[dict]:
    """Fetch all active inmates from Lancaster County Prison via ATIMS API."""
    import json as _json

    token = get_lancaster_token()

    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://inmatesearch.lancastercountypa.gov",
        "Referer": "https://inmatesearch.lancastercountypa.gov/",
        "User-Agent": HEADERS["User-Agent"],
    }
    payload = {
        "lastName": "", "firstName": "", "middleName": "",
        "inmateActive": True, "dateOfBirth": None,
        "bookingNumber": "", "inmateNumber": "", "lastInitial": "A",
    }

    sess = requests.Session()
    sess.verify = False

    print(f"  Fetching roster from ATIMS API...", end="", flush=True)
    resp = sess.post(
        f"{LANCASTER_API}Search/Search",
        json=payload,
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    records = resp.json()
    print(f" {len(records)} records")

    from datetime import datetime as _dt

    inmates = []
    for rec in records:
        if not rec.get("inmateActive", True):
            continue
        last = (rec.get("lastName") or "").strip()
        first = (rec.get("firstName") or "").strip()
        mid = (rec.get("middleName") or "").strip()
        name_parts = [n for n in [last, first + (" " + mid if mid else "")] if n]
        name = f"{last}, {first}" + (f" {mid}" if mid else "")
        if not name.strip():
            continue

        # DOB formatting
        dob_raw = rec.get("dob") or ""
        try:
            dob = _dt.fromisoformat(dob_raw[:10]).strftime("%m/%d/%Y") if dob_raw else ""
        except Exception:
            dob = dob_raw[:10]

        # Commit date formatting
        date_in_raw = rec.get("dateIn") or ""
        try:
            date_in = _dt.fromisoformat(date_in_raw[:10]).strftime("%m/%d/%Y") if date_in_raw else ""
        except Exception:
            date_in = date_in_raw[:10]

        inmates.append({
            "name": name,
            "dob": dob,
            "booking_number": (rec.get("bookingNumber") or "").strip(),
            "gender": ("M" if (rec.get("gender") or "").upper().startswith("M") else "F" if (rec.get("gender") or "").upper().startswith("F") else ""),
            "race": rec.get("race") or "",
            "date_in": date_in,
            "arresting_agency": (rec.get("arrestingAgency") or "").strip(),
            "facility": facility_name,
            "bookings": [],
        })

    return inmates


# ─────────────────────────────────────────────────────────────────────────────
#  Dispatch
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
#  PA DOC — State Prison System
# ─────────────────────────────────────────────────────────────────────────────

PADOC_API = "https://captorapi.cor.pa.gov/InmateLocatorAPIV8/api/v1/InmateLocator/SearchResults"
PADOC_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Referer": "https://inmatelocator.cor.pa.gov/",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
}


def _padoc_search(session: requests.Session, location_id: str = "---", sex: str = "---", last_prefix: str = "") -> list[dict]:
    """Single API call to PA DOC search endpoint."""
    payload = {
        "id": "", "firstName": "", "lastName": last_prefix, "middleName": "",
        "paroleNumber": "", "countylistkey": "---", "citizenlistkey": "---",
        "sexlistkey": sex, "locationlistkey": location_id,
        "age": "", "dateofbirth": None, "sortBy": "1"
    }
    r = session.post(PADOC_API, json=payload, headers=PADOC_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json().get("inmates", [])


def _padoc_get_locations(session: requests.Session) -> list[dict]:
    """Fetch facility list from PA DOC reference data."""
    r = session.get(
        "https://inmatelocator.cor.pa.gov/assets/data/referenceData.json",
        headers=PADOC_HEADERS, timeout=15
    )
    r.raise_for_status()
    locs = r.json().get("location", [])
    return [l for l in locs if l["id"] != "---"]


def _padoc_add_results(all_inmates: dict, results: list[dict], sex_override: str = "") -> None:
    """Merge API results into all_inmates dict, deriving gender from sex_override."""
    for rec in results:
        num = rec.get("inmate_number", "")
        if not num or num in all_inmates:
            continue
        last   = clean(rec.get("inm_lastname", ""))
        first  = clean(rec.get("inm_firstname", ""))
        mid    = clean(rec.get("inm_middlename", ""))
        suffix = clean(rec.get("inm_namesuffix", ""))
        first_full = " ".join(p for p in [first, mid] if p)
        name = f"{last}, {first_full}" if first_full else last
        if suffix:
            name += f" {suffix}"
        all_inmates[num] = {
            "name": name,
            "dob": clean(rec.get("dob", "")),
            "gender": sex_override,
            "booking_number": num,
            "facility": clean(rec.get("fac_name", "")),
            "county": clean(rec.get("cnty_name", "")),
        }


def fetch_padoc(url: str, facility_name: str) -> list[dict]:
    """
    Fetch all active PA DOC state prison inmates using parallel HTTP requests.

    Strategy:
      1. Load all facility IDs from the PA DOC reference data.
      2. Fire all facility-level queries in parallel (20 workers).
      3. For any facility that returns exactly 500 (capped), split by sex M/F in parallel.
      4. For facility+sex combos still at 500, split by A-Z last-name prefix in parallel.
    All stages use ThreadPoolExecutor to minimise wall-clock time (~30-60s total).
    """
    import string
    from concurrent.futures import ThreadPoolExecutor, as_completed
    ALPHA = list(string.ascii_uppercase)
    WORKERS = 20

    # Thread-safe dict requires a lock for merging
    import threading
    lock = threading.Lock()
    all_inmates: dict = {}

    def make_session() -> requests.Session:
        s = requests.Session()
        s.verify = False
        return s

    def search(loc: str = "---", sex: str = "---", last: str = "") -> list[dict]:
        """Thread-safe single API call (each thread gets its own session)."""
        s = make_session()
        try:
            payload = {
                "id": "", "firstName": "", "lastName": last, "middleName": "",
                "paroleNumber": "", "countylistkey": "---", "citizenlistkey": "---",
                "sexlistkey": sex, "locationlistkey": loc,
                "age": "", "dateofbirth": None, "sortBy": "1"
            }
            r = s.post(PADOC_API, json=payload, headers=PADOC_HEADERS, timeout=30)
            r.raise_for_status()
            return r.json().get("inmates", [])
        except Exception:
            return []

    def add(results: list[dict], sex_override: str = "") -> None:
        with lock:
            _padoc_add_results(all_inmates, results, sex_override=sex_override)

    # ── Step 1: fetch all facilities in parallel ──────────────────────────────
    print("  Loading PA DOC facility list...", flush=True)
    ref_sess = make_session()
    locations = _padoc_get_locations(ref_sess)
    print(f"  {len(locations)} locations found. Fetching in parallel...", flush=True)

    capped_locs = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(search, loc["id"]): loc for loc in locations}
        for fut in as_completed(futs):
            loc = futs[fut]
            results = fut.result()
            if len(results) == 500:
                capped_locs.append(loc)
            else:
                add(results)

    print(f"  {len(all_inmates)} from small facilities. {len(capped_locs)} need sex-split.", flush=True)

    # ── Step 2: capped facilities → split by sex ─────────────────────────────
    capped_sex = []  # (loc_id, sex, loc_name)
    sex_tasks = [(loc["id"], sex, loc["name"]) for loc in capped_locs for sex in ["M", "F"]]

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(search, lid, sex): (lid, sex, lname) for lid, sex, lname in sex_tasks}
        for fut in as_completed(futs):
            lid, sex, lname = futs[fut]
            results = fut.result()
            if len(results) == 500:
                capped_sex.append((lid, sex, lname))
            else:
                add(results, sex_override=sex)

    print(f"  {len(all_inmates)} so far. {len(capped_sex)} combos need A-Z split.", flush=True)

    # ── Step 3: capped sex combos → split by first letter of last name ────────
    # Build all (loc_id, sex, letter) tasks up front
    letter_tasks = [
        (lid, sex, lname, letter)
        for lid, sex, lname in capped_sex
        for letter in ALPHA
    ]

    # Track any that still hit 500 at single-letter level
    still_capped = []  # (lid, sex, lname, letter)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(search, lid, sex, letter): (lid, sex, lname, letter)
                for lid, sex, lname, letter in letter_tasks}
        for fut in as_completed(futs):
            lid, sex, lname, letter = futs[fut]
            results = fut.result()
            if len(results) == 500:
                still_capped.append((lid, sex, lname, letter))
            else:
                add(results, sex_override=sex)

    if still_capped:
        print(f"  {len(still_capped)} letter buckets still capped, going to 2-char prefix...", flush=True)
        two_char_tasks = [
            (lid, sex, lname, letter + c2)
            for lid, sex, lname, letter in still_capped
            for c2 in ALPHA
        ]
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(search, lid, sex, prefix): (lid, sex, prefix)
                    for lid, sex, _, prefix in two_char_tasks}
            for fut in as_completed(futs):
                lid, sex, prefix = futs[fut]
                add(fut.result(), sex_override=sex)

    result_list = sorted(all_inmates.values(), key=lambda x: x.get("name", ""))
    print(f"  Total PA DOC inmates retrieved: {len(result_list)}", flush=True)
    return result_list


# ─────────────────────────────────────────────────────────────────────────────
#  Adams County Sheriff (CO) — adamssheriffco.gov
# ─────────────────────────────────────────────────────────────────────────────

ADAMS_URL = "https://adamssheriffco.gov/community/public-records/inmate-search/"


def fetch_adams(url: str, facility_name: str) -> list[dict]:
    """
    Fetch all current Adams County (CO) Sheriff inmates.

    The site requires at least one search field with 2+ chars (client-side only).
    We sweep all 26 letters as last_name prefix and deduplicate by booking number.
    Each inmate appears as multiple rows (one per charge); we take only the first.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import string

    HEADERS = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": "https://adamssheriffco.gov/inmate-services/",
    }

    def fetch_letter(letter: str) -> list[dict]:
        try:
            r = requests.get(
                ADAMS_URL,
                params={"last_name": letter, "first_name": ""},
                headers=HEADERS,
                timeout=20,
            )
            from bs4 import SoupStrainer
            only_table = SoupStrainer("table", id="warrant-results-table")
            soup = BeautifulSoup(r.text, "html.parser", parse_only=only_table)
            table = soup.find("table")
            if not table:
                return []
            tbody = table.find("tbody")
            if not tbody:
                return []
            rows = tbody.find_all("tr")
            results = []
            for row in rows:
                cells = row.find_all("td")
                if len(cells) >= 5:
                    results.append({
                        "name": clean(cells[0].get_text(" ", strip=True)),
                        "dob": clean(cells[1].get_text(strip=True)),
                        "gender": clean(cells[2].get_text(strip=True))[:1].upper(),
                        "booking_date": clean(cells[3].get_text(strip=True)),
                        "booking_number": clean(cells[4].get_text(strip=True)),
                        "facility": facility_name,
                    })
            return results
        except Exception:
            return []

    all_inmates: dict[str, dict] = {}  # keyed by booking_number

    # Server requires 2+ chars — sweep all 2-char last_name prefixes (aa..zz = 676 calls)
    # 50 parallel workers completes in ~25 seconds
    prefixes = [a + b for a in string.ascii_lowercase for b in string.ascii_lowercase]

    with ThreadPoolExecutor(max_workers=50) as ex:
        futs = {ex.submit(fetch_letter, prefix): prefix for prefix in prefixes}
        for fut in as_completed(futs):
            for rec in fut.result():
                bnum = rec["booking_number"]
                if bnum and bnum not in all_inmates:
                    all_inmates[bnum] = rec

    result_list = sorted(all_inmates.values(), key=lambda x: x.get("name", ""))
    return result_list


# ─────────────────────────────────────────────────────────────────────────────
#  Crawford County Correctional Facility — daily PDF roster
# ─────────────────────────────────────────────────────────────────────────────

CRAWFORD_PDF_URL = "https://www.crawfordcountypa.net/CCCF/InmateLists/inmate%20list.pdf"


def fetch_crawford(url: str, facility_name: str) -> list[dict]:
    """
    Fetch Crawford County Correctional Facility inmate roster from their
    daily-generated PDF. Fields: name, booking date, sentence end date.
    No DOB or gender available from this source.
    """
    try:
        import pdfplumber
        import io
    except ImportError:
        raise RuntimeError("pdfplumber is required: pip install pdfplumber")

    HEADERS = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    }

    r = requests.get(CRAWFORD_PDF_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()

    inmates = []
    seen = set()

    with pdfplumber.open(io.BytesIO(r.content)) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                for row in table:
                    if not row or len(row) < 2:
                        continue
                    name_raw = clean(row[0] or "")
                    booking_raw = clean(row[1] or "")
                    sentence_end = clean(row[2] or "") if len(row) > 2 else ""

                    # Skip header rows and empty rows
                    if not name_raw or name_raw.lower() in ("inmate's name", "name", ""):
                        continue
                    if not booking_raw or not any(c.isdigit() for c in booking_raw):
                        continue
                    # Skip "Nmn" suffix (no middle name) — keep as is
                    # Deduplicate
                    key = f"{name_raw}|{booking_raw}"
                    if key in seen:
                        continue
                    seen.add(key)

                    inmates.append({
                        "name": name_raw,
                        "dob": "",
                        "gender": "",
                        "booking_number": booking_raw,  # booking date used as ID
                        "facility": facility_name,
                    })

    return sorted(inmates, key=lambda x: x["name"])


# ─────────────────────────────────────────────────────────────────────────────
#  Cumberland County Prison — static HTML list
# ─────────────────────────────────────────────────────────────────────────────

CUMBERLAND_URL = "https://ccweb.ccpa.net/inmatelisting/"


def fetch_cumberland(url: str, facility_name: str) -> list[dict]:
    """
    Fetch Cumberland County Prison inmate list.
    Page is a plain HTML <ul>/<li> list of names (LAST, FIRST MIDDLE).
    No DOB, gender, or booking number available.
    """
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    }
    r = requests.get(CUMBERLAND_URL, headers=HEADERS, timeout=20)
    r.raise_for_status()

    soup = BeautifulSoup(r.text, "html.parser")
    items = soup.find_all("li")

    inmates = []
    for idx, item in enumerate(items, 1):
        name_raw = clean(item.get_text(strip=True))
        if not name_raw or "," not in name_raw:
            continue
        inmates.append({
            "name": name_raw,
            "dob": "",
            "gender": "",
            "booking_number": "",
            "facility": facility_name,
        })

    return sorted(inmates, key=lambda x: x["name"])


# ─────────────────────────────────────────────────────────────────────────────
#  Westmoreland County Prison — ASP HTML table
# ─────────────────────────────────────────────────────────────────────────────

WESTMORELAND_URL = "https://apps.westmorelandcountypa.gov/prison/PrisonInmates/PRISON_INMATES.ASP"


def fetch_westmoreland(url: str, facility_name: str) -> list[dict]:
    """
    Fetch Westmoreland County Prison inmates from their ASP roster page.
    Single GET with lname=All returns all ~640 inmates in one HTML table.
    Fields: name, DOB, booking number, commitment date, unit.
    """
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    }
    r = requests.get(WESTMORELAND_URL, params={"lname": "All"}, headers=HEADERS, timeout=20)
    r.raise_for_status()

    soup = BeautifulSoup(r.text, "html.parser")
    table = soup.find("table")
    if not table:
        return []

    inmates = []
    header_skipped = False
    for row in table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 3:
            continue
        name_raw = clean(cells[0].get_text(strip=True))
        dob_raw  = clean(cells[1].get_text(strip=True))
        bnum_raw = clean(cells[2].get_text(strip=True))

        # Skip header rows
        if name_raw.lower() in ("name", "") or "last name" in name_raw.lower():
            continue
        if not name_raw or "," not in name_raw:
            continue
        # Skip rows with no digits in booking number
        if not any(c.isdigit() for c in bnum_raw):
            continue

        inmates.append({
            "name": name_raw,
            "dob": dob_raw,
            "gender": "",  # not provided
            "booking_number": bnum_raw,
            "facility": facility_name,
        })

    return sorted(inmates, key=lambda x: x["name"])


# ─────────────────────────────────────────────────────────────────────────────
#  PA DOC county-filtered fetch (reusable for any county)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_padoc_county(url: str, facility_name: str, county_id: str = "---") -> list[dict]:
    """
    Fetch PA DOC inmates filtered by county of commitment.
    Uses sex + last-name-letter splitting to handle the 500-record cap.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import string

    session = requests.Session()
    session.verify = False
    all_inmates: dict = {}

    def search(sex: str = "---", last: str = "") -> list[dict]:
        try:
            payload = {
                "id": "", "firstName": "", "lastName": last, "middleName": "",
                "paroleNumber": "", "countylistkey": county_id, "citizenlistkey": "---",
                "sexlistkey": sex, "locationlistkey": "---",
                "age": "", "dateofbirth": None, "sortBy": "1"
            }
            r = session.post(PADOC_API, json=payload, headers=PADOC_HEADERS, timeout=30)
            r.raise_for_status()
            return r.json().get("inmates", [])
        except Exception:
            return []

    # Step 1: try both sexes at county level
    for sex in ["M", "F"]:
        results = search(sex)
        if len(results) == 500:
            # Split by first letter of last name
            with ThreadPoolExecutor(max_workers=26) as ex:
                futs = {ex.submit(search, sex, letter): letter for letter in string.ascii_uppercase}
                for fut in as_completed(futs):
                    for rec in fut.result():
                        _padoc_add_results(all_inmates, [rec], sex_override=sex)
        else:
            _padoc_add_results(all_inmates, results, sex_override=sex)

    result_list = sorted(all_inmates.values(), key=lambda x: x.get("name", ""))
    return result_list


# ─────────────────────────────────────────────────────────────────────────────
#  Mercer County Jail — ColdFusion HTML tables
# ─────────────────────────────────────────────────────────────────────────────

MERCER_URL = "https://www.mercercountypa.gov/jail/jailreport/Alphabetical.cfm"


def fetch_mercer(url: str, facility_name: str) -> list[dict]:
    """
    Fetch Mercer County Jail roster from their ColdFusion alphabetical report.
    Page has three separate HTML tables: MALES, FEMALES, TRANSFERS.
    Gender is derived from which table the inmate appears in.
    Fields: name, commit date (used as booking date), admission type.
    No DOB or booking number available.
    """
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    }
    r = requests.get(MERCER_URL, headers=HEADERS, timeout=20)
    r.raise_for_status()

    soup = BeautifulSoup(r.text, "html.parser")
    tables = soup.find_all("table")

    inmates = []

    for table in tables:
        # Find preceding heading label (h4 sibling is most reliable)
        prev_sib = table.find_previous_sibling()
        label = (prev_sib.get_text(strip=True) if prev_sib else "").lower()
        # Check females BEFORE males to avoid substring match ("males" in "females")
        if "females" in label:
            gender = "F"
        elif "males" in label:
            gender = "M"
        else:
            gender = ""

        rows = table.find_all("tr")
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            name_raw = clean(cells[0].get_text(strip=True))
            commit_raw = clean(cells[1].get_text(strip=True))

            # Skip header and empty rows
            if not name_raw or name_raw.lower() == "name":
                continue
            # Name format is "LAST FIRST" — convert to "Last, First"
            parts = name_raw.split()
            if len(parts) >= 2:
                name_fmt = f"{parts[0].capitalize()}, {' '.join(p.capitalize() for p in parts[1:])}"
            else:
                name_fmt = name_raw.title()

            inmates.append({
                "name": name_fmt,
                "dob": "",
                "gender": gender,
                "booking_number": commit_raw,  # commit date used as booking ref
                "facility": facility_name,
            })

    return sorted(inmates, key=lambda x: x["name"])


# ─────────────────────────────────────────────────────────────────────────────
#  Monroe County — live PDF roster (pdftotext -layout)
# ─────────────────────────────────────────────────────────────────────────────

MONROE_PDF_URL = "https://www.monroecounty.gov/files/inmate/roster.pdf"


def fetch_monroe(url: str, facility_name: str) -> list[dict]:
    """
    Monroe County Jail roster PDF.
    Layout: MCJ#  Last Name  First Name  Date of Entry
    Uses pdftotext -layout via subprocess for clean column parsing.
    """
    import subprocess, io, tempfile, os

    r = requests.get(MONROE_PDF_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()

    # Write to temp file then pdftotext
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(r.content)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            ["pdftotext", "-layout", tmp_path, "-"],
            capture_output=True, text=True, timeout=30
        )
        text = result.stdout
    finally:
        os.unlink(tmp_path)

    inmates = []
    seen = set()

    for line in text.splitlines():
        # Lines start with a 5-7 digit MCJ number
        import re
        m = re.match(r'^(\d{5,7})\s+(\S+)\s+(\S+(?:\s+\S+)?)\s+(\d{1,2}/\d{1,2}/\d{4})\s*$', line.strip())
        if not m:
            # Try looser match — MCJ# followed by last, first, date
            m = re.match(r'^(\d{5,7})\s+(\S+)\s+(\S+)\s+(\d{1,2}/\d{1,2}/\d{4})', line.strip())
        if not m:
            continue
        mcj_num = m.group(1)
        last = m.group(2).title()
        first = m.group(3).title()
        entry_date = m.group(4)
        name = f"{last}, {first}"
        key = f"{name}|{mcj_num}"
        if key in seen:
            continue
        seen.add(key)
        inmates.append({
            "name": name,
            "dob": "",
            "gender": "",
            "booking_number": mcj_num,
            "facility": facility_name,
        })

    return sorted(inmates, key=lambda x: x["name"])


# ─────────────────────────────────────────────────────────────────────────────
#  Erie County — live PDF roster (pdftotext -layout)
# ─────────────────────────────────────────────────────────────────────────────

ERIE_PDF_URL = "https://www2.erie.gov/sheriff/sites/www2.erie.gov.sheriff/files/uploads/data/inmatelist.pdf"


def fetch_erie(url: str, facility_name: str) -> list[dict]:
    """
    Erie County Sheriff inmate roster PDF.
    Layout: ICN#  Inmate Name (LAST, FIRST)  DOB  Facility  Booking Date
    Uses pdftotext -layout via subprocess.
    """
    import subprocess, io, tempfile, os, re

    r = requests.get(ERIE_PDF_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(r.content)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            ["pdftotext", "-layout", tmp_path, "-"],
            capture_output=True, text=True, timeout=30
        )
        text = result.stdout
    finally:
        os.unlink(tmp_path)

    inmates = []
    seen = set()

    for line in text.splitlines():
        # Lines: ICN#   LAST, FIRST [MI]   MM/DD/YYYY   FACILITY   MM/DD/YYYY
        m = re.match(
            r'^(\d{3,7})\s+([A-Z][A-Z\s,\'\-\.]+?)\s+(\d{2}/\d{2}/\d{4})\s+(\S+)\s+(\d{2}/\d{2}/\d{4})\s*$',
            line.strip()
        )
        if not m:
            continue
        icn = m.group(1)
        name_raw = m.group(2).strip().rstrip(',')
        dob = m.group(3)
        booking_date = m.group(5)

        # Name is already "LAST, FIRST" — title-case it
        parts = name_raw.split(',')
        if len(parts) == 2:
            name = f"{parts[0].strip().title()}, {parts[1].strip().title()}"
        else:
            name = name_raw.title()

        key = f"{name}|{icn}"
        if key in seen:
            continue
        seen.add(key)
        inmates.append({
            "name": name,
            "dob": dob,
            "gender": "",
            "booking_number": icn,
            "facility": facility_name,
        })

    return sorted(inmates, key=lambda x: x["name"])


FETCHERS = {
    "york_aspnet": fetch_york,
    "dauphin_iml": fetch_dauphin,
    "lancaster_atims": fetch_lancaster,
    "adams_sheriff": fetch_adams,
    "crawford_pdf": fetch_crawford,
    "cumberland_html": fetch_cumberland,
    "mercer_cfm": fetch_mercer,
    "westmoreland_asp": fetch_westmoreland,
    "padoc_county": fetch_padoc_county,
    "padoc_api": fetch_padoc,
    "monroe_pdf": fetch_monroe,
    "erie_pdf": fetch_erie,
}


def fetch_roster(facility_key: str) -> list[dict]:
    fac = FACILITIES[facility_key]
    print(f"\nFacility : {fac['name']}")
    print(f"Source   : {fac['url']}")
    print("─" * 70)

    fn = FETCHERS.get(fac["type"])
    if not fn:
        print(f"  [ERROR] No fetcher for type '{fac['type']}'")
        return []

    try:
        # Pass county_id for padoc_county type facilities
        if fac["type"] == "padoc_county":
            return fn(fac["url"], fac["name"], county_id=fac.get("county_id", "---"))
        return fn(fac["url"], fac["name"])
    except requests.exceptions.ConnectionError as e:
        print(f"  [ERROR] Connection failed: {e}")
        return []
    except requests.exceptions.Timeout:
        print(f"  [ERROR] Request timed out.")
        return []
    except Exception as e:
        print(f"  [ERROR] {e}")
        return []


# ─────────────────────────────────────────────────────────────────────────────
#  Display
# ─────────────────────────────────────────────────────────────────────────────

def display_roster(inmates: list[dict], show_bookings: bool = False):
    real = [i for i in inmates if "name" in i]
    notes = [i for i in inmates if "note" in i]

    for n in notes:
        print(f"  NOTE: {n['note']}")

    if not real:
        print("  No inmate records retrieved.")
        return

    print(f"\n{'#':<6} {'NAME':<38} {'DOB':<12} {'SEX':<4} {'BOOKING #':<20} FACILITY")
    print("─" * 110)

    for idx, inmate in enumerate(real, 1):
        name     = inmate.get("name", "")
        dob      = inmate.get("dob", inmate.get("age", ""))
        gender   = inmate.get("gender", "")
        bnum     = inmate.get("booking_number", "")
        facility = inmate.get("facility", "")
        print(f"{idx:<6} {name:<38} {dob:<12} {gender:<4} {bnum:<20} {facility}")

        if show_bookings and inmate.get("bookings"):
            for b in inmate["bookings"]:
                parts = []
                if b.get("Booking Number"):
                    parts.append(f"Booking#: {b['Booking Number']}")
                if b.get("Booking Date"):
                    parts.append(f"In: {b['Booking Date']}")
                if b.get("Release Date", "").strip():
                    parts.append(f"Out: {b['Release Date']}")
                if b.get("Total Bond"):
                    parts.append(f"Bond: {b['Total Bond']}")
                if parts:
                    print(f"         {'  |  '.join(parts)}")

    print("─" * 105)
    print(f"Total    : {len(real)}")
    print(f"Retrieved: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")


# ─────────────────────────────────────────────────────────────────────────────
#  CSV Export
# ─────────────────────────────────────────────────────────────────────────────

def export_csv(inmates: list[dict], filepath: str):
    real = [i for i in inmates if "name" in i]
    if not real:
        print("  Nothing to export.")
        return

    with open(filepath, "w", newline="", encoding="utf-8") as f:
        fieldnames = ["#", "Name", "Age/DOB", "Facility", "Booking Number", "Booking Date", "Release Date", "Bond"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for idx, inmate in enumerate(real, 1):
            name     = inmate.get("name", "")
            age      = inmate.get("age", inmate.get("dob", ""))
            facility = inmate.get("facility", "")
            bnum     = inmate.get("booking_number", "")
            bookings = inmate.get("bookings", [])

            if bookings:
                for b in bookings:
                    writer.writerow({
                        "#": idx, "Name": name, "Age/DOB": age, "Facility": facility,
                        "Booking Number": b.get("Booking Number", bnum),
                        "Booking Date": b.get("Booking Date", ""),
                        "Release Date": b.get("Release Date", ""),
                        "Bond": b.get("Total Bond", ""),
                    })
            else:
                writer.writerow({
                    "#": idx, "Name": name, "Age/DOB": age, "Facility": facility,
                    "Booking Number": bnum,
                })

    print(f"\n  Exported {len(real)} inmates → {filepath}")


# ─────────────────────────────────────────────────────────────────────────────
#  CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="PA County Jail Inmate Lookup (York, Dauphin, Lancaster)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Facilities:
  york          York County Detention Center  (pretrial)
  york-prison   York County Prison            (sentenced)
  dauphin       Dauphin County Prison
  lancaster     Lancaster County Prison       (browser required)

Examples:
  python pa_jail_lookup.py --facility york
  python pa_jail_lookup.py --facility york --bookings
  python pa_jail_lookup.py --facility dauphin --export dauphin.csv
  python pa_jail_lookup.py --facility york --export york.csv
        """
    )
    parser.add_argument("--facility", "-f", required=True,
                        choices=list(FACILITIES.keys()),
                        help="Which facility to query")
    parser.add_argument("--bookings", "-b", action="store_true",
                        help="Show booking details (York only)")
    parser.add_argument("--export", "-e", metavar="FILE.csv",
                        help="Save results to a CSV file")

    args = parser.parse_args()

    inmates = fetch_roster(args.facility)
    display_roster(inmates, show_bookings=args.bookings)

    if args.export and inmates:
        export_csv(inmates, args.export)


if __name__ == "__main__":
    main()
