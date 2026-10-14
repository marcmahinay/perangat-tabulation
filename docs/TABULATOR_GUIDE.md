# Tabulator's Guide

For the person running the tabulation computer during the event. It assumes the app is already installed and the network is set up; if not, see [DEPLOYMENT.md](../DEPLOYMENT.md).

## The day before

Work through this once, calmly, with at least one real judge device.

1. Start the app. The admin console opens.
2. **Settings** — enter the event name, venue, date and your name as tabulator. These are printed on the results.
3. **Judges** — set each judge's name. Add or delete judges so the list matches the panel. If a judge only scores some categories, edit them and untick the others. Make sure every judge has a six-digit access code: press **New code** on any judge whose code is shorter. Short codes can be guessed by someone on the Wi-Fi. You do not type judge numbers: a new judge gets the lowest number not in use.
   Under **Signatories**, press **Edit** to choose the **chairman of the board of judges** and to enter your name as **tabulator**. The tabulator's name is also under **Settings**.
4. **Contingents** — add every contingent in order of performance. *Add several* takes one name per line.
5. **Categories & criteria** — confirm the criteria and weights against the official criteria sheet. Each category should show *Weights total 100%*.
6. **Judges → Print access slips** — print, cut apart, and keep them safe until the event.
   Also print a set of blank sheets as a fallback: **Categories & criteria → Print blank sheets, all categories**. See *Scoring on paper* below.
7. **Register each judge's device.** The device lock is on from the start, so a judge device can open the judge scoresheet only once it is registered. See *The device lock* below.
8. Run a rehearsal: sign in on a judge device, enter scores for a few contingents, record a deduction, submit, and print a results sheet.
   If the tabulating team will encode paper sheets, pair their devices under **Encoding**, and set the Claude API key there if photos will be read. See *Encoding paper sheets* below.
9. **Settings → Clear all scores** — removes the rehearsal scores and keeps the setup.
10. **Settings → Back up now**.

## Starting the event

1. Start the tabulation computer and connect it to the event network before anyone else.
2. Start the app and open **Live monitor**. The blue box shows the address judges must use.
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

Every deduction is taken from each judge's raw score for that contingent: a 1-point deduction lowers the contingent by 1 on every judge's sheet. This happens before the judges are ranked, so a deduction can change the ranks on every sheet. Judges see the deduction on their own screen. Out of the box, deductions affect Dance Showdown only.

To undo a deduction, press **Remove** next to it.

### When a judge needs to change a submitted score

On **Live monitor**, press **Reopen** on that judge's chip. Their scoresheet unlocks, the category goes back to *Provisional*, and they must submit again.

### Scoring on paper

If judges will write their scores first, or a device or the network fails, use the blank sheets.

**Results → Print blank sheets** prints, for the category on screen:

- one empty **judge scoresheet** per judge, with the contingents in order of performance, a column for each criterion showing its maximum, and a signature line for that judge;
- one empty **tabulation sheet** for the category, with a column for each judge, the tie-break guidelines, and signature lines for every judge and for you.

**Categories & criteria → Print blank sheets, all categories** prints the same for every category in one go. Add the contingents before printing so their names are on the sheets; a category with none prints ten empty lines.

The judge writes the points for each criterion and the total, then signs. Deduction, final score and rank are left for you.

The tabulating team enters signed paper sheets on the **encoder screen**, from their own phones or laptops. See *Encoding paper sheets* below.

## Encoding paper sheets

The tabulating team types judges' paper scoresheets into the system from their own phones or laptops, or photographs a sheet and lets the app read it. Only devices you approve can do this.

### Pairing an encoder's device

1. Open **Encoding** in the admin console. It shows the encoder address (the judge address followed by `/encode/`) and the **encoder access code**. Give both to the tabulating team only; the code is not a judge's code.
2. On the encoder's phone or laptop, on the event network, open that address, enter their name and the access code, and press **Ask to pair this device**. The device shows a four-digit **pairing code**.
3. On **Encoding**, the request appears under **Waiting for approval**, and the sidebar shows a count next to Encoding. Check that the pairing code on the device matches the one listed, then press **Approve**. If it does not match, or you do not know the device, press **Turn down**.
4. In the approval window, tick the **judges whose paper sheets this person enters**, then press **Approve**. An encoder can open and change only those judges' sheets. With no judge ticked, the device is paired but cannot encode anything; its screen says *No judges are assigned to you yet*.

