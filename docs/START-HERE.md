# Start here

A step-by-step guide for setting up the photo booth, written for someone who
has never used the Terminal. Follow it in order. It takes about 20 minutes, and
most of that is waiting for downloads.

**What you are building:** your MacBook runs the booth and holds the printer.
Guests use their own phones — they scan a QR code, pick four photos, tap Print,
and the photo comes out of your printer. They install nothing and can be on any
network, even mobile data.

**You need:** the MacBook, a printer already working with it, and about 20
minutes. Do this the day before the party, not an hour before.

---

## Step 1 · Make sure the printer works

Before anything else, prove the printer works on its own.

1. Open  ▸ **System Settings** ▸ **Printers & Scanners**.
2. Your printer should be listed. If it is not, click **Add Printer** and follow
   the prompts.
3. Open any photo in the **Preview** app, press **⌘P**, and print it.

**If Preview can print, the booth can print.** If it cannot, stop and fix that
first — nothing below will help.

---

## Step 2 · Open the Terminal

The Terminal is a window where you type commands instead of clicking buttons.

1. Press **⌘ + Space**. A search box appears.
2. Type `terminal` and press **Return**.
3. A window opens with white or black text, ending in a line like:

   ```
   eljon@Eljons-MacBook-Pro ~ %
   ```

That last line is the **prompt**. It means the Terminal is waiting for you.

**Three things to know, and then you know enough:**

- **To run a command:** copy it from this page, click into the Terminal window,
  press **⌘V** to paste, then press **Return**.
- **Wait for the prompt.** After a command finishes, the `%` line comes back.
  Do not paste the next command until you see it.
- **To stop something:** hold **Control** and press **C**. You will use this to
  shut the booth down. It is Control, not Command.

Nothing you paste below can damage your Mac. Everything lands in your Downloads
folder, apart from one small program in Step 3.

---

## Step 3 · Install the one thing that lets guests connect

Guests need to reach your Mac from their phones, even on mobile data. A small
free program from Cloudflare does that. Paste this whole block at once:

```bash
cd ~/Downloads
ARCH=$(uname -m | grep -q arm64 && echo arm64 || echo amd64)
curl -L -o cloudflared.tgz "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$ARCH.tgz"
tar -xzf cloudflared.tgz
sudo mkdir -p /usr/local/bin
sudo mv cloudflared /usr/local/bin/
cloudflared --version
```

**What happens:**

- A progress bar runs for a few seconds — that is a 19 MB download.
- It asks for a **Password**. That is your Mac login password. **Nothing appears
  as you type — no dots, no stars.** That is normal. Type it and press Return.
- The last line prints something like `cloudflared version 2026.8.0`. That means
  it worked.

---

## Step 4 · Download the booth

```bash
cd ~/Downloads
git clone https://github.com/eljon/bff-photo-booth.git
cd bff-photo-booth
```

**If a window pops up saying "The git command requires the command line
developer tools":** click **Install** and wait — it takes a few minutes. When it
finishes, paste the three lines above again.

You now have a **bff-photo-booth** folder in Downloads, and the Terminal is
"inside" it. The prompt changes to show that:

```
eljon@Eljons-MacBook-Pro bff-photo-booth %
```

---

## Step 5 · Practice run — no paper used

Let us make a photo strip without printing anything, so you know what guests
will see.

```bash
npm run dev
```

The Terminal prints something like this and then **stays open**:

```
  BFF Photo Booth
  ---------------
  On this Wi-Fi only:   http://192.168.1.42:8080
  Host screen:          http://192.168.1.42:8080/host

  Guests must be on the same Wi-Fi as this Mac.
  To let them join from anywhere — mobile data, another network —
  stop this with Control-C and run:  npm run tunnel
  DRY_RUN=1 — composites are saved but never sent to a printer.
```

Your numbers will be different. That is fine.

**"On this Wi-Fi only" means what it says.** This practice address works from
this Mac and from phones on your home Wi-Fi, and nowhere else. That is fine for
a rehearsal — the address guests actually use comes in Step 6, and it works from
any network.

Now open the booth:

1. Open **Safari on the Mac** and go to the **"On this Wi-Fi only"** address —
   in the example above, `http://192.168.1.42:8080`. Type it exactly, including
   the `:8080`.
2. Click **Add photos from your phone** and choose any four pictures.
3. They fill the four slots and a preview of the print appears at the top.
4. Click **Print my strip**. It says **"Saved (dry run)"** — correct, this is a
   practice run and nothing was sent to the printer.

Now check the file it made:

