# Production setup — OAuth + Stripe (do this once)

This guide configures **Google, Facebook, Stripe (and Apple, optional) for real production
use** against `https://boothless.alphanauts.net`, so you set each provider up **once** and never
have to redo it. Everything is registered in *live / published* mode, not test/dev sandboxes.

The code is already built — turning a provider on is purely setting its environment variables on
the Render service and (for the OAuth ones) registering the callback URL in the provider's
console. Nothing in the app changes.

> **Do all four consoles with production values now**, even if DNS for the custom domain isn't
> green yet. Where a step needs a live URL that isn't reachable until DNS is up, this guide says
> so and gives you the one temporary move (a second URL) that avoids ever coming back.

---

## 0. The master environment-variable list (Render)

Set these on the Render service (**Environment → Add Environment Variable → Save**, which
redeploys). This is the whole production set in one place:

```
# ── App / hosting ────────────────────────────────────────────────
SAAS_DATA=/data                          # persistent disk mount (accounts, booths, session secret)
SAAS_BASE_DOMAIN=boothless.alphanauts.net   # enables per-session subdomains; set once DNS is green

# ── Stripe (LIVE) ────────────────────────────────────────────────
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SESSION_PRICE_CENTS=2900                  # optional — $29.00 default
SESSION_CURRENCY=usd                      # optional

# ── Google ───────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...

# ── Facebook ─────────────────────────────────────────────────────
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...

# ── Apple (optional — needs the $99/yr Apple Developer Program) ───
# APPLE_CLIENT_ID=net.alphanauts.boothless.web
# APPLE_TEAM_ID=XXXXXXXXXX
# APPLE_KEY_ID=YYYYYYYYYY
# APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

**Session persistence (production must-know):** the cookie-signing secret is generated once and
stored on the `/data` disk (`store.js`). It survives redeploys automatically — but if you ever
delete/recreate the disk, every user is logged out and pending state is lost. Treat `/data` as
production data: keep it attached, and back it up before any risky change.

---

## The one rule for every OAuth provider

The app builds each provider's redirect URI from **the host the user is on** (`originOf(req)`),
so the callback URL you register must match the host they sign in from. Production is
`boothless.alphanauts.net`. To be "set once" and never edit the consoles again, register **both**
of these in each provider — the custom domain (production) and the Render URL (works before DNS,
and as a permanent fallback):

```
https://boothless.alphanauts.net/api/auth/oauth/<provider>/callback
https://hawak-mo-ang-booth.onrender.com/api/auth/oauth/<provider>/callback
```

Callback paths per provider: `/api/auth/oauth/google/callback`,
`/api/auth/oauth/facebook/callback`, `/api/auth/oauth/apple/callback`.

---

## 1. Stripe — LIVE payments

1. **Activate the account.** [dashboard.stripe.com](https://dashboard.stripe.com) → complete
   **business details + bank account** (Settings → Business / Payouts). Live keys don't work
   until the account is activated. Set a **statement descriptor** (what shows on customers'
   card statements) under Settings → Business.
2. Switch the dashboard to **Live mode** (top-right toggle OFF of "Test mode").
3. **Developers → API keys** → copy the **live Secret key**: `sk_live_…` → Render
   `STRIPE_SECRET_KEY`.
4. **Developers → Webhooks → Add endpoint** (this is a *live-mode* endpoint, separate from any
   test one):
   - **URL:** `https://boothless.alphanauts.net/api/stripe/webhook`
   - **Event:** `checkout.session.completed`
   - Save, then copy its **Signing secret** `whsec_…` → Render `STRIPE_WEBHOOK_SECRET`.
   - *Editing an endpoint's URL later keeps the same signing secret*, so if you want to test
     payments **before** DNS is live, temporarily set this endpoint's URL to the
     `hawak-mo-ang-booth.onrender.com` one, then edit it back to the custom domain when DNS is
     green — `STRIPE_WEBHOOK_SECRET` never changes.
5. **Go-live checks:** confirm the payment methods you want are enabled (Settings → Payment
   methods), and that the price (`SESSION_PRICE_CENTS`) and currency are what you'll charge.

With `STRIPE_SECRET_KEY` set, **Buy** opens Stripe Checkout; on payment Stripe calls the webhook
and the session flips to active. Verify one real (small) transaction end-to-end after go-live.

---

## 2. Google — published (production) sign-in

