# Architecture

How the tabulation system is put together, for whoever maintains or extends it. For running an event, see [README.md](README.md).

## The shape of it

```
 Tabulation computer                                  Judge devices (browser)
┌────────────────────────────────────────────┐       ┌──────────────────────┐
│ Electron main process  (src/main/main.js)  │       │ /judge/  scoresheet  │
│  ├─ SQLite file        (node:sqlite)       │  LAN  │                      │
│  └─ Express + ws       (src/server)        │◄─────►│ HTTP  : read + write │
│       listening on 0.0.0.0:3000            │       │ WS    : change pings │
│                                            │       └──────────────────────┘
│ Electron window ── loads ──► /admin/       │
│  (same server, over 127.0.0.1)             │
└────────────────────────────────────────────┘
```

There is one server process and it is the only thing that touches the database. Both user interfaces are plain web pages served by it:

- The **admin console** is shown in the Electron window, which simply loads `http://127.0.0.1:<port>/admin/`. It has no special access to the database; it uses the same HTTP API a browser would.
- The **judge scoresheet** is loaded by judge devices from `http://<LAN-IP>:<port>/`.

Because the server does not depend on Electron, `npm run server` runs it under plain Node, and the tests start it against an in-memory database.

### Why these choices

| Choice | Reason |
| --- | --- |
| `node:sqlite` instead of `better-sqlite3` | It is built into Node 22.5+ and into the Node that ships inside Electron 44, so there is no native module to compile or rebuild for Electron. It is synchronous, which makes every request atomic without locking code. Node prints an "experimental feature" warning for it on startup; that is expected. |
| Vanilla ES modules, no bundler | The pages are small. No build step means nothing to break on the day of the event, and what is on disk is exactly what the browser runs. |
| REST for writes, WebSocket only for notifications | A score save needs a definite success or failure the judge's screen can show; HTTP gives that for free. The socket only says "something changed", so a dropped socket can never lose a score. |
| Judges use a browser, not an installed client | Works on any tablet, phone or laptop that can join the Wi-Fi. |

## Project structure

```
perangat-tabulation/
├─ package.json
├─ README.md
├─ ARCHITECTURE.md
├─ DEPLOYMENT.md            Installing, network, firewall, backup and restore
├─ CHANGELOG.md
├─ docs/
│  ├─ TABULATOR_GUIDE.md    Event-day runbook for the tabulator
│  └─ JUDGE_GUIDE.md        One-page handout for judges
├─ scripts/
│  ├─ start.js              Launches Electron (clears ELECTRON_RUN_AS_NODE first)
│  ├─ server.js             Runs the server without Electron
│  └─ benchmark.js          Load test (npm run bench)
├─ src/
│  ├─ main/
│  │  ├─ main.js            Electron main: starts the server, opens the window, PDF export
│  │  └─ preload.js         Exposes window.desktop.savePdf() to pages
│  ├─ server/
│  │  ├─ index.js           startServer(): Express app, static files, error handling, listen
│  │  ├─ db.js              SQLite wrapper (cached statements, transactions)
│  │  ├─ schema.sql         CREATE TABLE statements
│  │  ├─ seed.js            Perangat 2026 categories, criteria and deduction rules
│  │  ├─ scoring.js         Pure tabulation maths (totals, deductions, ranking)
│  │  ├─ results.js         Loads rows from SQLite and feeds them to scoring.js
│  │  ├─ realtime.js        WebSocket hub (auth, broadcast, presence, heartbeat)
│  │  ├─ devices.js         Which device a request comes from (MAC lookup), one device per judge, the device lock
│  │  ├─ scan.js            Reads a photo of a paper scoresheet with Claude, and checks the reading
│  │  ├─ validate.js        Request-body validation helpers
│  │  ├─ errors.js          HttpError
│  │  └─ routes/
│  │     ├─ public.js       /api/public  — sign-in screen data
│  │     ├─ judge.js        /api/judge   — login, own scoresheets, save score, submit
│  │     ├─ encode.js       /api/encode  — encoder pairing, enter and edit the assigned judges' sheets, scan a photo
│  │     └─ admin.js        /api/admin   — setup CRUD, results, deductions, maintenance
│  └─ public/
│     ├─ shared/            base.css, dom.js (h()), api.js, live.js, ui.js (dialogs, toasts), ties.js (tie wording)
│     │  └─ logos/          The five official logos, trimmed and resized for screen and print
│     ├─ judge/             index.html, judge.js, judge.css
│     ├─ encode/            index.html, encode.js, encode.css: the tabulating team's encoder screen
│     └─ admin/             index.html, admin.js, admin.css, print.html, print.js, print.css
└─ test/
   ├─ scoring.test.js       Rules: ranking, deductions, averaging
   ├─ api.test.js           End-to-end over HTTP and WebSocket, in-memory database
   ├─ security.test.js      Attacks that must keep failing: forged hosts, foreign origins, bad input
   ├─ devices.test.js       One device per judge, the device lock, reading MAC addresses
   └─ encode.test.js        Encoder pairing, entering and editing sheets, checking a photo reading
```

