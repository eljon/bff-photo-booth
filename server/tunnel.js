'use strict';

/**
 * Optional outbound tunnel, so guests on cellular (or any other network) can
 * reach a booth running on a laptop behind NAT. We shell out to whichever
 * tunnel binary is installed rather than shipping one:
 *
 *   cloudflared tunnel --url http://localhost:PORT   (no account needed)
 *   ngrok http PORT                                  (needs a free account)
 *
 * Nothing here is required for a LAN booth.
 */

const { spawn, execFile } = require('node:child_process');

let child = null;
let publicUrl = null;

const PATTERNS = [
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/i,
];

function which(binary) {
  return new Promise((resolve) => {
    execFile('which', [binary], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

function findUrl(text) {
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/** Start a tunnel and resolve once it announces a public URL. */
async function open(port, { timeoutMs = 30_000 } = {}) {
  if (publicUrl) return { url: publicUrl };

  const cloudflared = await which('cloudflared');
  const ngrok = cloudflared ? null : await which('ngrok');

  if (!cloudflared && !ngrok) {
    return {
      url: null,
      error: 'no tunnel binary found. Install one with `brew install cloudflared` (no account needed), then start again with --tunnel.',
    };
  }

  const [command, args] = cloudflared
    ? [cloudflared, ['tunnel', '--url', `http://localhost:${port}`]]
    : [ngrok, ['http', String(port), '--log', 'stdout']];

  child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve) => {
    const done = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => done({ url: null, error: 'the tunnel did not report a URL in time.' }),
      timeoutMs,
    );

    const scan = (chunk) => {
      const found = findUrl(chunk.toString());
      if (found && !publicUrl) {
        publicUrl = found;
        done({ url: found });
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (err) => done({ url: null, error: err.message }));
    child.on('exit', (code) => {
      publicUrl = null;
      child = null;
      done({ url: null, error: `tunnel exited with code ${code}.` });
    });
  });
}

function url() {
  return publicUrl;
}

function close() {
  if (child) child.kill();
  child = null;
  publicUrl = null;
}

module.exports = { open, url, close, findUrl };