1. [Google Cloud Console](https://console.cloud.google.com) → create/pick a project.
2. **APIs & Services → OAuth consent screen → External.** Fill in:
   - App name: `Hawak Mo ang Booth`
   - User support email + Developer contact email
   - **Authorized domain:** `alphanauts.net`
   - **App privacy policy URL** and **Terms of service URL** (host them on your site — required
     for a clean production listing).
   - **Scopes:** keep only the defaults — `email`, `profile`, `openid`. These are
     **non-sensitive**, so publishing needs **no Google review**.
   - **Publishing status → Publish app → "In production."** This removes the 100-test-user cap
     and lets anyone sign in.
   > ⚠️ **Don't upload an app logo unless you're ready for verification** — adding a logo (or any
   > sensitive scope) triggers Google's brand-verification review, which can take days. Text-only
   > branding with minimal scopes publishes instantly.
3. **Credentials → Create Credentials → OAuth client ID → Web application.**
   - **Authorized redirect URIs** — add both:
     ```
     https://boothless.alphanauts.net/api/auth/oauth/google/callback
     https://hawak-mo-ang-booth.onrender.com/api/auth/oauth/google/callback
     ```
4. Copy **Client ID** + **Client secret** → Render `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

---

## 3. Facebook — Live app

1. [Meta for Developers](https://developers.facebook.com) → **My Apps → Create App** → use case
   **"Authenticate and request data from users with Facebook Login"**. Add the **Facebook Login**
   product.
2. **App settings → Basic:**
   - **App Domains:** `boothless.alphanauts.net`
   - **Privacy Policy URL** (required to go Live) and, recommended, **Terms of Service URL**.
   - **Category** and **App Icon** (required to go Live).
   - **Data Deletion:** set a **Data Deletion Instructions URL** (a public page saying how a user
     requests deletion, e.g. "email support@alphanauts.net"). Meta requires this for Live apps.
   - Copy **App ID** + **App Secret** → Render `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`.
3. **Facebook Login → Settings → Valid OAuth Redirect URIs** — add both:
   ```
   https://boothless.alphanauts.net/api/auth/oauth/facebook/callback
   https://hawak-mo-ang-booth.onrender.com/api/auth/oauth/facebook/callback
   ```
4. **Permissions:** the app uses `public_profile` and `email`. Under **App Review → Permissions
   and Features**, ensure both have **Advanced Access** (these two standard permissions are
   normally granted immediately — no full App Review submission needed).
5. **Flip the app to Live** (toggle at the top of the dashboard). In Development mode only people
   with a role on the app can sign in; Live opens it to the public. Complete the periodic **Data
   Use Checkup** when Meta prompts, or logins get suspended.

---

## 4. Apple — Sign in with Apple (optional, when you enroll)

Apple sign-in needs the **paid Apple Developer Program ($99/year)**. It's fully wired in the
code; its button shows "soon" until the keys are set. Add it later with **no code change** —
just set the env vars. Full production steps for when you enroll:

1. **Certificates, Identifiers & Profiles → Identifiers → App ID** → enable **Sign in with Apple**.
2. Create a **Services ID** (e.g. `net.alphanauts.boothless.web`) — this is `APPLE_CLIENT_ID`.
   Configure it for Sign in with Apple:
   - **Domains:** `boothless.alphanauts.net`
   - **Return URLs:** `https://boothless.alphanauts.net/api/auth/oauth/apple/callback`
     (Apple requires HTTPS on a real, verified domain — do this after DNS is green.)
3. **Keys → +** → enable **Sign in with Apple** → download the **`.p8`**. Note the **Key ID**
   and your **Team ID**.
4. Render:
   ```
   APPLE_CLIENT_ID=net.alphanauts.boothless.web   # the Services ID
   APPLE_TEAM_ID=XXXXXXXXXX
   APPLE_KEY_ID=YYYYYYYYYY
   APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
   ```
   (The app signs Apple's required ES256 client secret from the `.p8` automatically. Use `\n`
   for newlines since Render stores the value on one line.)

---

## 5. Verify production

1. After each provider's env vars are saved, reload `https://boothless.alphanauts.net` — the
   configured buttons lose their "soon" tag. `GET /api/me` returns
   `providers: { google, apple, facebook }` (true/false) to confirm.
2. Sign in with Google and with Facebook on the **production domain** (not onrender) once DNS is
   green — confirm the redirect returns you signed in.
3. Buy a session with a **real card** (small amount) → confirm Stripe Checkout completes, the
   webhook fires (Stripe → Webhooks → your endpoint shows a 200), and the session flips to active.
4. Open the session's host → it should land on `https://<slug>.boothless.alphanauts.net/host`.

---

## Notes

- **Exact-match redirect URIs.** Every provider matches the callback URL character-for-character
  (scheme + host + path). Register both hosts (done above) and you never edit the consoles again.
- Render already sets `x-forwarded-proto`, so the app knows it's HTTPS behind the proxy.
- Sessions are stateless signed cookies — no session store to run; the signing secret lives on
  `/data` (see §0).
- Keep every secret **in Render's environment only** — never commit keys to the repo, even now
  that it's private.