## Data model

The full `CREATE TABLE` statements are in [src/server/schema.sql](src/server/schema.sql). The file is idempotent and runs on every start.

```
categories ──< criteria                        deduction_types
    │              │                                 │
    │              └──────────< scores >──┐          │
    ├──< category_judges >── judges ──────┤     deductions >── contestants
    ├──< category_contestants >── contestants ───────┘
    └──< scoresheets >── judges
```

| Table | One row is | Notes |
| --- | --- | --- |
| `categories` | A judged award (Dance Showdown, Best Music, Festival Queen) | `apply_deductions`, `ranking_method` (`average` or `rank_sum`), `placement_titles` (JSON array: rank 1 first) |
| `criteria` | One line of a criteria table | `weight` is both the percentage and the maximum points a judge can give |
| `judges` | A judge | `judge_no`, `access_code`, `device_mac` (the one device this judge may use while the device lock is on; null = none registered) |
| `contestants` | A contingent | `contestant_no` is the order of performance |
| `category_judges`, `category_contestants` | Who scores / competes in which category | New judges and contingents are enrolled in every category by default |
| `scores` | One cell of a scoresheet | Unique on `(judge_id, contestant_id, criterion_id)`; saved with an upsert. `entered_by` is the encoder who typed it, or null when the judge did |
| `tie_votes` | The judges' vote on a tie the tie-break could not separate | `contestant_ids` (the tied set, ascending) and `placing` (their order), both JSON; `note` such as the vote count. Unique per category and tied set; cleared by *Clear all scores* |
| `encoder_judges` | A judge an encoder device may enter sheets for | Set when the tabulator approves the device, changed with `PUT /api/admin/encoders/:id/judges`. A device with none cannot open any sheet |
| `encoder_sessions` | A tabulating-team device | `status` is `pending` until the tabulator approves it, then `paired`. `pairing_code` is the four digits the device shows; `token` authenticates it |
| `scoresheets` | A judge's submission lock for one category | `draft` or `submitted` |
| `deduction_types` | A rule from the deductions table | `points`, `unit`: `flat`, `per_minute`, `per_started_minute`. `limit_seconds` for timed rules |
| `deductions` | A penalty charged to a contingent | `points` is a snapshot of rule points × quantity |
| `judge_sessions` | A signed-in judge device | Unique on `judge_id`: one device per judge. `ip` and `mac` are the device it was opened on. Kept in the database so judges stay signed in across a server restart |
| `settings` | Key/value event details | Also `device_lock` (`1` = on) and `chairman_judge_id` (the judge who chairs the board, set with `PUT /api/admin/signatories`; cleared when that judge is deleted) |

How the official document maps onto it: each criteria table is a `categories` row with one `criteria` row per line; each line of the deductions table is a `deduction_types` row. The seed for this is `src/server/seed.js`, and a test asserts that every seeded category totals 100.

## Scoring rules

All of the maths lives in `src/server/scoring.js`, which has no I/O.

Per judge, per contingent (`raw`, `deduction` and `net` in the code):

```
raw score    = Σ criterion scores                               (final only once all criteria are filled)
final score  = max(0, raw score − Σ deductions for the contingent)
```

Every deduction comes off each judge's raw score. There is no deduction from an average or from a rank total.

`ranking_method = rank_sum` is the Perangat rule and the default:

```
judge rank   = that judge's final scores, descending, fractional ranking (1, 2.5, 2.5, 4)
rank total   = Σ judge ranks                                    (only once every judge is complete)
rank         = rank total ascending; ties go to the higher average final score;
               still level = the judges' recorded vote, else a shared placing (1, 2, 2, 4) until they vote
```

