# Playbook: guide a new user from zero to counting strokes

For coding agents (Claude Code, Codex, …) started in this repository by someone who
asks "What do I have to do?", "Was muss ich tun?", "Help me set this up" or similar.
Assume the person is **not technical**: they may never have used the Terminal. Your job
is to lead them step by step, do everything you can do yourself, and tell them exactly
what to click for the rest.

## How to work

- Talk in the user's language (German if they write German), short sentences, no
  jargon. Explain *why* a step is needed in one sentence.
- **One step at a time.** Do it, check that it worked, say what happened, then go on.
  Never dump the whole list on them.
- **Run commands yourself** when you can; show them only when the user must type
  something (passwords) or wants to see it.
- **Ask before** installing software, downloading large files, replacing an existing
  `/Applications/Foriq.app` or changing system settings. Say what it is and roughly how
  long it takes.
- **Never ask for passwords in the chat** and never type them. Commands that need the
  Mac password (Homebrew's installer, `sudo`) are run by the user in their own Terminal
  window; give them the exact line to paste.
- You cannot click in apps or the browser. For those steps say precisely what the
  user sees and where to click, then ask them to tell you when it is done.
- Check the state before each step (is it installed already? running?) and skip what
  is done. Picking up halfway is normal.

## 0. Find out what the user wants

Ask (one message, simple choices):

1. **Use Foriq** on this Mac and count strokes on their machines (most people) → §1–§5.
2. **Change Foriq** (other counting behaviour, other hardware, own app build) → §1, then
   §6.

Also ask whether they already have sensors (M5Stack StickS3) and a USB-C cable.

## 1. Check the Mac

```bash
uname -m                 # must be arm64 (Apple silicon: M1, M2, M3 …)
sw_vers -productVersion  # must be 13 or newer
ls -d /Applications/Foriq.app 2>/dev/null && pgrep -fl "Foriq.app/Contents/MacOS/Foriq"
```

- Intel Mac or macOS older than 13: Foriq does not run there yet. Say so plainly and
  stop (offer to open an issue on GitHub if they want Intel support).
- The Mac runs Foriq for all sensors, so it should stay switched on and awake during
  production (lid open or an external display; Foriq prevents sleep by default).

## 2. Install the app

Already installed and running? Skip to §3 (or offer an update, see §7).

```bash
curl -fsSL https://foriq.de/install | bash
open /Applications/Foriq.app
```

The script downloads the newest release (about 260 MB), checks its checksum and copies
`Foriq.app` to Applications. Nothing else on the Mac is changed.

Then tell the user what appears:

- A **Foriq window** (status window) with green lights for database, backend and backup.
  The first start takes up to a minute.
- macOS may ask **"Allow incoming network connections?"** → *Allow*. Without it the
  sensors cannot reach the Mac. If the window later shows "nur lokal erreichbar" /
  "only reachable locally": System Settings › Network › Firewall › Options → allow Foriq.

Check from here:

```bash
curl -fsS http://localhost:8420/health          # {"status":"ok","db":true}
curl -fsS -m 5 http://foriq.local:8420/health   # same via the network name
```

## 3. Create the account

Open the web interface for them (`open http://foriq.local:8420`). The first visit shows
*Admin-Zugang anlegen* / *create admin access*: company name, name, e-mail, password.
The user fills it in themselves; this first account is the owner. The interface is
German by default; English can be chosen in the settings.

If `foriq.local` does not open: use the IP address shown in the Foriq window, e.g.
`http://192.168.1.20:8420`.

## 4. Set up a sensor

Needs a **M5Stack StickS3**, a USB-C data cable and the name and password of a
**2.4 GHz Wi-Fi** that reaches the machine (5 GHz-only networks do not work).

1. Plug the stick into the Mac. The Foriq window shows the card *Sensor am USB* /
   *Sensor on USB*.
2. Click *Einrichten* / *Set up* (about one minute, do not unplug). The stick is erased
   and gets the Foriq firmware.
3. Choose Wi-Fi: enter name and password in the Foriq window (*Verbinden*), or later via
   phone: connect the phone to the Wi-Fi **Foriq-Setup** (password = setup code shown in
   the window) and pick the network there.
4. In the web interface: *Geräte* › *Neue Sensoren* › *Annehmen* (English: *Sensors* › *New sensors* › *Approve*). Sensors set up via
   USB are usually accepted automatically.

Repeat for every stick. Give each sensor the machine's name in the web interface.

Check: the sensor shows as online in the web interface; tapping the stick firmly a few
times on the desk produces strokes (sensitivity permitting).

## 5. Mount it and check the count

- Fasten the stick on the outside of the machine body on a part that moves with the
  stroke (magnet, adhesive pad or cable tie) and power it with a USB-C power supply.
- Let the machine run and compare Foriq's count with a reference: the machine's own
  counter, or 50–100 strokes counted by hand.
- Count off? Continue with [tune-detector.md](tune-detector.md) (interview, stroke
  period and sensitivity, only then code).

Done for most users. Tell them where things are: web interface `http://foriq.local:8420`
(bookmark it, also on phones and other computers in the same network), Foriq window via
the Dock or menu bar icon, daily automatic backup (*Jetzt sichern* / *Back up now*).

## 6. Change Foriq (own variant)

The user wants a different counting behaviour, other hardware or an own build.

1. Tools for building (ask first, each is a one-time install):
   - Homebrew – the user runs this line in their own Terminal (it asks for the Mac
     password):
     `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
     and afterwards the two `eval` lines Homebrew prints at the end.
   - Then you run: `brew install node python@3.13 platformio postgresql@18`
2. Make the change with them:
   - counting behaviour → [tune-detector.md](tune-detector.md)
   - other ESP32 board or accelerometer → [port-hardware.md](port-hardware.md)
   - anything else → `CLAUDE.md` and `docs/` describe the code.
3. Build and install: `./build-app.sh` (checks the tools, builds firmware, web
   interface, backend and app, replaces `/Applications/Foriq.app`, keeps all data; the
   first build takes several minutes). After a firmware change raise
   `firmware-cpp/VERSION` first – sensors only install a newer version.
4. Keep their changes: if they cloned with git, commit them (`./ship.sh` pushes to
   *their own* fork; this repository only accepts pull requests).

## 7. Updates and problems

- **Update Foriq:** the Foriq window shows a new version once a day; the user clicks
  *Aktualisieren* / *Update* and Foriq restarts with it (data stays). By hand: quit
  Foriq (menu bar icon › *Foriq beenden* / *Quit Foriq*), then
  `FORIQ_ASSUME_YES=1 bash -c "$(curl -fsSL https://foriq.de/install)"` after the user
  agreed to replace the app. Sensors with auto-update fetch the new firmware afterwards.
- **Port 8420 in use:** another Foriq or program uses it; find it with
  `lsof -iTCP:8420 -sTCP:LISTEN`.
- **Sensor does not appear:** Wi-Fi is 2.4 GHz? Mac and sensor in the same network?
  Firewall allowed? The stick opens **Foriq-Setup** again only after a fresh set-up via
  USB.
- **Forgot the password:** Foriq window › *Passwort vergessen*.
- **Logs:** Foriq window › *Logs*, or `~/Library/Application Support/Foriq/logs/`.
- Data, database and backups: `~/Library/Application Support/Foriq/` – never delete
  `secrets.json` (all sensors would need a new set-up).

Still stuck: help them write an issue at https://github.com/sschaefer-esn/foriq/issues
(what they did, what they expected, what happened, log excerpt without personal data).
