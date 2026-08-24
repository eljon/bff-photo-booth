'use strict';

/**
 * Optional outbound tunnel, so guests on cellular (or any other network) can
 * reach a booth running on a laptop behind NAT. We shell out to whichever
 * tunnel is available rather than shipping one:
 *
 *   cloudflared tunnel --url http://localhost:PORT   (no account needed)
 *   ngrok http PORT                                  (needs a free account)
 *   ssh -R 80:localhost:PORT nokey@localhost.run     (--tunnel=ssh, installs nothing)
 *
 * The ssh route is opt-in on purpose: it relays every guest's photos through a
 * third party nobody deliberately chose, so it is never a silent fallback.
 *
 * Nothing here is required for a LAN booth.
 */

const { spawn, execFile } = require('node:child_process');

let child = null;
let publicUrl = null;

const PATTERNS = [
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/i,
  /https:\/\/[a-z0-9-]+\.lhr\.life/i,
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

/** Which tunnel to use: 'auto' picks an installed binary, 'ssh' forces the no-install route. */
async function pick(port, prefer) {
  if (prefer === 'ssh') {
    const ssh = await which('ssh');
    if (!ssh) return { error: 'ssh was not found, which is unusual on macOS.' };
    return {
      command: ssh,
      args: [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=30',
        '-R', `80:localhost:${port}`,
        'nokey@localhost.run',
      ],
    };
  }

  const cloudflared = await which('cloudflared');
  if (cloudflared) return { command: cloudflared, args: ['tunnel', '--url', `http://localhost:${port}`] };

  const ngrok = await which('ngrok');
  if (ngrok) return { command: ngrok, args: ['http', String(port), '--log', 'stdout'] };

  return {
    error: [
      'no tunnel found. Either install cloudflared (no account needed):',
      '    curl -L -o cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$(uname -m | grep -q arm64 && echo arm64 || echo amd64).tgz',
      '    tar -xzf cloudflared.tgz && sudo mv cloudflared /usr/local/bin/',
      '  …or start with --tunnel=ssh to use localhost.run instead, which installs nothing',
      '  but relays your guests\' photos through a third party.',
    ].join('\n  '),
  };
}

/** Start a tunnel and resolve once it announces a public URL. */
async function open(port, { timeoutMs = 30_000, prefer = 'auto' } = {}) {
  if (publicUrl) return { url: publicUrl };

  const { command, args, error } = await pick(port, prefer);
  if (error) return { url: null, error };

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

/**
 * A quick tunnel prints its hostname the moment it is assigned, which is before
 * DNS resolves anywhere. Opening a browser on it then gives NXDOMAIN, and the
 * browser caches that. So poll the public URL until it actually answers.
 */
async function waitUntilLive(target, { timeoutMs = 60_000, everyMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await fetch(`${target}/api/health`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'cache-control': 'no-cache' },
      });
      if (response.ok) return { live: true, attempts };
    } catch {
      // DNS has not propagated, or the edge has no connection yet
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return { live: false, attempts };
}

function url() {
  return publicUrl;
}

function close() {
  if (child) child.kill();
  child = null;
  publicUrl = null;
}

module.exports = { open, url, close, findUrl, waitUntilLive };
