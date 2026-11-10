"""Dauphin IML collector: two-letter last-name searches, current custody only."""
import argparse
import itertools
import json
import re
import string
import sys
import time

import requests
from bs4 import BeautifulSoup

URL = "https://www.dauphinc.org:9443/IML"
FACILITY = "Dauphin County Prison"
PREFIXES = tuple("".join(pair) for pair in itertools.product(string.ascii_uppercase, repeat=2))
HEADERS = ("Inmate Name (last, first middle)", "Booking Number", "Permanent ID",
           "Date of Birth", "Release Date")


def text(value):
    return re.sub(r"\s+", " ", value or "").strip()


class CollectionError(RuntimeError):
    def __init__(self, message, retry_after=None):
        super().__init__(message)
        self.retry_after = retry_after


def parse_page(html):
    """Validate the table contract before interpreting an empty result."""
    soup = BeautifulSoup(html, "html.parser")
    tables = [t for t in soup.find_all("table")
              if tuple(text(h.get_text()) for h in t.find_all("th")) == HEADERS]
    if not tables:
        raise CollectionError("Dauphin returned an unrecognized results page; collection stopped.")
    # The smallest matching table is the actual results table, not a layout ancestor.
    table = min(tables, key=lambda t: len(str(t)))
    body = text(soup.get_text(" "))
    match = re.search(r"Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+([\d,]+)\s+results", body, re.I)
    if not match and "No records found." not in body:
        raise CollectionError("Dauphin result count is missing; collection stopped.")
    start, end, total = (int(v.replace(",", "")) for v in match.groups()) if match else (0, 0, 0)
    rows = []
    # IML's invalid nested tables are repaired differently by browsers.
    # Explicit rowN rows are records; surrounding layout rows are not.
    for row in table.find_all("tr", id=re.compile(r"^row\d+$")):
        cells = row.find_all("td", recursive=False)
        if not cells:
            continue
        values = [text(c.get_text(" ")) for c in cells]
        if len(values) != 5 or "," not in values[0] or not re.fullmatch(r"[A-Z]{2}\d{2}-\d+", values[1]):
            raise CollectionError("Dauphin returned an unexpected inmate row; collection stopped.")
        rows.append(dict(zip(("name", "booking_number", "permanent_id", "dob", "release_date"), values)))
    if (total and (start < 1 or end < start or end > total or len(rows) != end - start + 1)) or (not total and rows):
        raise CollectionError("Dauphin page count does not match its rows; collection stopped.")
    return rows, start, end, total


def collect(prefixes=PREFIXES, *, session=None, delay=1.0, progress=None, sleep=time.sleep):
    prefixes = tuple(prefixes)
    if not prefixes or any(p not in PREFIXES for p in prefixes):
        raise ValueError("Use two-letter last-name pairs AA through ZZ.")
    session = session or requests.Session()
    records = {}
    excluded = set()
    released = 0
    request_count = 0

    def request(method, **kwargs):
        nonlocal request_count
        if request_count:
            sleep(max(1.0, delay))
        request_count += 1
        try:
            response = session.request(method, URL, timeout=(10, 35), **kwargs)
        except requests.RequestException as exc:
            raise CollectionError("Cannot connect to Dauphin; collection stopped. No automatic retry.") from exc
        if response.status_code != 200:
            raise CollectionError(
                f"Dauphin returned HTTP {response.status_code}; collection stopped. No automatic retry.",
                response.headers.get("Retry-After"),
            )
        return response.text

    # Establish an independent session so pagination cannot inherit another search.
    form = BeautifulSoup(request("GET"), "html.parser")
    if not form.find("input", attrs={"name": "systemUser_lastName"}):
        raise CollectionError("Dauphin search form is unavailable; collection stopped.")
    for index, prefix in enumerate(prefixes):
        payload = {
            "flow_action": "searchbyname", "quantity": "30", "searchtype": "CID",
            "systemUser_identifiervalue": "",
            "systemUser_includereleasedinmate": "N",
            "systemUser_includereleasedinmate2": "N",
            "systemUser_firstName": "", "systemUser_lastName": prefix,
            "systemUser_dateOfBirth": "", "identifierbox": "CID", "identifier": "",
        }
        html = request("POST", data=payload)
        seen = set()
        expected_start = 1
        expected_total = None
        while True:
            rows, start, end, total = parse_page(html)
            if expected_total is None:
                expected_total = total
            if total != expected_total or (total and start != expected_start):
                raise CollectionError("Dauphin pagination changed during collection; no partial roster saved.")
            for row in rows:
                key = row["booking_number"]
                if key in seen:
                    raise CollectionError("Dauphin repeated a result page; no partial roster saved.")
                seen.add(key)
                if row["release_date"]:
                    released += 1
                    excluded.add(key)
                    # A later released result must also remove an earlier active result.
                    records.pop(key, None)
                    continue
                if key not in excluded:
                    records[key] = {**row, "gender": "", "facility": FACILITY, "bookings": []}
            if end >= total:
                if len(seen) != total:
                    raise CollectionError("Dauphin search was incomplete; no partial roster saved.")
                break
            expected_start = end + 1
            html = request("POST", data={"flow_action": "next", "currentStart": str(expected_start),
                                        "quantity": "30"})
        if progress:
            progress({"completed": index + 1, "total": len(prefixes), "prefix": prefix,
                      "found": len(records), "releasedExcluded": released, "requests": request_count})
    return sorted(records.values(), key=lambda row: (row["name"], row["booking_number"]))


def emit(event):
    print(json.dumps(event), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefixes", nargs="+", help="Limited validation only; omitted means AA-ZZ.")
    args = parser.parse_args()
    try:
        result = collect(args.prefixes or PREFIXES,
                         progress=lambda p: emit({"type": "progress", **p}))
        emit({"type": "complete", "records": result})
    except Exception as exc:
        emit({"type": "error", "message": str(exc) if isinstance(exc, (CollectionError, ValueError))
              else "Dauphin collector failed; no partial roster saved.",
              "retryAfter": getattr(exc, "retry_after", None)})
        sys.exit(1)
