# Deployment

How to get the tabulation system installed, on the network, and verified before an event. For running the event itself, see [docs/TABULATOR_GUIDE.md](docs/TABULATOR_GUIDE.md).

## What you are deploying

| Piece | What it is | What it needs |
| --- | --- | --- |
| Tabulation computer | One Windows 10/11 PC running the Perangat Tabulation app. It holds the database and serves the judge pages. | The app installed, a fixed address on the event network, port 3000 open in the firewall |
| Event network | A Wi-Fi router or switch that every device connects to. | No internet required. Devices must be allowed to reach each other. |
| Judge devices | Tablets, laptops or phones, one per judge. | A current browser (Chrome, Edge, Safari). Nothing is installed on them. |

There is no cloud component. If the tabulation computer is off, nothing works; if it is on and reachable, everything works.

## 1. Build the installer

Do this on a development computer with Node.js 22.12 or newer.

```bash
git clone https://github.com/marcmahinay/perangat-tabulation.git
cd perangat-tabulation
npm install
npm test
npm run dist
```

The result is `dist\Perangat Tabulation Setup 1.0.0.exe` (about 110 MB). The first build downloads the packaging tools, so it needs internet access once.

Copy that one file to the tabulation computer on a USB drive. The tabulation computer does not need Node.js, git or internet access.

## 2. Install on the tabulation computer

1. Run `Perangat Tabulation Setup 1.0.0.exe`.
2. Windows shows **"Windows protected your PC"**, because the installer is not code-signed. Choose **More info**, then **Run anyway**.
3. The installer needs no administrator rights and asks no questions. It installs for the current Windows user, adds a Start menu and desktop shortcut, and starts the app.

Sign in to Windows as the same user on event day. The app and its data belong to that user account.

### Alternative: run from source

If you would rather not build an installer, install Node.js 22.12+ on the tabulation computer, copy the project folder across, and run:

```bash
npm install
npm start
```

`npm install` needs internet access. Both ways of running the app use the same database file, so you can switch between them without losing data.

## 3. Set up the network

A dedicated router that you control is strongly recommended over the venue's shared Wi-Fi.

1. **Connect the tabulation computer** to the event router, by cable if possible.
2. **Mark the network as Private** in Windows: *Settings → Network & internet →* the connection *→ Network profile type → Private*. On a Public network Windows blocks incoming connections.
3. **Give the computer a fixed address.** Judges type this address, and their sign-in is tied to it, so it must not change during the event. Either:
   - reserve the address in the router (usually called *DHCP reservation* or *address binding*), or
   - set a static IP in Windows that is outside the router's DHCP range.
4. **Turn off client isolation** on the router (also called *AP isolation* or *guest mode*). With it on, judge devices cannot reach the tabulation computer.
5. **Stop the computer from sleeping**: *Settings → System → Power* → set sleep to *Never* while plugged in. Keep it on mains power.
6. **If you will use the device lock, keep every judge device on the same network segment as the tabulation computer.** The lock identifies a device by its MAC address, which the tabulation computer reads from its own neighbour (ARP) table. That table only holds devices it reaches directly: one router or switch, no second router, and no Wi-Fi extender that hands out its own addresses. On each judge device, set the *private Wi-Fi address* for the event network to *Fixed* (or off), so its MAC address does not change during the event.

## 4. Open the firewall

The first time the app starts, Windows Firewall asks whether to allow it. Tick **Private networks** and choose **Allow**.

If that prompt was dismissed or never appeared, add the rule by hand in a PowerShell window opened with **Run as administrator**:

```powershell
netsh advfirewall firewall add rule name="Perangat Tabulation" dir=in action=allow protocol=TCP localport=3000 profile=private
```

## 5. Verify before the event

Do not skip this. Each step checks one link in the chain.