`ranking_method = average` is the alternative:

```
rank         = average of the judges' final scores, descending; equal averages = the judges' recorded vote
```

A vote is a `tie_votes` row: the set of tied contingents and the order the judges chose. `computeCategoryResults()` applies it only while exactly that set is still level after the numeric tie-break, so a vote taken before a score changed cannot silently decide a different tie; the result lists `votes` that applied and `pendingVotes` still needed. `POST /api/admin/tie-votes` accepts a vote only for a level in `pendingVotes`.

- Timed deductions are computed from the measured time by `computeDeductionCharge()`: `flat` charges once for any excess, `per_minute` charges per full minute over the limit, `per_started_minute` per started minute.
- Averages are kept to six decimals before ranking so that two different averages are never rounded into a false tie. They are displayed to three.
- Each category result carries `ties`: every group of contingents level on the rank total (or, with `average`, on the average score), in placing order, whether or not the tie-break separated them. `shared/ties.js` turns these into the explanation and the tie-break guidelines shown on the Results screen and the printed sheets.
- A category is **final** when every assigned judge has submitted; until then results are labelled provisional.

Nothing computed is stored. Results are derived from `scores` and `deductions` every time they are requested, so there is no cached total that can go stale.

## Network communication

### HTTP API

| Area | Endpoints | Who may call |
| --- | --- | --- |
| `/api/public` | `GET /info` | Anyone on the LAN; with the device lock on, registered devices only |
| `/api/judge` | `POST /login`, `POST /logout`, `GET /sheets`, `PUT /scores`, `POST /categories/:id/submit` | A judge with a session token (`Authorization: Bearer …`); with the device lock on, from a registered device |
| `/api/encode` | `POST /pair`, `GET /status`, `POST /unpair`; once approved: `GET /setup`, `GET`/`PUT /sheet`, `POST /sheet/submit`, `POST /scan` | `/pair` needs the encoder access code; everything else an encoder token (`Authorization: Bearer …`), and all but `/status` and `/unpair` an approved one |
| `/api/admin` | `GET /state`, `GET /results`, CRUD for judges, contestants, categories, criteria, deduction-types, deductions; `PUT /settings`, `/device-lock`, `/signatories`, `/scan-key`; `POST /judges/:id/disconnect`, `/encoders/:id/approve`, `/encoder-code`, `/scoresheets/reopen`, `/backup`, `/reset-scores`; `DELETE /encoders/:id` | Requests from the tabulation computer only |

Errors are always `{ "error": "message a person can read" }` with a matching status code.

### Submitting a score

The judge's browser sends one cell at a time:

```http
PUT /api/judge/scores
Authorization: Bearer <session token>
Content-Type: application/json

{ "contestantId": 4, "criterionId": 1, "score": 32.5 }
```

The handler (`src/server/routes/judge.js`) then:

1. Resolves the token to a judge.
2. Checks the judge is assigned to the criterion's category and the contingent competes in it.
3. Refuses with `409` if the judge has already submitted that category.
4. Validates `0 ≤ score ≤ criterion.weight` with at most two decimals. A `null` score clears the cell.
5. Upserts the row in `scores`.
6. Broadcasts `{ type: "scores", categoryId, judgeId, contestantId }` to admin sockets.
7. Responds with that judge's recomputed sheet for the category (totals and their own ranking).

### WebSocket events

One socket endpoint, `/ws`. Judges connect with `?token=<session token>`, the admin console with `?role=admin` (accepted from the tabulation computer only). Messages only flow from server to client:

| Event | Sent to | Meaning |
| --- | --- | --- |
| `hello` | The connecting client | Connection accepted |
| `scores` | Admin | A judge saved a score |
| `sheets` | Everyone | A scoresheet was submitted or reopened (`judgeId`, `categoryId`) |
| `deductions` | Everyone | A deduction was added or removed |
| `config` | Everyone | Setup changed (judges, contingents, categories, criteria, settings, reset) |
| `presence` | Admin | The list of connected judges changed |
| `sessions` | Admin | A judge signed in or out, was disconnected, or a device was turned away by the device lock |
| `encoders` | Admin | An encoder device asked to pair, was approved, or was unpaired |
| `signed_out` | One judge's device | Its session was ended (`message` says why); the socket is then closed |

