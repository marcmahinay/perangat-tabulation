# Changelog

All notable changes to this project are recorded here. Versions follow [Semantic Versioning](https://semver.org/): the version is the `version` field in `package.json` and appears in the installer's file name.

## 1.0.0 — 2026-10-14

First version, built for the Perangat Festival 2026.

### Added

- Electron desktop app that runs the tabulation server (Express, WebSockets, SQLite) on one computer and serves a scoresheet to judges' browsers over the LAN.
- Categories, criteria and deduction rules from the *Perangat Festival 2026 Official Judging Criteria & Deductions*: Dance Showdown, Best Music and Festival Queen, with four deduction rules.
- Judge scoresheet: per-criterion scoring up to each criterion's weight, automatic saving with retry while offline, live totals and ranks, and a submit step that locks the sheet.
- Admin console: live monitor of scores and judge connections, results, deductions with time-based calculation, and setup of contingents, judges, categories, criteria and deduction rules.
- Ranking by the sum of the judges' ranks, lowest total first, with average score as the tie-break. Equal totals on a judge's sheet get a fractional rank (1, 2.5, 2.5, 4). Ranking by average score is available per category.
- Contingents with the same rank total and the same average score are placed by the judges' majority vote (the chairman decides a level vote), recorded on the Results screen. Until then the category is flagged *TIE · JUDGES TO VOTE* and a final results sheet is stamped *NOT FINAL*.
- Ties are explained: the Results screen and the printed results name the tied contingents, the figure they are tied on and how the tie was settled, mark each tied row, and list the tie-break guidelines. Printed judge scoresheets list any equal scores and the rank they share.
- Every deduction, time or safety, is taken from each judge's raw score for the contingent before the judges are ranked.
- Printable results and per-judge scoresheets, with direct PDF export, and printable judge access slips.
- Blank sheets for scoring by hand and encoding afterwards: an empty scoresheet per judge to sign, and an empty tabulation sheet per category.
- The official logos on every printed sheet (Province of Misamis Occidental seal, Bagong Pilipinas, Asenso Misamis Occidental, 97th Provincial Anniversary, Përangat Festival), and a colour theme taken from the 97th Provincial Anniversary logo, which appears in the admin console and on the judge screens.
- A chairman of the board of judges, chosen under **Judges → Signatories** together with the tabulator's name. The overall results are signed by the tabulator (*Tabulated by*) and by the board of judges (*Certified correct*), with the chairman last; the chairman's own scoresheets say *Chairman, Board of Judges*.
- Encoder screen for the tabulating team (`/encode/`): enter and edit judges' paper scoresheets from a phone or laptop. Each encoder device is assigned the judges whose sheets it may enter, and can open no other; a device with no judges assigned cannot encode. Devices pair with an encoder access code and work only after the tabulator approves their pairing code under **Encoding**. A sheet can be photographed: Claude reads the handwritten scores into the grid, flagging unclear or impossible values and totals that do not add up, and the encoder checks and corrects them before saving. Saved scores record who encoded them.
- A new judge is numbered automatically with the lowest number not in use.
- Database backup to a timestamped file, and a "clear all scores" reset for use after rehearsals.
- Windows installer via `npm run dist`.
- Load test via `npm run bench`.
- Documentation: README, ARCHITECTURE, DEPLOYMENT, Tabulator's Guide and Judge's Guide.

### Security

- A judge is signed in on one device at a time. A second device is refused, even with the right access code, until the first signs out or the tabulator presses **Disconnect**. The Judges page shows the device signed in as each judge: connected or not, MAC address, network address and since when.
- Device lock: each judge can be registered to one device by MAC address. With the lock on, a device that is not registered cannot open the judge scoresheet, and a registered device can sign in only as its own judge. Devices that are turned away are listed so they can be registered. The lock applies to the tabulation computer's own browser too, and it is on by default.
- The admin console, its API and its live socket answer only requests that come from the tabulation computer, are addressed to it by name (`127.0.0.1` or `localhost`), and were not sent by a page from another site. This closes DNS-rebinding and cross-site WebSocket access.
- Generated judge access codes are six digits, with sign-in limited to 10 wrong attempts per device every 5 minutes. A **New code** button replaces a judge's code and signs them out.
- Content-Security-Policy, `no-store` on API responses, a 100 KB request limit and a 1 KB WebSocket frame limit.
- Electron windows are sandboxed, confined to the app's own pages and refused all permission requests.
- Built on Electron 44, which fixes the published advisories affecting Electron 39.
- `test/security.test.js` covers forged hosts and origins, session handling, cross-judge access, invalid scores, hostile text, path traversal and access-code guessing.

### Performance

- The tabulation computer's network addresses are cached for ten seconds instead of being read on every request from a judge's device (about 7 ms each on Windows, blocking the server).
- The encoder screen releases each photo before taking the next, so a phone scanning many sheets does not run out of memory.
- Saving a score re-reads only that judge's rows, and the admin console re-reads the setup only when the setup changed.
- Every save is flushed to disk before it is acknowledged, so a power cut cannot lose a score the judge was told is saved.
