import unittest
from dauphin_collector import collect, parse_page, CollectionError, HEADERS, PREFIXES


def page(rows, start=1, total=None):
    total = len(rows) if total is None else total
    label = f"Showing {start} to {start + len(rows) - 1} of {total} results" if total else "No records found."
    return label + "<table><tr>" + "".join(f"<th>{h}</th>" for h in HEADERS) + "</tr>" + "".join(
        f'<tr id="row{i+1}">' + "".join(f"<td>{v}</td>" for v in row) + "</tr>"
        for i, row in enumerate(rows)) + "</table>"


def row(n=1, released=""):
    return ["SAMPLE, TEST", f"DC26-{n:05d}", "123456", "01/01/1980", released]


class Response:
    def __init__(self, html, status=200, headers=None):
        self.text, self.status_code, self.headers = html, status, headers or {}


class Session:
    def __init__(self, *responses):
        self.responses = iter([Response('<input name="systemUser_lastName">'), *responses])
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, kwargs))
        return next(self.responses)


class DauphinTests(unittest.TestCase):
    def test_pairs(self):
        self.assertEqual((len(PREFIXES), len(set(PREFIXES)), PREFIXES[0], PREFIXES[-1]), (676, 676, "AA", "ZZ"))

    def test_released_excluded_and_payload(self):
        s = Session(Response(page([row(), row(2, "11/01/2026")])))
        got = collect(["SM"], session=s, sleep=lambda _: None)
        self.assertEqual([x["booking_number"] for x in got], ["DC26-00001"])
        payload = s.calls[1][1]["data"]
        self.assertEqual(payload["systemUser_includereleasedinmate"], "N")
        self.assertEqual(payload["systemUser_includereleasedinmate2"], "N")
        self.assertEqual(payload["systemUser_firstName"], "")
        self.assertEqual(payload["systemUser_dateOfBirth"], "")
        self.assertEqual(payload["systemUser_lastName"], "SM")

    def test_pagination_and_deduplication(self):
        s = Session(Response(page([row()], total=2)), Response(page([row(2)], start=2, total=2)),
                    Response(page([row(2)])))
        self.assertEqual(len(collect(["SM", "MA"], session=s, sleep=lambda _: None)), 2)
        self.assertEqual(s.calls[2][1]["data"]["currentStart"], "2")

    def test_released_never_readded(self):
        s = Session(Response(page([row()])), Response(page([row(released="11/01/2026")])),
                    Response(page([row()])))
        self.assertEqual(collect(["SM", "MA", "ZZ"], session=s, sleep=lambda _: None), [])

    def test_empty(self):
        self.assertEqual(parse_page(page([])), ([], 0, 0, 0))

    def test_missing_schema(self):
        with self.assertRaises(CollectionError):
            parse_page("No records found.")

    def test_missing_row(self):
        with self.assertRaises(CollectionError):
            parse_page(page([row()], total=2).replace('id="row1"', 'id="unknown"'))

    def test_repeated_page(self):
        s = Session(Response(page([row()], total=2)), Response(page([row()], total=2)))
        with self.assertRaises(CollectionError):
            collect(["SM"], session=s, sleep=lambda _: None)

    def test_429_no_retry(self):
        s = Session(Response("limited", 429, {"Retry-After": "3600"}))
        with self.assertRaises(CollectionError) as cm:
            collect(["SM", "MA"], session=s, sleep=lambda _: None)
        self.assertEqual(cm.exception.retry_after, "3600")
        self.assertEqual(len(s.calls), 2)

    def test_malformed_record(self):
        with self.assertRaises(CollectionError):
            parse_page(page([["SAMPLE, TEST", "bad", "", "", ""]]))


if __name__ == "__main__":
    unittest.main()