Events carry no data worth trusting. A client that receives one re-fetches over HTTP.

## State management

**The server is the only source of truth.** Clients hold a copy for display and re-fetch it when told to.

### Admin console (`admin.js`)

A single `store` object holds the last `GET /state` (setup) and `GET /results` (computed tabulation). Every view is a function that builds DOM from the store.

- After the tabulator does something, the page calls the API, re-fetches both, and re-renders.
- On a live event, the page re-fetches (debounced 150 ms) and re-renders. Views that contain inline form fields (Deductions, Settings) are not re-rendered by live events, so typing is never interrupted.
- When the socket reconnects, it re-fetches once to catch up.

### Judge scoresheet (`judge.js`)

Three structures describe every cell, keyed `contestantId:criterionId`:

| | Holds |
| --- | --- |
| `saved` | What the server has confirmed |
| `pending` | What the judge typed that the server has not confirmed yet |
| `invalid` | Cells whose text is not a usable score |

The value a cell counts as is `pending`, falling back to `saved`. Row totals are computed in the browser from those, so they update on every keystroke; ranks come from the server and are shown only when the row has nothing pending.

A single save loop (`pump()`) sends pending cells one at a time, oldest first:

- Success → the cell leaves `pending`, unless the judge has typed something newer in the meantime.
- Network failure or a 5xx → the cell stays in `pending`, the status pill turns red, and the loop retries every 3 seconds. Nothing is lost while the Wi-Fi is down.
- A 4xx (for example the sheet was just locked) → the value is dropped, the judge sees why, and the sheet is reloaded from the server.

*Submit final scores* is disabled while anything is pending or invalid.

When the tabulator changes the setup mid-event, the page compares a signature of the sheet layout. If only scores changed it updates numbers in place; if the layout changed it rebuilds the table and restores the judge's cursor and unsaved typing.

## Look and print layout

The colours in `shared/base.css` are taken from the 97th Provincial Anniversary logo: orange and gold from its "9", sky and deep blue from its "7". `--festive` is the logo's wordmark gradient, used as a thin strip at the top of each screen. The logo is orange and blue, so wherever it appears on a blue surface it sits on a white tile.

`admin/print.js` builds every printed sheet from the same `GET /state` and `GET /results` the console uses. `view=results`, `judge` and `codes` print what has been entered; `view=blank` prints the judge scoresheets and the tabulation sheet of a category with only the contingents filled in, by passing `{ blank: true }` to the same page builders. Every sheet starts with `header()`, which puts the government marks on the left and the event marks on the right. Sheets are sized to fit one A4 landscape page with up to about ten contingents; `logos/` holds the images at print resolution for that header (18–22 mm tall).

## Security model

This is a trusted-LAN tool, not an internet service.

