# Commercial app — going live (OAuth + Stripe)

The commercial app (`npm run saas`) works out of the box with **email + password** and a
**dev "simulate purchase."** To turn on real social sign-in and real payments, set the
environment variables below and restart. Nothing else changes — the flows are already built.

Set these wherever the app runs (locally: `KEY=value npm run saas`; on a host: its env/secrets).

## Stripe (payments)

1. Create a [Stripe account](https://dashboard.stripe.com) and stay in **Test mode** first.
2. Get your **Secret key** (Developers → API keys): `sk_test_…`.
3. Add a **webhook** (Developers → Webhooks) pointing at `https://<your-saas-host>/api/stripe/webhook`,
   subscribed to **`checkout.session.completed`**. Copy its **Signing secret**: `whsec_…`.

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SESSION_PRICE_CENTS=2900      # optional, default $29.00
SESSION_CURRENCY=usd          # optional
```

With `STRIPE_SECRET_KEY` set, **Buy** opens Stripe Checkout; on payment, Stripe calls the
webhook and the session flips to **active**. Without it, the dev simulate-purchase is used.
Test card: `4242 4242 4242 4242`, any future date/CVC. Switch to live keys when ready.

## Google sign-in

1. [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
   → **Create OAuth client ID** → **Web application**.
2. **Authorized redirect URI:** `https://<your-saas-host>/api/auth/oauth/google/callback`
   (and `http://localhost:8090/api/auth/oauth/google/callback` for local testing).

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

## Facebook sign-in

1. [Meta for Developers](https://developers.facebook.com) → create an app → add **Facebook Login**.
2. **Valid OAuth Redirect URI:** `https://<your-saas-host>/api/auth/oauth/facebook/callback`.

```
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
```

## Apple sign-in

The most involved. In your [Apple Developer](https://developer.apple.com) account:

1. Register an **App ID** and enable **Sign in with Apple**.
2. Create a **Services ID** (this is your `APPLE_CLIENT_ID`) and set its return URL to
   `https://<your-saas-host>/api/auth/oauth/apple/callback` (Apple requires HTTPS — no localhost).
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
  behind a proxy (`x-forwarded-proto`).
- Sessions are stateless signed cookies — no session store to run.
- Data lives under `SAAS_DATA` (default `./saas-data`); point it at a persistent disk in the
  cloud, same as the booth's `/data`.
