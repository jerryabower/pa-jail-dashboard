# Dauphin County Prison

Dauphin appears immediately after Lancaster in PA Counties and uses the same roster table, filtering, sorting, CSV export, and snapshot/delta controls. Its collector searches the official IML form at https://www.dauphinc.org:9443/IML using last-name pairs AA through ZZ, with first name and date of birth blank.

## Operation

- Select Dauphin to start the first collection. Refresh starts another collection after one has completed.
- No startup job, schedule, or automatic failure retry was added.
- All 676 searches must finish before replacing the saved roster. Progress polls every 15 seconds.
- Requests are sequential with at least one second between requests. HTTP errors stop the job; manual retry has a five-minute minimum cooldown and honors a longer Retry-After.
- Both include-released fields are explicitly N. Any nonblank release date excludes that booking, including inconsistent duplicate results.
- Pagination validates advertised ranges, total counts and row counts. Duplicate bookings are removed across searches; repeated pages and malformed results fail closed.
- The prior completed roster remains visible with its timestamp if a refresh fails.
- Completed results persist to `/data/dauphin-roster.json` when the Railway volume is present. No existing snapshots or database schemas are changed.
- Save Snapshot requires a completed, successful collection. Unverified snapshot-push uploads for Dauphin are rejected.
- GET `/api/roster/dauphin?status=1` is read-only and does not initiate collection.
- Coverage is the requested A-Z two-letter search space, not a guarantee about names outside that space or changes in custody while the sweep runs.

## Validation on November 10, 2026

- Limited source test: SM returned 8, MA returned 19, ZZ returned 0; 27 unique records and no nonblank release dates. No full sweep was run.
- Ten Python tests passed for pair generation, current-only payloads, filtering, pagination, deduplication, empty results, malformed rows, repeated pages, and HTTP 429 without retries.
- Node manager test passed for read-only status, single-flight behavior, completed persistence, failed-refresh retention, snapshot safeguards, and longer Retry-After.
- Browser QA used synthetic records and mocked APIs: existing top tabs/GettingOut navigation, Dauphin loading/error/empty/completed states, search, sorting, CSV contents, Refresh, and Weekly Delta navigation.
- Desktop and 375px layouts checked; no browser JavaScript errors. Production build passed.
- `npm run check` has three pre-existing errors, confirmed against the unchanged baseline in an isolated worktree: unused attribution default import and two Map iteration target errors. This change does not introduce additional type-check errors.
- Real full-sweep duration, rate-limit behavior across all 676 pairs, and complete Railway-source collection remain unverified until the operator initiates a run.
