# A guest link that stays the same

`npm run tunnel` hands out a throwaway address: it changes every time the booth
restarts, and it dies when the Mac sleeps. That is fine for one evening, but it
means you cannot print the QR code in advance, and a closed lid costs you a new
link.

Here are the ways to get an address that stays put, cheapest effort first.

| | Link survives a restart | Works while the Mac sleeps | Setup |
| --- | --- | --- | --- |
| Quick tunnel *(default)* | no | no | none |
| **ngrok static domain** | **yes** | no | free account, 5 min |
| **Tailscale funnel** | **yes** | no | free account, 10 min |
| **Named Cloudflare tunnel** | **yes** | no | account + a domain you own |
| **Relay** | **yes** | **yes** | deploy once, see `DEPLOY.md` |

"Works while the Mac sleeps" is the row that matters if guests might scan the
code while the booth is shut. Only the relay keeps serving then: it holds the
page and parks prints, and the Mac prints them when it wakes. With every other
option the address stays valid, but a sleeping Mac means an error page until it
wakes — the QR code itself never needs replacing.

Whichever you pick, the booth now restarts its own tunnel if it drops, so waking
the Mac brings the booth back without touching the terminal.

---

## ngrok static domain — easiest persistent link

One free static domain per account.

1. Make a free account at ngrok.com, then **Domains ▸ Create Domain**. You get
   something like `bff-booth.ngrok-free.app`.
2. On the Mac:

   ```bash
   brew install ngrok            # or download from ngrok.com/download
   ngrok config add-authtoken <the token from your dashboard>
   ```

3. Start the booth with that domain:

   ```bash
   cd ~/Downloads/bff-photo-booth
   NGROK_DOMAIN=bff-booth.ngrok-free.app caffeinate -dims npm run tunnel
   ```

The banner says `ngrok (persistent domain)` and the guest link is the same every
night. Print the QR once.

To avoid retyping it, put the domain in your shell profile:

```bash
echo 'export NGROK_DOMAIN=bff-booth.ngrok-free.app' >> ~/.zshrc
```

## Tailscale funnel — no domain, tied to the machine

Gives you `https://<machine>.<tailnet>.ts.net`, permanent and free.

1. Install Tailscale and sign in.
2. Enable funnel for your tailnet once (the CLI prints a link to click).
3. Start the booth:

   ```bash
   caffeinate -dims npm start -- --tunnel=tailscale
   ```

## Named Cloudflare tunnel — your own hostname

If you own a domain on Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create booth
cloudflared tunnel route dns booth booth.yourdomain.com

CF_TUNNEL=booth TUNNEL_HOSTNAME=booth.yourdomain.com \
  caffeinate -dims npm run tunnel
```

The booth refuses to start a named tunnel without `TUNNEL_HOSTNAME` — it will
not guess an address it would then print on a QR code.

## Relay — the link works even with the lid shut

The full split: the guest half runs on a small server you deploy once, and the
Mac runs an agent that only makes outbound calls. Guests can build and submit
prints while the Mac is asleep; the agent collects and prints them when it wakes.

See **[DEPLOY.md](DEPLOY.md)**. It is the most setup and the only one that is
genuinely independent of the Mac being awake.

---

## What happens when the Mac sleeps

- **The tunnel drops.** macOS cuts network connections on sleep.
- **On wake**, the booth notices the tunnel process died and restarts it, with a
  short backoff. You do not have to touch anything.
- **With a persistent address** the same link comes straight back — anything
  printed or shared keeps working.
- **With the default quick tunnel** you get a *new* link, and the terminal says
  so. Reopen the host screen for the new QR code.
- **In relay mode** guests never notice: the relay was serving the whole time.

To reduce sleeping in the first place, `caffeinate -dims` (already in the
recommended command) keeps the Mac awake while the booth runs — but it cannot
stop you closing the lid.