1. Open **Finder** ▸ **Downloads** ▸ **bff-photo-booth** ▸ **prints**.
2. There is a `.png` file in there. Double-click it. That is exactly what would
   have come out of the printer.

**Then stop the practice booth:** click the Terminal window, hold **Control**
and press **C**. The prompt comes back.

> Want to try it from your phone too? For the practice run your phone has to be
> on the same Wi-Fi as the Mac — that is the whole point of the "on this Wi-Fi
> only" label. Type that same address into Safari on the phone.

---

## Step 6 · Start the real booth

```bash
caffeinate -dims npm run tunnel
```

(`caffeinate` stops the Mac falling asleep and killing the booth.)

Wait about 10 seconds. The Terminal prints:

```
  BFF Photo Booth
  ---------------
  Guests scan or type:  https://amber-forest-9241.trycloudflare.com/?k=mo0YlOfR2eWB   <- works on any network
  On this Wi-Fi only:   http://192.168.1.42:8080/?k=mo0YlOfR2eWB
  Host screen:          https://amber-forest-9241.trycloudflare.com/host

  This booth is public. Host screen password:  UbNgjvaR_YVffwFd
  (generated for you — set BOOTH_TOKEN to choose your own)
```

**Now** there is an address guests can use. The `https://` one works from any
network — mobile data, the neighbour's Wi-Fi, anywhere. The `http://192.168…`
line below it is the same booth seen from your own Wi-Fi; guests elsewhere
cannot reach it, and you do not need it.

**Leave this window open for the whole party.** Closing it, or closing the
laptop lid, shuts the booth down.

Two lines matter:

- **Host screen** — the page you control the booth from.
- **Host screen password** — you need it once, in the next step.

---

## Step 7 · Set up your control page

1. In Safari on the Mac, go to the **Host screen** address from Step 6 (the one
   ending in `/host`).
2. It asks for a password. Copy the **Host screen password** line from the
   Terminal, paste it, click **Unlock**.
3. Set these, then click **Save settings**:
   - **Destination** — your printer.
   - **Paper** — `4×6 in` for photo paper. Match what is actually loaded.
   - **Booth name** — what gets printed along the bottom of every strip.
4. Leave everything else as it is for now.

The page now shows a **big QR code**. That is the booth.

---

## Step 8 · Let guests in

Show them the QR code — on the laptop screen, or take a photo of it and put it
on a table card.

A guest just: opens their phone **Camera** app, points it at the QR code, taps
the link that appears, picks four photos, taps **Print my strip**. The print
comes out of your printer. They install nothing, type nothing, and can be on any
network.

That is the whole thing. You are running a photo booth.

---

## While the party runs

Everything is on the **Host screen** page. Three switches are worth knowing:

| When | Do this |
| --- | --- |
| Paper is running low | Turn on **Ask me before each print**. Nothing prints until you tap Print on each one. |
| Printer jams or runs out | Turn **Printing is on** off, click Save. Guests are told to save to their phone instead of getting errors. Turn it back on when you have reloaded. |
| Someone posts the QR code online | Click **New guest link**. The old QR stops working — show the new one. |

The same page shows everything printed tonight under **Recent strips**, and
anything stuck under **Printer queue**.

---

## Ending the night

1. Click the Terminal window, hold **Control**, press **C**.
2. Every photo strip from the night is in **Finder ▸ Downloads ▸
   bff-photo-booth ▸ prints**. Copy that folder somewhere safe.

**Next time**, you only need two commands:

```bash
cd ~/Downloads/bff-photo-booth
caffeinate -dims npm run tunnel
```

The guest link and password are **new every time you start it**, so print the QR
code fresh, or read `docs/DEPLOY.md` for a permanent link.

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `command not found: npm` | Node is not installed. Get it from [nodejs.org](https://nodejs.org), then start again at Step 4. |
| A popup about "command line developer tools" | Click **Install**, wait, then paste the command again. |
| `Tunnel unavailable` | Step 3 did not finish. Run `cloudflared --version` — if that fails, do Step 3 again. |
| Guests get "Scan the booth QR code" | They opened a plain link instead of scanning. Have them scan the QR itself. |
| The host page will not take the password | Copy the **whole** line after `Host screen password:`, with no spaces at the ends. |
| Host page says no printer found | Go back to Step 1. If Preview cannot print, the booth cannot either. |
| It printed, but nothing came out | Check the printer itself — paper, ink, lid. Look at **Printer queue** on the host page. |
| The Terminal window closed by accident | The booth stopped. Run the two "next time" commands above. The link will be new. |
