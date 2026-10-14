# Perangat Tabulation

A dance contest tabulation system for the Perangat Festival that runs entirely on a local network. One computer runs the app; judges score from the browser on their own tablet, laptop or phone. No internet is needed, except to read photos of paper scoresheets (optional).

- **Tabulation computer** — an Electron desktop app. It holds the SQLite database, serves the judge pages, computes totals, deductions and rankings, and prints results.
- **Judge devices** — any modern browser on the same Wi-Fi or LAN. Nothing to install.

The database is pre-loaded with the *Perangat Festival 2026 Official Judging Criteria & Deductions*:

| Category | Criteria (weight = maximum points) |
| --- | --- |
| Dance Showdown | Performance and Choreography 35 · Creativity and Originality 25 · Costume / Props 20 · Music 20 |
| Best Music | Authenticity and Fidelity to Subanen Music 50 · Cultural Integrity and Appropriateness 20 · Musical Quality and Cohesion 15 · Integration with the Dance and Cultural Storytelling 10 · Overall Auditory Impact 5 |
| Festival Queen | Festival Costume and Cultural Representation 35 · Grace, Poise, and Stage Presence 25 · Overall Presentation and Visual Impact 20 · Projection and Audience Appeal 20 |

| Deduction | Penalty |
| --- | --- |
| Safety & Prohibited Acts Violation | 5 points |
| Exceeding Entrance Time (limit 4:00) | 1 point |
| Exceeding Exit Time (limit 2:00) | 1 point |
| Exceeding Actual Performance Time (limit 5:00) | 1 point per full minute over — 5:01–5:59 is free, 6:00 costs 1, 7:00 costs 2 |

Every deduction is taken from each judge's raw score for that contingent.

Categories, criteria, weights, deduction rules, judges and contingents can all be changed in the app.

## Documentation

| Document | For | Covers |
| --- | --- | --- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Whoever sets up the tabulation computer | Building the installer, installing, network and firewall, pre-event checks, backup and restore, updating |
| [docs/TABULATOR_GUIDE.md](docs/TABULATOR_GUIDE.md) | The tabulator on event day | Setup, monitoring, deductions, closing a category, what to do when something goes wrong |
| [docs/JUDGE_GUIDE.md](docs/JUDGE_GUIDE.md) | Judges | A one-page handout on signing in, scoring and submitting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Developers | How the server, database and pages fit together |
| [CHANGELOG.md](CHANGELOG.md) | Developers | What changed in each version |

## Requirements

- **Node.js 22.12 or newer** on the tabulation computer. The app uses Node's built-in SQLite, so there are no native modules to compile. Developed and tested with Node 26 and Electron 44.
- Windows 10/11. macOS and Linux have not been tested.
- A Wi-Fi router or switch that the tabulation computer and every judge device connect to. It does not need internet access.

## Install

```bash
npm install
```

## Start the app

```bash
npm start
```

The admin console opens. The first time, Windows Firewall asks whether to allow the app on the network — choose **Allow** for **Private networks**, otherwise judge devices cannot connect.

## Set up an event

In the admin console's sidebar:

1. **Settings** — enter the event name, venue, date and the tabulator's name (printed on the results).
2. **Judges** — three judges are created to start with. Rename them, add more, and note each judge's **access code**. A new judge is numbered automatically with the lowest free number. Under **Signatories**, choose the chairman of the board of judges and enter the tabulator's name. New codes are six digits; you can set your own of 4 to 12 letters or digits, but shorter codes are easier to guess. *Print access slips* gives you a cut-apart sheet to hand out.
3. **Contingents** — add the competing groups in order of performance. *Add several* takes one name per line.
4. **Categories & criteria** — check the criteria and weights. Each category should total 100%.

## Connect the judges

1. Connect the tabulation computer and every judge device to the **same Wi-Fi or LAN**.
2. Open **Live monitor** in the admin console. The blue box at the top shows the address judges use, for example `http://192.168.1.10:3000`.
3. On each judge device, open a browser and type that address exactly, including `http://` and the `:3000`.
4. The judge picks their name, enters their access code and signs in.

A judge is signed in on **one device at a time**. A second device is refused, even with the right code, until the first signs out or the tabulator presses **Disconnect** on the Judges page. That page shows the device signed in as each judge.