| Step | Do this | You should see |
| --- | --- | --- |
| 1 | Start the app on the tabulation computer. | The admin console, with an address such as `http://192.168.1.10:3000` in the blue box on **Live monitor**. |
| 2 | On the tabulation computer, open that address in a browser. | The judge sign-in page. This proves the server is listening on the network address. |
| 3 | On a judge device connected to the event network, open the same address. | The judge sign-in page. This proves the firewall and router allow it. |
| 4 | Sign in on that device with a judge's access code. | The scoresheet, and that judge's dot turning green on **Live monitor**. |
| 5 | Type a score on the device. | The score appearing on **Live monitor** within a second. |
| 6 | On the judge device, try opening `http://<address>:3000/admin/`. | A refusal: *"The admin console is only available on the tabulation computer."* |
| 7 | Close the app and start it again. | The score from step 5 still there, and the judge device reconnecting by itself. |
| 8 | **Results → Print this category**. | A print preview. Print one page to confirm the printer works. |

If step 2 works but step 3 does not, the problem is the firewall rule, the network being set to Public, or client isolation on the router.

Then set up the event data and run a rehearsal as described in the Tabulator's Guide.

## Data, backup and restore

All data is one SQLite file in the Windows user's profile:

```
%APPDATA%\perangat-tabulation\tabulation.sqlite
```

Paste `%APPDATA%\perangat-tabulation` into the File Explorer address bar to open the folder. The exact path is also shown in the app under **Settings → Data**.

**Back up** with **Settings → Back up now**. Each backup is a complete, standalone copy named with the date and time, for example `backups\tabulation-20261116-193045.sqlite`, in the same folder. Back up after setup, after each category is final, and at the end. Copy the last backup to a USB drive before leaving the venue.

**Restore** a backup:

1. Close the app.
2. In the data folder, delete `tabulation.sqlite` and, if they exist, `tabulation.sqlite-wal` and `tabulation.sqlite-shm`.
3. Copy the backup file into the data folder and rename it `tabulation.sqlite`.
4. Start the app.

Everything entered after that backup was made is gone. Judges who signed in before the backup stay signed in; anyone who signed in after it must sign in again.

**Move to another computer** (for example a spare, if the first one fails): install the app there, close it, and put the latest backup in its data folder as `tabulation.sqlite`, exactly as for a restore. The new computer will have a different address unless you give it the old one, so judges may need to open the new address and sign in again.

## Configuration

Three optional settings are read from environment variables when the app starts.

| Variable | Default | Use it to |
| --- | --- | --- |
| `PORT` | `3000` | Use another port. If the port is taken, the app tries the next nine and shows the one it got on **Live monitor**. |
| `PERANGAT_DB` | the path above | Keep the database somewhere else, such as a second drive. |

| `ANTHROPIC_API_KEY` | none | Supply the Claude API key used to read photos of paper scoresheets, instead of entering it under **Encoding**. A key entered in the app takes precedence. |

To set one for the installed app: *Start → "Edit environment variables for your account" → New*, then restart the app. If you change the port, change the firewall rule to match.

## Updating

1. Back up.
2. On the development computer, raise `version` in `package.json`, add an entry to `CHANGELOG.md`, and run `npm run dist`.
3. Run the new installer on the tabulation computer. It replaces the program and leaves the data alone.

A newer version upgrades an older database by itself the first time it starts. Do not update between rehearsal and the event unless you have time to repeat the verification steps.

## Uninstalling

*Settings → Apps → Installed apps → Perangat Tabulation → Uninstall*. The data folder is left in place; delete `%APPDATA%\perangat-tabulation` yourself if you want it gone.

## Limits to know about

- **The installer is unsigned.** Windows warns about it and some antivirus products may too. Signing needs a code-signing certificate.
- **Traffic is plain HTTP.** Anyone on the same network could read it. Use a network with a password that only the event team and judges know, and never forward the port to the internet.
- **The admin console has no password.** It is protected by only being reachable on the tabulation computer itself, so lock that computer's screen when you step away.
- **Reading photos of paper sheets needs the internet** on the tabulation computer, and sends each photo to Anthropic (Claude) to be read, billed to the API key's account. Everything else, including typing scores in on the encoder screen, works offline. If the event network has no internet, connect the tabulation computer to a second network (a phone hotspot, say) only while photos are being read, or have encoders type the scores.
- **The device lock is a barrier, not a guarantee.** A MAC address is not secret and can be copied by someone with the skill to do it. Use the lock together with a Wi-Fi password and the access codes.
- **One tabulation computer at a time.** Two copies on the same network would each have their own separate scores.
- **Only Windows has been tested.**
