import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, until } from './helpers.mjs';

/**
 * Shadow the platform's launcher with a script that just records the URL, so
 * these tests never actually pop a browser open on whoever is running them.
 */
function fakeLauncher() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-open-'));
  const log = path.join(dir, 'opened.txt');
  for (const name of ['open', 'xdg-open']) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "$1" >> ${log}\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return {
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    opened: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : ''),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const skip = process.platform === 'win32' ? 'launcher cannot be shadowed on Windows' : false;

test('a public booth opens its host screen in the browser', { skip }, async (t) => {
  const launcher = fakeLauncher();
  t.after(() => launcher.cleanup());
  const booth = await startServer({ ...launcher.env, PUBLIC_URL: 'https://amber-forest-9241.trycloudflare.com' });
  t.after(() => booth.close());

  const opened = await until(() => launcher.opened() || null, { timeoutMs: 6000 });
  assert.match(opened, /^http:\/\/localhost:\d+\/host$/,
    'the host screen belongs to this machine — opening it through the tunnel would wait on DNS');
  assert.match(booth.banner(), /Opened the host screen in your browser/);
});

test('a plain Wi-Fi booth does not hijack the browser', { skip }, async (t) => {
  const launcher = fakeLauncher();
  t.after(() => launcher.cleanup());
  const booth = await startServer(launcher.env);
  t.after(() => booth.close());

  await until(() => (booth.banner().includes('Host screen') ? true : null));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(launcher.opened(), '', 'nothing should have been launched');
});

test('--open asks for the browser even on a Wi-Fi booth', { skip }, async (t) => {
  const launcher = fakeLauncher();
  t.after(() => launcher.cleanup());
  const booth = await startServer({ ...launcher.env, BOOTH_ARGS: '--open' });
  t.after(() => booth.close());

  const opened = await until(() => launcher.opened() || null, { timeoutMs: 6000 });
  assert.match(opened, /\/host$/);
});

test('a relay never opens a browser — it is a headless server', { skip }, async (t) => {
  const launcher = fakeLauncher();
  t.after(() => launcher.cleanup());
  const booth = await startServer({
    ...launcher.env,
    MODE: 'relay',
    BOOTH_TOKEN: 'relay-token',
    PUBLIC_URL: 'https://booth.example.com',
  });
  t.after(() => booth.close());

  await until(() => (booth.banner().includes('Host screen') ? true : null));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(launcher.opened(), '');
});
