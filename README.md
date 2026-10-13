# Perangat Tabulation

A dance contest tabulation system for the Perangat Festival that runs entirely on a local network. One computer runs the app; judges score from the browser on their own tablet, laptop or phone. No internet is needed.

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
| Safety & Prohibited Acts Violation | 5 points from the final score |
| Exceeding Entrance Time (limit 4:00) | 1 point from each judge's total |
| Exceeding Exit Time (limit 2:00) | 1 point from each judge's total |
| Exceeding Actual Performance Time (limit 5:00) | 1 point per full minute over, from each judge's total — 5:01–5:59 is free, 6:00 costs 1, 7:00 costs 2 |

Categories, criteria, weights, deduction rules, judges and contingents can all be changed in the app.

## Requirements

- **Node.js 22.5 or newer** on the tabulation computer. The app uses Node's built-in SQLite, so there are no native modules to compile. Developed and tested with Node 26 and Electron 39.
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
2. **Judges** — three judges are created to start with. Rename them, add more, and note each judge's **access code**. *Print access slips* gives you a cut-apart sheet to hand out.
3. **Contingents** — add the competing groups in order of performance. *Add several* takes one name per line.
4. **Categories & criteria** — check the criteria and weights. Each category should total 100%.

## Connect the judges

1. Connect the tabulation computer and every judge device to the **same Wi-Fi or LAN**.
2. Open **Live monitor** in the admin console. The purple box at the top shows the address judges use, for example `http://192.168.1.10:3000`.
3. On each judge device, open a browser and type that address exactly, including `http://` and the `:3000`.
4. The judge picks their name, enters their access code and signs in.

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

## Printing

From **Results**:

- *Print this category* / *Print all categories* — official results sorted by rank: the rank each judge gave, the rank total, final rank, remarks and deductions, with signature lines for the judges and the tabulator.
- *Print judge scoresheets* — one detailed sheet per judge, with every criterion score, total, deduction, final score and rank.

Each print view has **Print** (the system print dialog) and **Save as PDF** buttons.

## How scores are computed

Every category is ranked by the **sum of the judges' ranks**, the same way as the festival's own tabulation sheet:

1. **Judge total** = sum of that judge's criterion scores, minus deductions.
2. **Judge rank** = each judge's totals are ranked, highest total first. Ties share a rank and the next rank is skipped (1, 2, 2, 4).
3. **Rank total** = the sum of the ranks the judges gave a contingent.
4. **Final rank** = lowest rank total first. The lowest is the Champion.

If two contingents have the same rank total, the one with the higher average score is placed first. If the average is also equal they share the placing.

Deductions come off every judge's total before the judges are ranked. That includes the 5-point safety penalty: the rule book takes it "from the final score", but with ranks deciding the result it only has an effect if it is taken off each judge's total.

Deductions apply only to categories with *Deductions apply* switched on. Out of the box that is Dance Showdown only; Best Music and Festival Queen ignore them.

Award titles are set per category. Dance Showdown starts with Champion, 1st Runner Up and 2nd Runner Up.

A category can instead be ranked by **average score** (highest wins), where per-judge deductions come off each judge's total and final-score deductions come off the average. Ranking method and award titles are under *Categories & criteria → Edit*.

## Data and backups

Everything is stored in a single SQLite file. Its location is shown under **Settings → Data** (on Windows, `%APPDATA%\perangat-tabulation\tabulation.sqlite`).

- **Back up now** writes a timestamped copy to a `backups` folder next to the database.
- **Clear all scores** deletes scores, submissions and deductions but keeps the setup. Use it after a rehearsal.

Closing the app stops the server; judges are disconnected until it is started again. Their sign-ins and all saved scores survive a restart.

## Other commands

| Command | What it does |
| --- | --- |
| `npm start` | Runs the desktop app. |
| `npm run server` | Runs only the server, without the Electron window. The admin console is then at `http://localhost:3000/admin/` on that computer. Data goes to `./data/tabulation.sqlite`. |
| `npm test` | Runs the scoring and API tests. |
| `npm run dist` | Builds a Windows installer into `dist/` with electron-builder. |

Environment variables: `PORT` (default `3000`; if it is taken the app tries the next ports) and `PERANGAT_DB` (path to the database file).

## Troubleshooting

**`npm start` says "Electron failed to install correctly".** Run `node scripts/ensure-electron.js`. On some Node versions Electron's installer downloads the program but exits before unpacking it; this script finishes the job. It also runs automatically after `npm install`.

**The admin console says it is "only available on the tabulation computer".** That is by design: the admin pages and API only answer requests coming from the computer running the app.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.