To change an encoder's judges later, press **Judges…** next to them under **Paired devices**; they press **Check again** or **Reload** on their screen to see the change. A device without judges is marked *None — cannot encode*.

An approved device stays paired until you press **Unpair** under **Paired devices**, or the encoder presses **Unpair** on the device. **New code** changes the access code for new requests; devices already paired stay paired.

### Entering a sheet

1. Choose the **category** and the **judge** whose paper sheet it is. Only the judges assigned to you are offered. The sheet shows what is already saved for that judge.
2. Either type each score, or press **Scan paper sheet** and photograph the whole sheet, flat and in good light, with all rows visible.
3. After a scan, the scores read from the photo appear in blue. Cells outlined in red need a look: the writing was unclear, or what was read cannot be right (for example above the criterion's maximum). Tap a cell to see why. Warnings below the photo list rows where the scores do not add up to the total the judge wrote, and contingents missing from the photo.
4. **Check every number against the paper sheet** and correct any that are wrong. A scan never saves anything by itself.
5. Press **Save**. Saved scores appear at once on Live monitor and on the judge's own device. Each saved score records who encoded it.
6. When the whole sheet matches the signed paper, press **Submit scoresheet**. It locks like a judge's own submission; reopen it on Live monitor if a correction is needed.

Keep the signed paper sheets. Print the judge scoresheets from **Results** and have each judge sign the printed copy against their handwritten one.

### Reading photos

Reading a photo uses Claude, Anthropic's AI model, so it needs:

- a **Claude API key**: on **Encoding → Reading photos**, press **Set API key**. The key stays on the tabulation computer and is never shown again;
- **internet access on the tabulation computer** while a photo is read. Judge and encoder devices do not need internet.

Each photo is sent to Anthropic to be read and is charged to the API key's account. Without a key or without internet, the encoder sees a message and types the scores in instead; everything else keeps working.

## Judge devices

### One device per judge

A judge is signed in on one device at a time. While a device is signed in as Judge 1, nobody else can sign in as Judge 1 from another device, even with the right access code. They are told *Judge 1 is already signed in on another device*.

**Judges** shows, for each judge, the device that is signed in: whether it is connected, its MAC address, its network address, and since when.

If the wrong person or the wrong device is signed in as a judge, press **Disconnect** on that judge's row. The device is signed out at once and shown *The tabulator disconnected this device*. Scores already saved are kept, and the right judge can now sign in. Disconnecting does not change the access code: if someone who should not have it knows the code, press **New code** instead, which signs the device out and gives the judge a fresh code.

A judge who signs out, or whom you disconnect, can sign in on any other device.

### The device lock

The device lock ties each judge to one device by its **MAC address**, the hardware address of its Wi-Fi or network adapter. **It is on from the start.** With the lock on:

- only a device registered to a judge can open the judge scoresheet at all;
- that device can sign in only as the judge it is registered to;
- every other device on the network is shown *This device cannot open the judge scoresheet*, with its own MAC address;
- a judge with no registered device cannot sign in.

The lock applies to the tabulation computer too: with it on, a browser there cannot open the judge scoresheet or sign in as a judge, even with the right code. The admin console keeps working. To enter a judge's paper sheet, use the encoder screen (see *Encoding paper sheets*).

To register the judges' devices, with every judge device on the event network:

1. On each judge's device, open the judge address. It is turned away with *This device cannot open the judge scoresheet* and its MAC address.
2. On **Judges**, under **Device lock**, the device appears in **Devices turned away**. Press **Register to a judge…** and choose the judge who will use it. You can also type a MAC address under **Edit**.
3. On the device, reload the page. It now opens, and the judge signs in with their access code.

Until a judge has a registered device, that judge's row says *None — cannot sign in*. Use the same steps for a replacement tablet during the event.

To let any device in, for example to test the judge screen on this computer, press **Turn off**. The registrations are kept. With the lock off, you can also register a device by having the judge sign in on it and pressing **Use signed-in device** on their row; turn the lock back on afterwards. Turning it on tells you which judges have no registered device and which will be signed out because they are on a different device.

Things to know:

- **Register devices on the event network.** Phones and tablets use a different "private" MAC address on each Wi-Fi network, so an address noted at home or on another network will not match. On the device, the private address should be set to *Fixed*, not *Rotating*, for the event network, or switched off for that network.
- **Devices must be on the same network as the tabulation computer**, not behind a second router or a Wi-Fi extender that makes its own network. The tabulation computer cannot read the MAC address of a device like that, and the lock refuses it with *This device cannot be identified*.
- **A MAC address can be copied** by someone who knows how. The lock keeps ordinary devices out; it is used together with the access codes and a Wi-Fi password, not instead of them.

## How the winner is decided

1. Each judge's scores for a contingent are added up. That is the judge's raw score, shown as **Total score** on their sheet.
2. Deductions charged to the contingent are taken off that raw score. The result is the judge's **Final score**.
3. Each judge's final scores are ranked, highest first. Equal scores share the average of the places they cover: two contingents tied for 2nd and 3rd get 2.5 each, and the next gets 4. This is why ranks and rank totals can end in .5.
4. The ranks a contingent received from all judges are added. That is its **rank total**.
5. The lowest rank total is the Champion, the next lowest is 1st Runner Up, and so on.

### Tie-break guidelines

These are applied in order. They are also printed on every results sheet.

1. **Equal scores on one judge's sheet.** The contingents share the average of the places they cover: two level for 2nd and 3rd get rank 2.5 each, and the next gets rank 4. They are not separated further.
2. **Equal rank totals.** The contingents are placed by average score, the mean of every judge's final score for the contingent (raw score less deductions). The higher average is placed first.
3. **Equal rank total and equal average score.** The contingents are placed by a majority vote of the judges. If the vote is level, the chairman of the board of judges decides.
4. **Recording the vote.** Averages count as the same only when they are equal to six decimal places. You record the result of any vote in the app, and the results sheet shows each placing that was decided by vote.

A category set to rank by average score has two rules: contingents with the same average score are placed by a majority vote of the judges (the chairman decides a level vote), and rule 4 above.

Check with the festival committee before the event whether they want a different tie-break.

### When there is a tie

**Results** and the printed results sheet say so in three places:

- A **Tie in this category** box under the table names the tied contingents, the figure they are tied on, and how the tie was settled. For example: *Dipolog City and Surigao City are tied on a rank total of 3. The higher average score is placed first: Dipolog City 93.000 (rank 1), Surigao City 92.500 (rank 2).*
- Each tied contingent's row is marked *Tie-break* when the average score decided its place, *Judges' vote* when the vote did, or *Tied for rank 1* while it waits for the vote. The printed sheet adds the detail: *Tie-break: avg. score 93.000*, or the vote count you entered.
- The **Tie-break guidelines** above are listed under the table, so anyone reading the sheet can check the result against the rule.

A judge's printed scoresheet lists any equal scores on that sheet and the rank they share.

Read the tie box aloud, or show it to the committee, before announcing a result that was decided by a tie-break or by vote.

### When the judges must vote

If contingents have the same rank total and the same average score, the category shows **TIE · JUDGES TO VOTE**, the tied rows say *Tied for rank 3*, and they share that placing for now. A results sheet printed in that state is stamped *NOT FINAL — A TIE IS WAITING FOR THE JUDGES' VOTE*. Do not announce it.

1. Ask the board of judges to vote. Each judge votes for the order of the tied contingents; the majority decides, and the chairman decides a level vote.
2. On **Results**, in the tie box, press **Record judges' vote**.
3. Choose which contingent takes each place, and optionally enter the vote count (for example *3–2*, or *chairman's vote*). It is printed with the result.
4. Press **Save vote**. The placings and awards follow the vote at once, and the tie box says *the judges voted*.

**Change** or **Clear** next to a recorded vote corrects it. A vote counts only while exactly those contingents are still tied: if a score changes afterwards and the tie is different, the old vote stops applying and the category asks for a new one.

## Closing a category

1. Wait until the category shows **FINAL** on the monitor. That means every judge assigned to it has submitted.
2. Open **Results** and choose the category. Read it once before printing. If a **Tie in this category** box appears, read it too: it says who was tied and how the tie was settled.
3. **Print this category** — the official result: each judge's rank, the rank total, final rank, remarks and deductions, any ties and how they were settled, and the tie-break guidelines. You sign on the left under *Tabulated by*; the judges sign on the right under *Certified correct by the Board of Judges*, with the chairman last as *Chairman, Board of Judges*. With no chairman chosen, every judge signs as a member.
4. **Print judge scoresheets** — one sheet per judge with every criterion score. Have each judge sign their own.

Every printed sheet carries the official logos across the top.
5. **Settings → Back up now**.

A printout made before the category is final is stamped *PROVISIONAL* in red. Never announce from a provisional sheet.

## Things that change scores — be careful mid-event

| If you... | Then... |
| --- | --- |
| Add a contingent | Submitted scoresheets in its categories are reopened, because there is something new to score. |
| Add a criterion | Submitted scoresheets in that category are reopened. |
| Delete a contingent, judge, criterion or category | Every score attached to it is deleted with it. This cannot be undone. |
| Change a judge's access code | That judge is signed out and must sign in again with the new code. Their scores are kept. |
| Disconnect a judge's device | That device is signed out at once. Scores it had typed but not yet saved are lost; saved scores are kept. |
| Turn on the device lock, or change a judge's registered device | Any judge signed in on a device that is not their registered one is signed out. |
| Lower a criterion's weight | Refused if a judge has already given more than the new weight. |
| Change a category's ranking method or award titles | Results are recalculated at once. No scores are lost. |

## When something goes wrong

**A judge's dot is grey.** Their device is not connected. Check that it is on the event Wi-Fi and has the page open. Scores they already saved are safe.

**A judge's screen says scores are not saved.** Their device lost the network. They should keep the page open; it sends the scores by itself when the connection returns. They must not close or refresh the page.

**A judge forgot their code, or it may have been seen.** Open **Judges** and read the code to them, or press **New code** to replace it.

**An encoder's scan says reading photos is not set up, or that the computer cannot reach the internet.** Set the API key under **Encoding**, or connect the tabulation computer to the internet. Until then the encoder types the scores in.

**An encoder's screen says no judges are assigned to them, or that a judge is not assigned to them.** On **Encoding**, press **Judges…** next to their device and tick the judges whose sheets they enter. They then press **Check again**.

**An encoder's device says it is not paired.** You unpaired it, or turned its request down. The encoder asks again with the access code.

**A judge's device breaks.** Open **Judges** and press **Disconnect** on that judge, then give them another device. They sign in with the same code and their saved scores are there. If the device lock is on, the new device must be registered first: open the judge page on it, then press **Register to a judge…** next to it under **Devices turned away**.

**A judge is told they are already signed in on another device.** Someone else is signed in as that judge, or the judge left their first device signed in. Check the device shown on that judge's row under **Judges**. If it is not theirs, press **Disconnect**, then **New code** if the code may have been seen.

**A judge's device says it cannot open the judge scoresheet.** The device lock is on and that device is not registered. If it should be allowed, register it from **Devices turned away**. If it says the device *cannot be identified*, it is not on the same network as the tabulation computer.

**The lock is turning away a device you have registered.** Its MAC address has changed, usually because its private Wi-Fi address is set to rotate. Register the address now shown under **Devices turned away**, or turn the lock off for the rest of the event.

**The tabulation computer restarts or the app is closed.** Start the app again. All saved scores and submissions are intact. Judge devices reconnect on their own within a few seconds and stay signed in.

**The address on the monitor has changed.** The computer was given a different address by the network. Judges must open the new address and sign in again with their codes. Their saved scores are intact. See DEPLOYMENT.md for how to give the computer a fixed address so this cannot happen.

**The address ends in `:3001` instead of `:3000`.** Another program was using port 3000 when the app started. Judges must type the address exactly as shown.

**You need to go back to an earlier state.** Restore a backup; see DEPLOYMENT.md. Everything entered after that backup is lost, so do this only as a last resort.