The **device lock** on the Judges page ties each judge to one device by its MAC address, and it is **on from the start**. A device that is not registered to a judge cannot open the judge scoresheet at all; that includes the tabulation computer's own browser. To register a judge's device, open the judge address on it: it is turned away and listed under *Devices turned away*, where *Register to a judge…* lets it in. Turn the lock off under Judges to let any device in. See the [Tabulator's Guide](docs/TABULATOR_GUIDE.md#judge-devices).

Judges enter points per criterion, up to the maximum shown under each column. Scores save as they type. When a category is fully scored the judge presses **Submit final scores**, which locks that scoresheet.

If a device cannot connect:

- Check that it is on the same network as the tabulation computer, not on mobile data or a guest network.
- Check that Windows Firewall allowed the app (see above). The network must be set to **Private** in Windows network settings.
- If the address has changed (the computer rejoined the network), use the new address shown in Live monitor.
- Some routers have "AP isolation" or "client isolation" turned on, which blocks devices from reaching each other. Turn it off.

## During the event

- **Live monitor** shows each judge's total for each contingent as it is entered, which judges are connected, and who has submitted. *Reopen* unlocks a submitted scoresheet when a judge needs to correct something.
- **Deductions** — record time and safety penalties. For timed rules, type the measured time (for example `6:15`) and the app works out the points.
- **Results** — live totals and ranking per category. Results are marked *Provisional* until every judge assigned to the category has submitted.

## Encoding paper scoresheets

When judges score on paper, the tabulating team enters the sheets on the **encoder screen** (`/encode/` on the judge address) from their own phones or laptops. A device pairs with the encoder access code and can do nothing until the tabulator approves its four-digit pairing code under **Encoding**, ticking the judges whose sheets it may enter; it cannot open any other judge's sheet. The encoder picks a category and judge, then types the scores, or photographs the sheet: Claude reads the handwriting and fills the grid, marking anything unclear or impossible, and the encoder checks and corrects every number before saving. Reading photos needs a Claude API key (set under **Encoding**) and internet on the tabulation computer; typing works offline. See the [Tabulator's Guide](docs/TABULATOR_GUIDE.md#encoding-paper-sheets).

## Printing

From **Results**:

- *Print this category* / *Print all categories* — official results sorted by rank: the rank each judge gave, the rank total, final rank, remarks and deductions, an explanation of any tie and the tie-break guidelines. Signed by the tabulator on the left (*Tabulated by*) and by the board of judges on the right (*Certified correct by the Board of Judges*), with the chairman last.
- *Print judge scoresheets* — one detailed sheet per judge, with every criterion score, total (raw) score, deduction, final score and rank.
- *Print blank sheets* — for scoring by hand and encoding afterwards: an empty scoresheet for each judge of the category to fill in and sign, and an empty tabulation sheet with signature lines for the judges and the tabulator. *Categories & criteria → Print blank sheets, all categories* prints them for every category at once.

Every sheet carries the official marks across the top: the Province of Misamis Occidental seal, Bagong Pilipinas and Asenso Misamis Occidental on the left, and the 97th Provincial Anniversary and Përangat Festival logos on the right. The app's own colours are taken from the 97th Provincial Anniversary logo.

Each print view has **Print** (the system print dialog) and **Save as PDF** buttons.

## How scores are computed

Every category is ranked by the **sum of the judges' ranks**, the same way as the festival's own tabulation sheet:

1. **Raw score** = the sum of one judge's criterion scores for a contingent.
2. **Final score** = raw score minus every deduction charged to that contingent. This is done on each judge's sheet.
3. **Judge rank** = each judge's final scores are ranked, highest first. Equal scores get a **fractional rank**: the average of the places they cover. Two contingents tied for 2nd and 3rd get 2.5 each (1, 2.5, 2.5, 4); three tied for 5th to 7th get 6 each.
4. **Rank total** = the sum of the ranks the judges gave a contingent.
5. **Final rank** = lowest rank total first. The lowest is the Champion.

Fractional ranks mean every judge gives out the same number of rank points whether or not they tie anyone, so a judge who gives equal scores does not hand those contingents a better rank than a judge who separates them.

### Tie-break guidelines

1. Equal scores on one judge's sheet share the average of the places they cover (step 3 above). They are not separated further.
2. Contingents with the same rank total are placed by average score, the mean of every judge's final score for the contingent. The higher average is placed first.
3. Contingents with the same rank total and the same average score are placed by a majority vote of the judges. If the vote is level, the chairman of the board of judges decides.
4. Averages count as the same only when they are equal to six decimal places. The tabulator records the result of any vote in the app (**Results → Record judges' vote**), and the results sheet shows each placing that was decided by vote. Until it is recorded, the tied contingents share the placing and the category is flagged *TIE · JUDGES TO VOTE*.

A category ranked by average score uses rules 3 and 4: equal averages go to the judges' vote.

Whenever a category has a tie, the Results screen and the printed results name the tied contingents, the figure they are tied on and how the tie was settled, and mark each tied row. The guidelines are printed on every results sheet.

Because deductions are taken off before the judges are ranked, a deduction can move a contingent down on every judge's sheet. A judge's score cannot go below zero.

Deductions apply only to categories with *Deductions apply* switched on. Out of the box that is Dance Showdown only; Best Music and Festival Queen ignore them.

Award titles are set per category. Dance Showdown starts with Champion, 1st Runner Up and 2nd Runner Up.

A category can instead be ranked by **average score**: the average of the judges' final scores, highest first. Deductions work the same way. Ranking method and award titles are under *Categories & criteria → Edit*.

## Data and backups

Everything is stored in a single SQLite file. Its location is shown under **Settings → Data** (on Windows, `%APPDATA%\perangat-tabulation\tabulation.sqlite`).

- **Back up now** writes a timestamped copy to a `backups` folder next to the database. Restoring one is described in [DEPLOYMENT.md](DEPLOYMENT.md#data-backup-and-restore).
- **Clear all scores** deletes scores, submissions and deductions but keeps the setup. Use it after a rehearsal.

Closing the app stops the server; judges are disconnected until it is started again. Their sign-ins and all saved scores survive a restart.

## Other commands

| Command | What it does |
| --- | --- |
| `npm start` | Runs the desktop app. |
| `npm run server` | Runs only the server, without the Electron window. The admin console is then at `http://localhost:3000/admin/` on that computer. Data goes to `./data/tabulation.sqlite`. |
| `npm test` | Runs the scoring, API and security tests. |
| `npm run bench` | Load test: every judge fills every scoresheet at once against a throwaway database, and response times are printed. `npm run bench -- 15 60` sets judges and contingents. |
| `npm run dist` | Builds a Windows installer into `dist/` with electron-builder. |

Environment variables: `PORT` (default `3000`; if it is taken the app tries the next ports) and `PERANGAT_DB` (path to the database file).

## Troubleshooting

**`npm start` says "Electron failed to install correctly".** The Electron program is downloaded during `npm install`, which needs internet access. Go online and run `npx install-electron`.

**The admin console says it is "only available on the tabulation computer".** That is by design: the admin pages and API only answer requests coming from the computer running the app.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.
