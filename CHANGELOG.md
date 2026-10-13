# Changelog

All notable changes to this project are recorded here. Versions follow [Semantic Versioning](https://semver.org/): the version is the `version` field in `package.json` and appears in the installer's file name.

## 1.0.0 — 2026-10-14

First version, built for the Perangat Festival 2026.

### Added

- Electron desktop app that runs the tabulation server (Express, WebSockets, SQLite) on one computer and serves a scoresheet to judges' browsers over the LAN.
- Categories, criteria and deduction rules from the *Perangat Festival 2026 Official Judging Criteria & Deductions*: Dance Showdown, Best Music and Festival Queen, with four deduction rules.
- Judge scoresheet: per-criterion scoring up to each criterion's weight, automatic saving with retry while offline, live totals and ranks, and a submit step that locks the sheet.
- Admin console: live monitor of scores and judge connections, results, deductions with time-based calculation, and setup of contingents, judges, categories, criteria and deduction rules.
- Ranking by the sum of the judges' ranks, lowest total first, with average score as the tie-break. Ranking by average score is available per category.
- Deductions taken off each judge's total before ranking, including the 5-point safety penalty.
- Printable results and per-judge scoresheets, with direct PDF export, and printable judge access slips.
- Database backup to a timestamped file, and a "clear all scores" reset for use after rehearsals.
- Windows installer via `npm run dist`.
- Load test via `npm run bench`.
- Documentation: README, ARCHITECTURE, DEPLOYMENT, Tabulator's Guide and Judge's Guide.

### Security

- The admin console, its API and its live socket answer only requests that come from the tabulation computer, are addressed to it by name (`127.0.0.1` or `localhost`), and were not sent by a page from another site. This closes DNS-rebinding and cross-site WebSocket access.
- Generated judge access codes are six digits, with sign-in limited to 10 wrong attempts per device every 5 minutes. A **New code** button replaces a judge's code and signs them out.
- Content-Security-Policy, `no-store` on API responses, a 100 KB request limit and a 1 KB WebSocket frame limit.
- Electron windows are sandboxed, confined to the app's own pages and refused all permission requests.
- Built on Electron 44, which fixes the published advisories affecting Electron 39.
- `test/security.test.js` covers forged hosts and origins, session handling, cross-judge access, invalid scores, hostile text, path traversal and access-code guessing.

### Performance

- Saving a score re-reads only that judge's rows, and the admin console re-reads the setup only when the setup changed.
- Every save is flushed to disk before it is acknowledged, so a power cut cannot lose a score the judge was told is saved.
