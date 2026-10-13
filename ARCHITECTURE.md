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
| `node:sqlite` instead of `better-sqlite3` | It is built into Node 22.5+ and into the Node that ships inside Electron 39, so there is no native module to compile or rebuild for Electron. It is synchronous, which makes every request atomic without locking code. Node prints an "experimental feature" warning for it on startup; that is expected. |
| Vanilla ES modules, no bundler | The pages are small. No build step means nothing to break on the day of the event, and what is on disk is exactly what the browser runs. |
| REST for writes, WebSocket only for notifications | A score save needs a definite success or failure the judge's screen can show; HTTP gives that for free. The socket only says "something changed", so a dropped socket can never lose a score. |
| Judges use a browser, not an installed client | Works on any tablet, phone or laptop that can join the Wi-Fi. |

## Project structure

```
perangat-tabulation/
├─ package.json
├─ README.md
├─ ARCHITECTURE.md
├─ scripts/
│  ├─ start.js              Launches Electron (clears ELECTRON_RUN_AS_NODE first)
│  ├─ server.js             Runs the server without Electron
│  └─ ensure-electron.js    postinstall: repairs a half-finished Electron install
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
│  │  ├─ validate.js        Request-body validation helpers
│  │  ├─ errors.js          HttpError
│  │  └─ routes/
│  │     ├─ public.js       /api/public  — sign-in screen data
│  │     ├─ judge.js        /api/judge   — login, own scoresheets, save score, submit
│  │     └─ admin.js        /api/admin   — setup CRUD, results, deductions, maintenance
│  └─ public/
│     ├─ shared/            base.css, dom.js (h()), api.js, live.js, ui.js (dialogs, toasts)
│     ├─ judge/             index.html, judge.js, judge.css
│     └─ admin/             index.html, admin.js, admin.css, print.html, print.js, print.css
└─ test/
   ├─ scoring.test.js       Rules: ranking, deductions, averaging
   └─ api.test.js           End-to-end over HTTP and WebSocket, in-memory database
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
| `judges` | A judge | `judge_no`, `access_code` |
| `contestants` | A contingent | `contestant_no` is the order of performance |
| `category_judges`, `category_contestants` | Who scores / competes in which category | New judges and contingents are enrolled in every category by default |
| `scores` | One cell of a scoresheet | Unique on `(judge_id, contestant_id, criterion_id)`; saved with an upsert |
| `scoresheets` | A judge's submission lock for one category | `draft` or `submitted` |
| `deduction_types` | A rule from the deductions table | `scope`: `per_judge` or `final`. `unit`: `flat`, `per_minute`, `per_started_minute`. `limit_seconds` for timed rules |
| `deductions` | A penalty charged to a contingent | `points` is a snapshot of rule points × quantity |
| `judge_sessions` | A signed-in judge device | Kept in the database so judges stay signed in across a server restart |
| `settings` | Key/value event details | |

How the official document maps onto it: each criteria table is a `categories` row with one `criteria` row per line; each line of the deductions table is a `deduction_types` row. The seed for this is `src/server/seed.js`, and a test asserts that every seeded category totals 100.

## Scoring rules

All of the maths lives in `src/server/scoring.js`, which has no I/O.

`ranking_method = rank_sum` is the Perangat rule and the default:

```
judge total  = Σ criterion scores − Σ deductions                (only once all criteria are filled)
judge rank   = that judge's totals, descending, competition ranking (1, 2, 2, 4)
rank total   = Σ judge ranks                                    (only once every judge is complete)
rank         = rank total ascending; ties go to the higher average judge total
```

`ranking_method = average` is the alternative:

```
judge total  = Σ criterion scores − Σ per_judge deductions
final score  = mean of the judge totals − Σ final deductions
rank         = final score descending
```

- Under `rank_sum`, a `final`-scope deduction is treated as `per_judge`. Taking it off afterwards would change nothing, because the ranks have already been decided; `computeCategoryResults()` rewrites the scope before it does any arithmetic.
- Timed deductions are computed from the measured time by `computeDeductionCharge()`: `flat` charges once for any excess, `per_minute` charges per full minute over the limit, `per_started_minute` per started minute.
- Averages are kept to six decimals before ranking so that two different averages are never rounded into a false tie. They are displayed to three.
- A category is **final** when every assigned judge has submitted; until then results are labelled provisional.

Nothing computed is stored. Results are derived from `scores` and `deductions` every time they are requested, so there is no cached total that can go stale.

## Network communication

### HTTP API

| Area | Endpoints | Who may call |
| --- | --- | --- |
| `/api/public` | `GET /info` | Anyone on the LAN |
| `/api/judge` | `POST /login`, `POST /logout`, `GET /sheets`, `PUT /scores`, `POST /categories/:id/submit` | A judge with a session token (`Authorization: Bearer …`) |
| `/api/admin` | `GET /state`, `GET /results`, CRUD for judges, contestants, categories, criteria, deduction-types, deductions; `PUT /settings`; `POST /scoresheets/reopen`, `/backup`, `/reset-scores` | Requests from the tabulation computer only |

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

## Security model

This is a trusted-LAN tool, not an internet service.

- **Judges** authenticate with a short access code and receive a random session token. Failed sign-ins are limited to 10 per device per 5 minutes. A judge can only read and write their own scores; `results.js` filters by judge before anything is computed for them.
- **Admin** has no password. `/admin` and `/api/admin` answer only loopback connections, so the admin console works only on the tabulation computer. A request with a foreign `Origin` header is rejected, which stops a web page open in a browser on that computer from calling the admin API.
- Access codes are stored in plain text because the tabulator must be able to read them back and print them.
- Traffic is plain HTTP. Use a network you control (a dedicated router is ideal) and do not expose the port to the internet.
- Pages are sent with a Content-Security-Policy that only allows resources from the server itself, and all text is inserted as text nodes, never as HTML.

## Extending it

- **A new category or changed criteria** — do it in the admin console; no code needed.
- **A new kind of deduction rule** — add a `unit` to the `CHECK` in `schema.sql`, handle it in `computeDeductionCharge()`, and add the label in `admin.js`.
- **A different way of ranking** — add a `ranking_method` value and a comparator in `computeCategoryResults()`. Add a test in `test/scoring.test.js` first.
- **Schema or default changes** — `schema.sql` only creates tables that do not exist, and the seed runs once. To change an existing database, append a function to `MIGRATIONS` in `db.js`; each runs once, tracked by `PRAGMA user_version`.
- **A new print view** — add a page builder in `print.js` and a `view=` value.

Run `npm test` after any change to `src/server`.
