# Commercial app — going live (OAuth + Stripe)

The commercial app (`npm run saas`) works out of the box with **email + password** and a
**dev "simulate purchase."** To turn on real social sign-in and real payments, set the
environment variables below and restart. Nothing else changes — the flows are already built.

**This guide uses the real deployment:** app on Render at
`https://hawak-mo-ang-booth.onrender.com` today, and `https://boothless.alphanauts.net` once
that domain's DNS verifies. Set these on the Render service: **Environment → Add Environment
Variable →** key + value **→ Save Changes** (it redeploys). Locally: `KEY=value npm run saas`.

## The one rule for every OAuth provider: the callback host must match

The app builds each provider's redirect URI from **the host you're browsing on**
(`originOf(req)` in `server/commercial/app.js`), so the callback URL you register in the
provider's console must match the host you actually click "Sign in" from. Because you have two
hosts (the `onrender.com` one now, the custom domain once DNS is green), **register both
callback URLs** in every provider — the onrender one works immediately, the custom-domain one
is ready for later. Log in via the onrender URL until the domain verifies.

The callback paths are always:

```
/api/auth/oauth/google/callback
/api/auth/oauth/facebook/callback
/api/auth/oauth/apple/callback
```

## Stripe (payments)

1. Create a [Stripe account](https://dashboard.stripe.com) and keep **Test mode** ON (top-right
   toggle) while you set this up.
2. **Developers → API keys** → copy the **Secret key**: `sk_test_…`.
3. **Developers → Webhooks → Add endpoint** pointing at
   `https://hawak-mo-ang-booth.onrender.com/api/stripe/webhook`, subscribed to
   **`checkout.session.completed`**. Copy its **Signing secret**: `whsec_…`.

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SESSION_PRICE_CENTS=2900      # optional, default $29.00
SESSION_CURRENCY=usd          # optional
```

With `STRIPE_SECRET_KEY` set, **Buy** opens Stripe Checkout; on payment, Stripe calls the
webhook and the session flips to **active**. Without it, the dev simulate-purchase is used.
Test card: `4242 4242 4242 4242`, any future date/CVC.

**Going live:** flip Stripe to Live mode, grab the `sk_live_…` key, add a **second** webhook
endpoint (live mode has its own — point it at the custom domain), and swap both env values.

## Google sign-in

1. [Google Cloud Console](https://console.cloud.google.com) → create/pick a project.
2. **APIs & Services → OAuth consent screen** → **External** → fill App name
   (`Hawak Mo ang Booth`), support email, developer email. The default `email` / `profile` /
   `openid` scopes are enough — no sensitive scopes, so no Google review needed.
   - While the consent screen is in **"Testing"**, only accounts listed under **Test users**
     can sign in — add your own Gmail there. Hit **Publish app** to open it to everyone (this
     is instant for these non-sensitive scopes).
3. **Credentials → Create Credentials → OAuth client ID → Web application.**
4. **Authorized redirect URIs — add both:**
   ```
   https://hawak-mo-ang-booth.onrender.com/api/auth/oauth/google/callback
   https://boothless.alphanauts.net/api/auth/oauth/google/callback
   ```

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

## Facebook sign-in

1. [Meta for Developers](https://developers.facebook.com) → **My Apps → Create App** → use case
   **"Authenticate and request data from users with Facebook Login"** (Consumer). Add the
   **Facebook Login** product.
2. **Facebook Login → Settings → Valid OAuth Redirect URIs — add both:**
   ```
   https://hawak-mo-ang-booth.onrender.com/api/auth/oauth/facebook/callback
   https://boothless.alphanauts.net/api/auth/oauth/facebook/callback
   ```
3. **Settings → Basic** → copy **App ID** and **App Secret**.

```
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
```

- **Dev vs Live:** while the app is in **Development** mode only people with a role on the app
  (you as admin, or anyone you add as Tester) can log in — fine for testing. To let the public
  in, flip it to **Live**, which requires a Privacy Policy URL in Settings → Basic.

## Apple sign-in (deferred — optional)

Apple sign-in requires the **paid Apple Developer Program ($99/year)**. It's wired up in the
code but left off for now; its button shows "soon" until the keys below are set. Add it later
with **no code change** — just set the env vars.

In your [Apple Developer](https://developer.apple.com) account:

1. Register an **App ID** and enable **Sign in with Apple**.
2. Create a **Services ID** (this is your `APPLE_CLIENT_ID`) and set its return URL to
   `https://boothless.alphanauts.net/api/auth/oauth/apple/callback` (Apple requires HTTPS and a
   real domain — no `onrender.com` isn't rejected, but use the branded domain once it's live).
3. Create a **Sign in with Apple key** (.p8); note the **Key ID** and your **Team ID**.

```
APPLE_CLIENT_ID=com.yourcompany.booth.web   # the Services ID
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_KEY_ID=YYYYYYYYYY
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

(The app signs Apple's required ES256 client secret from the .p8 automatically. Use `\n`
for newlines if your host stores secrets on one line.)

## Which are on?

The landing page shows all four buttons; the unconfigured ones say "soon" until their keys
are present. `GET /api/me` returns `providers: { google, apple, facebook }` (true/false).

## Notes

- Each provider's **redirect URI must match exactly** what you register, including https and
  host. The app derives it from the request host, so set the app's public URL correctly
  behind a proxy (`x-forwarded-proto`) — Render already sets that.
- Sessions are stateless signed cookies — no session store to run.
- Data lives under `SAAS_DATA` (default `./saas-data`); point it at a persistent disk in the
  cloud, same as the booth's `/data`.