- **Judges** authenticate with an access code and receive a random 256-bit session token. Generated codes are six digits and failed sign-ins are limited to 10 per device per 5 minutes, which together make guessing a code during an event impractical. A judge can only read and write their own scores: the judge is always taken from the session, and `results.js` filters by judge before anything is computed for them.
- **One device per judge.** `judge_sessions` holds at most one row per judge. A sign-in from a different device is refused with `409` while that row exists; the same device (same MAC, or same address when the MAC is unknown) replaces its own session. The tabulator ends a session with `POST /api/admin/judges/:id/disconnect`, which deletes the row, sends `signed_out` to the device and closes its socket.
- **Device lock** (`devices.js`, off by default). A browser never sends its MAC address, so `createDeviceLookup()` reads this computer's neighbour table (`arp -a` on Windows) and maps the request's address to a MAC, re-reading it at most every few seconds. With the lock on, `guard.gate` refuses `/judge`, `/api/public` and `/api/judge` to any device whose MAC is not some judge's `device_mac`, sign-in is refused unless the device is that judge's own, and `guard.enforce()` ends sessions that no longer qualify whenever the lock or a registration changes. A device whose MAC cannot be read (it is behind a router) is refused, not let through. The tabulation computer's own browser is refused too: with the lock on it cannot sign in as a judge, and paper sheets go through the encoder screen instead. Only the admin console stays open there. A MAC address can be spoofed, so the lock is a barrier on top of access codes, not a replacement for them.
- **Encoders** pair in two steps: `POST /api/encode/pair` with the team access code (wrong codes are rate-limited like judge sign-in) creates a `pending` row and returns a token and a four-digit pairing code; the token does nothing but `GET /status` until the tabulator, after checking the pairing code, approves it on the tabulation computer. Pending requests expire after an hour and are capped at 20. An encoder can enter and change only the draft sheets of the judges assigned to it in `encoder_judges` (any other judge answers `409`, since the screen reads `403` as "waiting for approval"), never a submitted one. Each score it saves records `entered_by`.
- **Photo reading** (`scan.js`) sends the photo to Claude (`claude-opus-5-5`, structured JSON output, `fallbacks: "default"`) through the official SDK, with the expected rows and columns. The reading is never saved directly: `interpretScan()` matches rows by contingent number, drops values above a criterion's maximum or below zero, flags cells Claude marked unclear and rows whose scores do not add up to the written total, and the encoder confirms every value before `PUT /sheet`. The API key is stored in `settings.anthropic_api_key` and left out of every response; `ANTHROPIC_API_KEY` is the fallback. Only `/api/encode/scan` accepts a body over 100 KB (10 MB, for the photo).
- **Admin** has no password. `adminAccessProblem()` in `index.js` guards `/admin`, `/api/admin` and the admin WebSocket with three checks:
  - the connection comes from the tabulation computer (loopback);
  - the `Host` header names that computer (`127.0.0.1` or `localhost`), which defeats DNS rebinding, where a hostile site points its own domain at 127.0.0.1;
  - any `Origin` header matches the admin console itself, so a site open in a browser on that computer cannot call the admin API or open the admin socket. WebSockets are not covered by the browser's same-origin rule, so this check is the only thing stopping that.
- Access codes are stored in plain text because the tabulator must be able to read them back and print them.
- Traffic is plain HTTP. Use a network you control (a dedicated router is ideal) and do not expose the port to the internet.
- Pages are sent with a Content-Security-Policy that only allows resources from the server itself, and all text is inserted as text nodes, never as HTML. API responses are sent `no-store`.
- All SQL uses bound parameters. Request bodies are limited to 100 KB and WebSocket frames to 1 KB.
- The Electron windows run sandboxed with context isolation, cannot navigate or open windows outside the app's own pages, and are refused every permission request.

`test/security.test.js` attacks each of these and must keep passing. `test/devices.test.js` does the same for the device rules; it passes `startServer()` an `identify` function so one process can play several devices.

## Performance

Measured with `npm run bench` on the development laptop (the server and the simulated judges share one process, so real figures are a little better):

| | 7 judges × 20 contingents | 15 judges × 60 contingents |
| --- | --- | --- |
| Scores saved per second, all judges saving non-stop | about 300 | about 270 |
| Judge loads all three scoresheets | 1 ms | 3 ms |
| Admin results with every sheet full | 3 ms | 18 ms |
| Database file | 236 KB | 924 KB |

A real panel saves a handful of scores per second, so there is a large margin.

- **Each save costs about 3 ms, nearly all of it the disk flush.** The database runs with `synchronous = FULL`, so a score is on disk before the judge's screen says it is saved. `NORMAL` would cut the write from 3 ms to under 0.1 ms but could lose the last few scores in a power cut; durability matters more here.
- **A judge's sheet is recomputed on every save**, so that path reads only that judge's rows.
- **The admin console re-reads results at most once every 150 ms** however many scores arrive, and re-reads the setup only when the setup changed.
- **The judge page's code is about 39 KB** uncompressed across eight files, plus the anniversary logo (137 KB on the sign-in screen, 40 KB in the top bar), all cached by the browser and revalidated by ETag.

## Extending it

- **A new category or changed criteria** — do it in the admin console; no code needed.
- **A new kind of deduction rule** — add a `unit` to the `CHECK` in `schema.sql`, handle it in `computeDeductionCharge()`, and add the label in `admin.js`.
- **A different way of ranking** — add a `ranking_method` value and a comparator in `computeCategoryResults()`. Add a test in `test/scoring.test.js` first.
- **Schema or default changes** — `schema.sql` only creates tables that do not exist, and the seed runs once. To change an existing database, append a function to `MIGRATIONS` in `db.js`; each runs once, tracked by `PRAGMA user_version`.
- **A new print view** — add a page builder in `print.js` and a `view=` value.

Run `npm test` after any change to `src/server`.
