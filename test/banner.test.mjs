import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, until } from './helpers.mjs';

const bannerOf = async (booth) => until(async () => (booth.banner().includes('Host screen') ? booth.banner() : null));

test('a Wi-Fi-only booth never advertises its LAN address as the guest link', async (t) => {
  const booth = await startServer(); // no tunnel, no PUBLIC_URL
  t.after(() => booth.close());
  const banner = await bannerOf(booth);

  assert.match(banner, /On this Wi-Fi only:\s+http:\/\//);
  assert.doesNotMatch(banner, /Guests scan or type/,
    'a LAN address must not be labelled as the address guests use — they cannot reach it from another network');
  assert.match(banner, /same Wi-Fi as this Mac/);
  assert.match(banner, /npm run tunnel/, 'it should say how to let guests join from anywhere');
});

test('a public booth labels which address reaches guests and which does not', async (t) => {
  const booth = await startServer({ PUBLIC_URL: 'https://amber-forest-9241.trycloudflare.com' });
  t.after(() => booth.close());
  const banner = await bannerOf(booth);

  assert.match(banner, /Guests scan or type:\s+https:\/\/amber-forest-9241\.trycloudflare\.com\/\?k=\S+\s+<- works on any network/);
  assert.match(banner, /On this Wi-Fi only:\s+http:\/\//, 'the LAN address is still shown, but demoted');
  assert.match(banner, /Host screen:\s+https:\/\/amber-forest-9241\.trycloudflare\.com\/host/);
  assert.doesNotMatch(banner, /same Wi-Fi as this Mac/, 'no need to warn — guests can be anywhere');
  assert.doesNotMatch(banner, /password:/i, 'the host screen is open unless BOOTH_TOKEN is set');
  assert.match(banner, /Host screen is open to anyone with that link/);
});

test('the running version is reported everywhere a human or a monitor looks', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const { createRequire } = await import('node:module');
  const expected = createRequire(import.meta.url)('../package.json').version;

  const health = await (await fetch(`${booth.base}/api/health`)).json();
  assert.equal(health.version, expected, '/api/health should report the version');

  const session = await (await fetch(`${booth.base}/api/session`)).json();
  assert.equal(session.version, expected, 'the guest app reads its version from here');

  const settings = await (await fetch(`${booth.base}/api/config`)).json();
  assert.equal(settings.version, expected, 'the host screen reads its version from here');

  const banner = await until(async () => (booth.banner().includes('Host screen') ? booth.banner() : null));
  assert.match(banner, new RegExp(`v${expected.replace(/\./g, '\\.')}`), 'the startup banner should show it too');
});

test('the changelog documents the version that is running', async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const version = createRequire(import.meta.url)('../package.json').version;
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

  assert.match(changelog, new RegExp(`^## ${version.replace(/\./g, '\\.')} — `, 'm'),
    `CHANGELOG.md has no entry for ${version} — bump one or the other`);
  assert.match(changelog, /npm run update/, 'the changelog should say how to update');
});
