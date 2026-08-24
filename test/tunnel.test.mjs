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

test('reads the lhr.life URL the no-install route prints', () => {
  const chatter = 'Welcome to localhost.run!\n\n**You need a SSH key to access this service.**\n\nc0ffee1234.lhr.life tunneled with tls termination, https://c0ffee1234.lhr.life\n';
  assert.equal(tunnel.findUrl(chatter), 'https://c0ffee1234.lhr.life');
});

test('explains both ways forward when no tunnel is installed', async () => {
  const result = await tunnel.open(9999, { prefer: 'nothing-installed-here', timeoutMs: 500 });
  if (result.url) return; // a tunnel binary exists on this machine, nothing to assert
  assert.match(result.error, /cloudflared/);
  assert.match(result.error, /--tunnel=ssh/);
});

test('waits for a public link to actually answer before trusting it', async (t) => {
  const { startServer } = await import('./helpers.mjs');
  const booth = await startServer({ NO_OPEN: '1' });
  t.after(() => booth.close());

  const live = await tunnel.waitUntilLive(booth.base, { timeoutMs: 8000, everyMs: 200 });
  assert.equal(live.live, true, 'a booth that is up should be seen straight away');
  assert.ok(live.attempts <= 3, `should not have needed ${live.attempts} tries`);
});

test('gives up on a hostname that never resolves, instead of hanging', async () => {
  const started = Date.now();
  const result = await tunnel.waitUntilLive('https://lease-archives-wins-removable.trycloudflare.invalid', {
    timeoutMs: 2500,
    everyMs: 300,
  });
  assert.equal(result.live, false);
  assert.ok(Date.now() - started < 9000, 'the wait must respect its own timeout');
});

test('picks a persistent address when one is configured', async () => {
  const ngrok = await tunnel.pick(8080, 'auto', { NGROK_DOMAIN: 'bff-booth.ngrok-free.app', PATH: process.env.PATH });
  if (ngrok.error) {
    assert.match(ngrok.error, /ngrok is not installed/, 'without ngrok it should say so, not fall back silently');
  } else {
    assert.equal(ngrok.fixed, 'https://bff-booth.ngrok-free.app', 'the address is known before the process starts');
    assert.ok(ngrok.args.includes('--url'), 'the domain must be passed to ngrok');
  }

  const named = await tunnel.pick(8080, 'auto', {
    CF_TUNNEL: 'booth',
    TUNNEL_HOSTNAME: 'booth.example.com',
    PATH: process.env.PATH,
  });
  if (!named.error) {
    assert.equal(named.fixed, 'https://booth.example.com');
    assert.deepEqual(named.args.slice(0, 2), ['tunnel', 'run'], 'a named tunnel is run, not created');
  }
});

test('a named Cloudflare tunnel without its hostname is refused, not guessed', async () => {
  const result = await tunnel.pick(8080, 'auto', { CF_TUNNEL: 'booth', PATH: process.env.PATH });
  assert.ok(result.error, 'should not start a tunnel whose address we cannot tell guests');
  assert.match(result.error, /TUNNEL_HOSTNAME|cloudflared is not installed/);
});

test('reads a tailscale funnel address out of its output', () => {
  assert.equal(
    tunnel.findUrl('Available on the internet:\n\nhttps://mac-mini.tail1234.ts.net/\n|-- proxy http://127.0.0.1:8080'),
    'https://mac-mini.tail1234.ts.net',
  );
});

test('an unconfigured booth reports no persistent address', () => {
  assert.equal(tunnel.isPersistent(), false);
});

test('finds a CLI that a GUI installer left inside its app bundle', async () => {
  // Installing Tailscale on a Mac puts the binary in /Applications and nothing
  // on PATH, so a plain `which` lookup finds nothing and the option looks broken.
  const result = await tunnel.pick(8080, 'tailscale', { PATH: '/nonexistent' });
  if (result.command) {
    assert.match(result.command, /tailscale/i);
  } else {
    assert.match(result.error, /Install it from tailscale\.com/,
      'when it really is missing, say how to get it');
    assert.doesNotMatch(result.error, /not installed\.$/, 'a bare "not installed" is not an instruction');
  }
});

test('a tunnel choice is remembered, so the start command stops changing', async (t) => {
  const { startServer, until } = await import('./helpers.mjs');
  const { readFileSync, existsSync } = await import('node:fs');

  // The choice is written at startup, before the tunnel is even attempted —
  // which matters, because attempting one can take a while.
  const booth = await startServer({ BOOTH_ARGS: '--tunnel=ssh', NO_OPEN: '1' });
  t.after(() => booth.close());

  const stored = await until(() => {
    if (!existsSync(booth.configPath)) return null;
    return JSON.parse(readFileSync(booth.configPath, 'utf8')).tunnel || null;
  });
  assert.equal(stored, 'ssh', 'the booth should write down what it was told to use');
});
