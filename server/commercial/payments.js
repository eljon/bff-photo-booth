'use strict';

/**
 * Payments for the commercial layer. Stripe Checkout when STRIPE_SECRET_KEY is set;
 * otherwise a dev "simulate purchase" so the buy → session flow is demoable with no
 * account. No Stripe SDK dependency — we call the REST API with fetch, and verify the
 * webhook signature with crypto.
 */

const crypto = require('node:crypto');

const SECRET = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICE_CENTS = Number(process.env.SESSION_PRICE_CENTS) || 599; // $5.99 default
const CURRENCY = process.env.SESSION_CURRENCY || 'usd';

const isLive = () => Boolean(SECRET);

/** Create a Stripe Checkout Session and return its hosted URL. */
async function createCheckout({ sessionId, userEmail, successUrl, cancelUrl }) {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', successUrl);
  form.set('cancel_url', cancelUrl);
  if (userEmail) form.set('customer_email', userEmail);
  // Show the "Add promotion code" field on Stripe Checkout so customers can redeem
  // discount codes (create these as Promotion codes in the Stripe dashboard).
  form.set('allow_promotion_codes', 'true');
  form.set('client_reference_id', sessionId);
  form.set('metadata[sessionId]', sessionId);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', CURRENCY);
  form.set('line_items[0][price_data][unit_amount]', String(PRICE_CENTS));
  form.set('line_items[0][price_data][product_data][name]', 'Photo Booth session');

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/x-www-form-urlencoded',
      // No-cost orders (a 100%-off promotion code that brings the total to $0) require
      // Stripe API version 2023-08-16 or later. Pin it here so free codes redeem even on
      // accounts whose default API version predates that, without changing the account-wide
      // version. https://docs.stripe.com/payments/checkout/no-cost-orders
      'stripe-version': '2023-08-16',
    },
    body: form.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : `Stripe error ${res.status}`);
  return { url: data.url, checkoutId: data.id };
}

/** Verify a Stripe webhook signature (t=…,v1=…) against the raw body. */
function verifyWebhook(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  const signed = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signed).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { isLive, createCheckout, verifyWebhook, PRICE_CENTS, CURRENCY };
