# Booth run-book

Everything you need on the night, in the order you need it.

---

## 0. Which mode are you running?

| Situation | Mode | Command |
| --- | --- | --- |
| Everyone is on the same Wi-Fi as the Mac | **LAN** | `npm start` |
| Guests are anywhere; you want zero setup | **Tunnel** | `npm run tunnel` |
| Guests are anywhere; you want a link that never changes | **Relay** | `npm run relay` + `npm run agent` |

If you are printing the QR code onto a sign, table card, or invitation, you need
**relay** — the tunnel link changes every time you restart.

---

## 1. One-time setup (any mode)

**On the MacBook that holds the printer:**

```bash
git clone https://github.com/eljon/bff-photo-booth.git
cd bff-photo-booth
node -v            # need 18 or newer; `brew install node` if missing
npm run printers   # should list your printer
```

Add the printer first in **System Settings ▸ Printers & Scanners** and print a
test page from Preview. If Preview can print, so can the booth.

**Rehearse without wasting paper:**

```bash
npm run dev        # builds real strips into ./prints, never prints
```

Open the address it prints, make a strip on your own phone, confirm the file
appears in `./prints/`. Ctrl-C when you are happy.

---

## 2. Launch

### LAN mode

```bash
caffeinate -dims npm start
```

macOS will ask whether `node` may accept incoming connections — **say yes**, or
phones cannot reach it. Guests must join the same Wi-Fi.

### Tunnel mode

```bash
brew install cloudflared     # once, no account needed
caffeinate -dims npm run tunnel
```

Wait for the `https://…trycloudflare.com` line, then open `/host` and show the
QR. Guests can be on cellular or any network. If the tunnel drops, restart and
show the new QR — the link changes.

### Relay mode

**Once,** on the public host (see `docs/DEPLOY.md` for Fly, Render, Docker):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # BOOTH_TOKEN
node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))" # ACCESS_KEY
```

Set both on the relay and keep them. `ACCESS_KEY` is what makes the QR code
stable — pin it and any sign you print keeps working forever.

**Every party,** on the MacBook:

```bash
RELAY_URL=https://your-booth.example.com \
BOOTH_TOKEN=<the token> \
caffeinate -dims npm run agent
```

The agent prints its printers on startup and then waits. It only makes outbound
calls, so no firewall prompt and no port forwarding. Leave the window open.

---

## 3. Set up the host screen

Open `/host` on the Mac and leave it up. On a public booth it asks for
`BOOTH_TOKEN` once.

Set these, then **Save settings**:

| Setting | Pick |
| --- | --- |
| Destination | Your photo printer (in relay mode: the ones the Mac reported) |
| Paper | `4×6 in` for photo printers, `2×6 in` for strip stock, `Letter`/`A4` for plain |
| Scale to fill the sheet | Leave on; off if a borderless printer leaves a white edge |
| Printing is on | Off = download-only; guests still build and save strips |
| Ask me before each print | Off to start |
| Max copies per guest | 2–3 |
| Booth name / welcome line | Shows on phones **and** on the printed footer |

Check the pills at the top: mode (`local Wi-Fi` / `public` / `relay`) and, in
relay mode, **booth mac: connected**. If it says *booth mac offline*, the agent
is not running — nothing will print.

---

## 4. Running the party

Point guests at the QR code. They scan, pick 4 photos, tap Print. Nothing to
install, nothing to type.

**Watch the host screen:**

- **Waiting for you** — jobs held for approval. Tap **Print** to release,
  **Skip** to bin it.
- **Printer queue** — jobs on their way plus live CUPS jobs, each with
  **Cancel**. Failures show the reason.
- **Recent strips** — everything printed tonight; click to open full size.

**Turn on "Ask me before each print"** once it gets busy — that is how you
protect a limited stack of paper.

**If the printer jams or runs out:** switch *Printing is on* off and Save.
Guests are told to save to their phone instead of getting errors. Switch it back
when you have reloaded.

**If the guest link leaks** (someone posts the QR photo online): tap **New guest
link** on the host screen. Old QR codes stop working immediately; show the new
one. *(Not available when `ACCESS_KEY` is pinned by the environment — change it
on the relay instead.)*

Built in, nothing to manage: 30 prints per phone per 10 minutes, the copy cap is
enforced on the server, and a job claimed by a Mac that goes to sleep returns to
the queue after two minutes.

---

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Phones cannot load the page (LAN) | Wrong Wi-Fi, or the firewall prompt was dismissed. Check a phone can load the exact address from the banner. |
| Phones cannot load the page (tunnel) | The tunnel died. Restart `npm run tunnel` and show the new QR. |
| Guest sees "Scan the booth QR code" | They opened a bare link without the key. Have them scan the QR again. |
| Host screen says **booth mac offline** | The agent is not running, or lost the network. Restart `npm run agent` on the Mac. |
| Host screen says no printer | Not added in System Settings, or CUPS is asleep. `npm run printers`; re-add if empty. |
| Queued but nothing comes out | Check the printer itself — paper, ink, lid. `cancel -a` on the Mac clears a stuck queue. |
| Print is cropped or has a white margin | Toggle *Scale to fill the sheet*; check Paper matches what is actually loaded. |
| Guest's photos will not load | Very old phone. They can still tap **Save** and AirDrop the strip to you. |
| Everything is slow on cellular | Normal for the first upload. Pages over 3 MB are sent as JPEG automatically. |

---

## 6. After the party

Every strip is in `./prints/` on whichever machine composed it — the Mac in LAN
and tunnel mode, the relay's `/data/prints` in relay mode (the Mac's agent keeps
its own copy of everything it printed). Copy the folder somewhere before you
tear anything down. Ctrl-C to stop.

---

## Environment quick reference

| Variable | Where | Purpose |
| --- | --- | --- |
| `BOOTH_TOKEN` | relay + agent | Host password and agent sign-in. Required in relay mode |
| `ACCESS_KEY` | relay | Pins the guest QR key across restarts |
| `RELAY_URL` | agent | Which relay to poll |
| `PUBLIC_URL` | relay | Force the address shown in the QR (behind your own proxy) |
| `BOOTH_NAME` | relay | Booth name, pinned |
| `PORT` / `HOST` | any | Where to listen (default `8080` / `0.0.0.0`) |
| `DRY_RUN=1` | any | Build strips, never print |
| `PRINTS_DIR` | any | Where composed prints are written |
| `AGENT_NAME` | agent | Label shown on the host screen |
