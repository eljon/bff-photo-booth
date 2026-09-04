'use strict';

/**
 * Entry point for the commercial (multi-tenant) web app — landing, accounts, dashboard,
 * and payments. Separate from the single-tenant booth: run it with `npm run saas`.
 *
 *   PORT=8090 npm run saas
 *   STRIPE_SECRET_KEY=… npm run saas      # live payments (else dev "simulate purchase")
 *   BOOTH_ORIGIN=https://your-booth.onrender.com npm run saas   # where a session's host lives
 */

const http = require('node:http');
const { createApp } = require('./commercial/app');
const build = require('./version');

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';

const app = createApp();
const server = http.createServer(app);

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  Hawak Mo ang Booth (temporary name) · accounts  v${build.label}`);
  console.log(`  ---------------------------------------------`);
  console.log(`  Landing:    http://localhost:${PORT}/`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`  Payments:   ${process.env.STRIPE_SECRET_KEY ? 'Stripe (live keys set)' : 'dev — simulate purchase (set STRIPE_SECRET_KEY for real)'}`);
  console.log('');
});

module.exports = { server, app };
