# Tabulator's Guide

For the person running the tabulation computer during the event. It assumes the app is already installed and the network is set up; if not, see [DEPLOYMENT.md](../DEPLOYMENT.md).

## The day before

Work through this once, calmly, with at least one real judge device.

1. Start the app. The admin console opens.
2. **Settings** — enter the event name, venue, date and your name as tabulator. These are printed on the results.
3. **Judges** — set each judge's name. Add or delete judges so the list matches the panel. If a judge only scores some categories, edit them and untick the others. Make sure every judge has a six-digit access code: press **New code** on any judge whose code is shorter. Short codes can be guessed by someone on the Wi-Fi.
4. **Contingents** — add every contingent in order of performance. *Add several* takes one name per line.
5. **Categories & criteria** — confirm the criteria and weights against the official criteria sheet. Each category should show *Weights total 100%*.
6. **Judges → Print access slips** — print, cut apart, and keep them safe until the event.
7. Run a rehearsal: sign in on a judge device, enter scores for a few contingents, record a deduction, submit, and print a results sheet.
8. **Settings → Clear all scores** — removes the rehearsal scores and keeps the setup.
9. **Settings → Back up now**.

## Starting the event

1. Start the tabulation computer and connect it to the event network before anyone else.
2. Start the app and open **Live monitor**. The purple box shows the address judges must use.
3. Check that the address matches the one printed on the access slips. If it is different, tell the judges the new one.
4. Hand out the access slips. As each judge signs in, their dot on the monitor turns green.
5. Do not start the first performance until every judge shows green.

## During the event

### Watching the scores

**Live monitor** has one panel per category.

- The chips at the top show each judge: a green dot when their device is connected, how many contingents they have fully scored (`4/9`), and whether they have submitted.
- In the table, each judge's column shows the total they gave and, in the small circle, the rank that puts the contingent at on their sheet.
- A cell such as `2/4` means the judge has filled two of four criteria for that contingent. A dot means nothing yet.
- **Rank total** and **Rank** fill in once every judge has fully scored the contingent.

### Recording deductions

Open **Deductions** as soon as the timekeeper reports a violation.

| Violation | What to enter | What the app charges |
| --- | --- | --- |
| Exceeding Entrance Time | The measured time, e.g. `4:11` | 1 point for anything over 4:00 |
| Exceeding Exit Time | The measured time, e.g. `2:20` | 1 point for anything over 2:00 |
| Exceeding Actual Performance Time | The measured time, e.g. `6:15` | Nothing up to 5:59, 1 point from 6:00, 2 from 7:00, and so on |
| Safety & Prohibited Acts Violation | How many violations | 5 points each |

If you type a time that is within the limit, the app tells you no deduction applies and records nothing.

Every deduction comes off each judge's total for that contingent before the judges are ranked, so a deduction can change the ranks on every sheet. Judges see the deduction on their own screen. Out of the box, deductions affect Dance Showdown only.

To undo a deduction, press **Remove** next to it.

### When a judge needs to change a submitted score

On **Live monitor**, press **Reopen** on that judge's chip. Their scoresheet unlocks, the category goes back to *Provisional*, and they must submit again.

## How the winner is decided

1. Each judge's scores for a contingent are added up, less deductions. That is the judge's total.
2. Each judge's totals are ranked, highest first. Equal totals share a rank and the next rank is skipped: 1, 2, 2, 4.
3. The ranks a contingent received from all judges are added. That is its **rank total**.
4. The lowest rank total is the Champion, the next lowest is 1st Runner Up, and so on.

If two contingents have the same rank total, the one with the higher average score is placed first. If that is equal too, they share the placing and the next placing is skipped. Check with the festival committee before the event whether they want a different tie-break.

## Closing a category

1. Wait until the category shows **FINAL** on the monitor. That means every judge assigned to it has submitted.
2. Open **Results** and choose the category. Read it once before printing.
3. **Print this category** — the official result: each judge's rank, the rank total, final rank, remarks and deductions, with a signature line for each judge and for you.
4. **Print judge scoresheets** — one sheet per judge with every criterion score. Have each judge sign their own.
5. **Settings → Back up now**.

A printout made before the category is final is stamped *PROVISIONAL* in red. Never announce from a provisional sheet.

## Things that change scores — be careful mid-event

| If you... | Then... |
| --- | --- |
| Add a contingent | Submitted scoresheets in its categories are reopened, because there is something new to score. |
| Add a criterion | Submitted scoresheets in that category are reopened. |
| Delete a contingent, judge, criterion or category | Every score attached to it is deleted with it. This cannot be undone. |
| Change a judge's access code | That judge is signed out and must sign in again with the new code. Their scores are kept. |
| Lower a criterion's weight | Refused if a judge has already given more than the new weight. |
| Change a category's ranking method or award titles | Results are recalculated at once. No scores are lost. |

## When something goes wrong

**A judge's dot is grey.** Their device is not connected. Check that it is on the event Wi-Fi and has the page open. Scores they already saved are safe.

**A judge's screen says scores are not saved.** Their device lost the network. They should keep the page open; it sends the scores by itself when the connection returns. They must not close or refresh the page.

**A judge forgot their code, or it may have been seen.** Open **Judges** and read the code to them, or press **New code** to replace it.

**A judge's device breaks.** Give them another device. They sign in with the same code and their saved scores are there.

**The tabulation computer restarts or the app is closed.** Start the app again. All saved scores and submissions are intact. Judge devices reconnect on their own within a few seconds and stay signed in.

**The address on the monitor has changed.** The computer was given a different address by the network. Judges must open the new address and sign in again with their codes. Their saved scores are intact. See DEPLOYMENT.md for how to give the computer a fixed address so this cannot happen.

**The address ends in `:3001` instead of `:3000`.** Another program was using port 3000 when the app started. Judges must type the address exactly as shown.

**You need to go back to an earlier state.** Restore a backup; see DEPLOYMENT.md. Everything entered after that backup is lost, so do this only as a last resort.
