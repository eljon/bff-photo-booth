import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const tunnel = createRequire(import.meta.url)('../server/tunnel.js');

test('picks the public URL out of tunnel chatter', () => {
  const cloudflared = `2026-08-24T18:00:00Z INF +------------------------------------+
2026-08-24T18:00:00Z INF |  Your quick Tunnel has been created! Visit it at:                    |
2026-08-24T18:00:00Z INF |  https://shiny-booth-prints.trycloudflare.com                        |
2026-08-24T18:00:00Z INF +------------------------------------+`;
  assert.equal(tunnel.findUrl(cloudflared), 'https://shiny-booth-prints.trycloudflare.com');

  const ngrok = 't=2026-08-24T18:00:00+0000 lvl=info msg="started tunnel" url=https://a1b2c3d4.ngrok-free.app';
  assert.equal(tunnel.findUrl(ngrok), 'https://a1b2c3d4.ngrok-free.app');

  assert.equal(tunnel.findUrl('nothing useful here'), null);
  assert.equal(tunnel.findUrl('http://insecure.trycloudflare.com'), null, 'only https counts');
});

test('reports no URL before a tunnel is opened', () => {
  assert.equal(tunnel.url(), null);
});
