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
  assert.match(banner, /Host screen password:\s+\S+/);
});
