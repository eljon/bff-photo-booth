# Full setup — from zero to guests printing

Three pieces:

- **Relay (cloud)** — always-on, public URL, holds the print queue on disk. You deploy
  this once, from a web browser.
- **Printer computer** — the Mac/PC with the photo printer. It runs the small agent
  (`npm run agent`), which reaches out to the relay and prints the queue.
- **Guests** — scan a QR / open the URL on their phones.

---

## Part 0 — put the code where the host can deploy it

All the server code and `render.yaml` are on the branch
`claude/photo-booth-mobile-app-r3duzq`. A cloud host deploys from a branch, so first get
it onto the branch you'll deploy:

- **Recommended:** open the pull request for that branch on GitHub and **Merge** it into
  your default branch (`main`). Then you deploy `main`, and future pushes auto-deploy.
- **Or:** skip merging and just tell Render (below) to deploy the
  `claude/photo-booth-mobile-app-r3duzq` branch directly.

---

## Part 1 — deploy the relay on Render (browser only, no CLI)

1. Go to **[render.com](https://render.com)** and sign in with GitHub. Authorize access to
   the **`eljon/bff-photo-booth`** repo.
2. **New ▸ Blueprint** → pick `eljon/bff-photo-booth` → choose the branch that has
   `render.yaml` (`main` after merging, or the feature branch) → Render detects the
   blueprint.
3. It will create: a Docker web service **bff-photo-booth**, a **1 GB disk at `/data`**,
   and auto-generated **`BOOTH_TOKEN`** and **`ACCESS_KEY`**. The plan is **Starter**
   (paid, ~US$7/mo) so it stays awake and can hold a disk. Add a payment method and click
   **Apply**.
4. Wait for the first build (a few minutes). When it says **Live**, note the URL, e.g.
   `https://bff-photo-booth.onrender.com`.
5. Open the service → **Environment** tab → copy the value of **`BOOTH_TOKEN`**. Keep it
   safe — it's the printer/host password.
6. Verify: visit `https://<your-url>/api/health` → you should see
   `{"ok":true,"mode":"relay","agentOnline":false,…}`.

---

## Part 2 — connect the printer computer (run the agent)

On the computer with the photo printer:

1. Make sure the printer works from that computer and its paper is set to **4×6
   borderless** (macOS: System Settings ▸ Printers & Scanners).
2. Get the code onto this computer (needs [Node](https://nodejs.org) installed):

   ```bash
   cd ~/Downloads
   git clone https://github.com/eljon/bff-photo-booth.git
   cd bff-photo-booth
   npm install
   ```
3. Start the **agent** — it reaches out to the relay and prints jobs through the
   printer driver (borderless, media, and copies all under its control). Put your
   real `BOOTH_TOKEN` in place of the `…`:

   ```bash
   RELAY_URL=https://<your-url> BOOTH_TOKEN=… npm run agent
   ```

   Leave that Terminal window open. To keep the Mac awake during an event, prefix it
   with `caffeinate -dims`.
4. On the relay, `/api/health` now reports `agentOnline:true`, and the host screen
   shows the computer as **connected**. In `/host`, open **Choose printers**, tick
   your printer, name it, then **Save settings**.

---

## Part 3 — get guests printing

1. Open the **host screen**: `https://<your-url>/host`, enter the `BOOTH_TOKEN`. It shows
   the **guest QR code** and link (already pointed at your real URL).
   - Optional: turn on *require guest key* so only people who scanned the QR can print.
   - Optional: turn on *approval* to OK each print before it's sent.
2. Display/print the QR at the booth. Guests scan → pick 4 photos → tap the check → Print.
3. The print comes out on your printer; the guest sees their place in line.

---

## Part 4 — test it end to end

- On your phone, open the URL, build a layout, tap **Print** → it prints on the booth
  printer.
- **Resilience check:** put the printer computer to sleep, submit a print from your phone
  (it says "Saved to the print queue"), then wake the printer — the queued print comes out.
  That's the durable server queue working.

---

## Costs & notes

- Render **Starter ~US$7/mo** while it's running; suspend or delete the service after the
  event to stop billing.
- The **`/data` disk** keeps the queue, the gallery, and settings across redeploys.
- **HTTPS is automatic** on Render — required for phone camera/photo access.
- The only secret to guard is **`BOOTH_TOKEN`**. `ACCESS_KEY` just pins the guest QR link
  so a redeploy doesn't invalidate QR codes you already printed.

## If something's off

- **Guest sees "booth is offline"** → the agent isn't connected. Start it with
  `npm run agent` on the printer computer. (Prints still queue and come out once it
  connects.)
- **Prints have white borders** → set the printer's default paper to 4×6 borderless, or
  pick the borderless media size in `/host` after the agent connects.
- **QR shows localhost** → you're looking at a local run's host screen, not the relay. Use
  `https://<your-url>/host`.
