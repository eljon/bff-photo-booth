'use strict';

/**
 * Outbound tunnel, so guests on cellular (or any other network) can reach a
 * booth running on a laptop behind NAT. We shell out to whichever tunnel is
 * available rather than shipping one.
 *
 * Two shapes matter, and they are not the same product:
 *
 *   throwaway — `cloudflared tunnel --url …` hands out a random hostname that
 *               changes every launch. Fine for tonight, useless on a printed
 *               sign, and a restart invalidates whatever guests already have.
 *
 *   persistent — a fixed address you own: an ngrok static domain, a named
 *               Cloudflare tunnel, or a Tailscale funnel. The address survives
 *               restarts, so a QR code printed last week still works, and the
 *               Mac waking from sleep picks the same address straight back up.
 *
 * Either way the tunnel process is restarted if it dies, which is what makes a
 * booth survive a closed lid: macOS kills the connection on sleep, and on wake
 * the tunnel comes back on its own.
 */

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');

let child = null;
let publicUrl = null;
let fixedUrl = null; // known before the process starts, for persistent tunnels
let stableAddress = false; // address is discovered, but does not change between runs
let shuttingDown = false;
let restartAttempt = 0;
let restartTimer = null;
let currentLaunch = null; // { command, args, label }
let onChange = () => {};

const HEALTHY_RUN_MS = 30_000; // a tunnel up this long counts as having worked

const PATTERNS = [
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ngrok(?:-free)?\.(?:app|io|dev)/i,
  /https:\/\/[a-z0-9-]+\.lhr\.life/i,
  /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i,
];

/** Where a GUI installer drops a CLI that never lands on PATH. */
const EXTRA_PATHS = {
  tailscale: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ],
  cloudflared: ['/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared'],
  ngrok: ['/usr/local/bin/ngrok', '/opt/homebrew/bin/ngrok'],
};

function which(binary) {
  return new Promise((resolve) => {
    execFile('which', [binary], (err, stdout) => {
      if (!err && stdout.trim()) return resolve(stdout.trim());
      // Installing Tailscale from the website or App Store leaves the CLI
      // inside the bundle, so `which` finds nothing at all.
      for (const candidate of EXTRA_PATHS[binary] || []) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return resolve(candidate);
        } catch {
          /* keep looking */
        }
      }
      return resolve(null);
    });
  });
}

/**
 * ngrok renamed the static-address flag: older agents take --domain, current
 * ones take --url. Ask the binary in front of us rather than guessing, because
 * guessing wrong just makes it exit on startup.
 */
function ngrokDomainFlag(ngrok) {
  return new Promise((resolve) => {
    execFile(ngrok, ['http', '--help'], { timeout: 5000 }, (err, stdout, stderr) => {
      const help = `${stdout || ''}${stderr || ''}`;
      if (/--url\b/.test(help)) resolve('--url');
      else if (/--domain\b/.test(help)) resolve('--domain');
      else resolve('--url');
    });
  });
}

function findUrl(text) {
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

const https = (host) => (/^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `https://${host}`);

/**
 * Clear any funnel/serve config Tailscale is holding. Its config is persistent —
 * a funnel started by hand and Ctrl-C'd earlier stays advertised, and collides
 * with the one the booth starts. Best effort: if reset is unavailable we carry
 * on, since a first-ever run has nothing to clear.
 */
function resetTailscale(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['serve', 'reset'], { timeout: 8000 }, () => resolve());
  });
}

/**
 * Work out what to run. Environment beats guessing: naming a persistent address
 * is how you say "this booth has an address of its own".
 */
async function pick(port, prefer, env = process.env) {
  const wanted = prefer === 'auto' ? '' : prefer;

  // ── persistent: an ngrok static domain (one free per account)
  if (env.NGROK_DOMAIN || wanted === 'ngrok') {
    const ngrok = await which('ngrok');
    if (!ngrok) return { error: 'ngrok is not installed. `brew install ngrok`, then `ngrok config add-authtoken …`.' };
    const args = ['http', String(port), '--log', 'stdout'];
    if (env.NGROK_DOMAIN) {
      const flag = await ngrokDomainFlag(ngrok);
      // --domain wants the bare host, --url wants a full URL
      args.push(flag, flag === '--url' ? https(env.NGROK_DOMAIN) : env.NGROK_DOMAIN.replace(/^https?:\/\//, ''));
    }
    return {
      command: ngrok,
      args,
      label: env.NGROK_DOMAIN ? 'ngrok (persistent domain)' : 'ngrok',
      fixed: env.NGROK_DOMAIN ? https(env.NGROK_DOMAIN) : null,
    };
  }

  // ── persistent: a named Cloudflare tunnel on your own hostname
  if (env.CF_TUNNEL || wanted === 'named') {
    const cloudflared = await which('cloudflared');
    if (!cloudflared) return { error: 'cloudflared is not installed.' };
    if (!env.CF_TUNNEL) return { error: 'set CF_TUNNEL to the name of the tunnel you created.' };
    if (!env.TUNNEL_HOSTNAME) return { error: 'set TUNNEL_HOSTNAME to the hostname routed to that tunnel.' };
    return {
      command: cloudflared,
      args: ['tunnel', 'run', '--url', `http://localhost:${port}`, env.CF_TUNNEL],
      label: `cloudflare tunnel "${env.CF_TUNNEL}" (persistent)`,
      fixed: https(env.TUNNEL_HOSTNAME),
    };
  }

  // ── persistent: tailscale funnel, address tied to this machine forever
  if (wanted === 'tailscale') {
    const tailscale = await which('tailscale');
    if (!tailscale) {
      return { error: 'Tailscale was not found. Install it from tailscale.com/download and sign in, then try again.' };
    }
    // Wipe leftover funnel state before we advertise our own, or a stale entry
    // from a hand-run `tailscale funnel` keeps answering with nothing useful.
    await resetTailscale(tailscale);
    return {
      command: tailscale,
      args: ['funnel', String(port)],
      label: 'tailscale funnel',
      fixed: null,
      // The address is tied to the machine and tailnet, so it is the same every
      // run — we just have to read it out of the output the first time.
      stable: true,
      // Leave nothing advertised once the booth stops.
      cleanup: () => resetTailscale(tailscale),
    };
  }

  // ── throwaway: localhost.run over the ssh that macOS already has
  if (wanted === 'ssh') {
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
      label: 'localhost.run',
      fixed: null,
    };
  }

  // ── throwaway: a cloudflare quick tunnel, no account needed
  if (wanted === 'cloudflared') {
    const binary = await which('cloudflared');
    if (!binary) return { error: 'cloudflared is not installed.' };
    return {
      command: binary,
      args: ['tunnel', '--url', `http://localhost:${port}`],
      label: 'cloudflare quick tunnel',
      fixed: null,
    };
  }

  const cloudflared = await which('cloudflared');
  if (cloudflared) {
    return {
      command: cloudflared,
      args: ['tunnel', '--url', `http://localhost:${port}`],
      label: 'cloudflare quick tunnel',
      fixed: null,
    };
  }

  const ngrok = await which('ngrok');
  if (ngrok) return { command: ngrok, args: ['http', String(port), '--log', 'stdout'], label: 'ngrok', fixed: null };

  return {
    error: [
      'no tunnel found. Either install cloudflared (no account needed):',
      '    curl -L -o cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$(uname -m | grep -q arm64 && echo arm64 || echo amd64).tgz',
      '    tar -xzf cloudflared.tgz && sudo mv cloudflared /usr/local/bin/',
      '  …or start with --tunnel=ssh to use localhost.run instead, which installs nothing',
      "  but relays your guests' photos through a third party.",
    ].join('\n  '),
  };
}

function spawnTunnel(onUrl) {
  const { command, args } = currentLaunch;
  const startedAt = Date.now();
  child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const recent = [];
  const scan = (chunk) => {
    const text = chunk.toString();
    recent.push(text);
    if (recent.length > 12) recent.shift();

    const found = findUrl(text);
    if (found && found !== publicUrl && !fixedUrl) {
      const previous = publicUrl;
      publicUrl = found;
      onUrl(found, previous);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('exit', () => {
    child = null;
    if (shuttingDown) return;
    if (!fixedUrl && !stableAddress) publicUrl = null;

    // A tunnel that dies within seconds is misconfigured, not asleep. Show what
    // it actually said, or the retry loop hides the one useful message.
    if (Date.now() - startedAt < 5000 && restartAttempt === 0) {
      const complaint = recent.join('').trim().split('\n').filter(Boolean).slice(-4).join('\n    ');
      if (complaint) onChange({ event: 'error', detail: complaint });
    }

    // A tunnel that ran happily for a while and then dropped is a sleep, not a
    // broken setup — start its backoff over so waking is quick.
    if (Date.now() - startedAt > HEALTHY_RUN_MS) restartAttempt = 0;

    // macOS drops the connection on sleep; bringing it back is the whole point
    // of a booth that survives a closed lid.
    restartAttempt += 1;
    const delay = Math.min(30_000, 2000 * restartAttempt);
    // Say it a few times, then stop filling the terminal with the same line.
    if (restartAttempt <= 3 || restartAttempt % 10 === 0) {
      onChange({ event: 'restarting', inSeconds: Math.round(delay / 1000), attempt: restartAttempt, fixed: Boolean(fixedUrl) });
    }
    restartTimer = setTimeout(() => spawnTunnel(onUrl), delay);
  });

  return child;
}

/**
 * Start a tunnel and resolve once its address is known. A persistent tunnel
 * knows its address up front, so it resolves immediately.
 */
async function open(port, { timeoutMs = 30_000, prefer = 'auto', onEvent } = {}) {
  if (publicUrl) return { url: publicUrl };
  if (onEvent) onChange = onEvent;

  const choice = await pick(port, prefer);
  if (choice.error) return { url: null, error: choice.error };

  shuttingDown = false;
  restartAttempt = 0;
  currentLaunch = choice;
  fixedUrl = choice.fixed || null;
  stableAddress = Boolean(choice.stable);
  if (fixedUrl) publicUrl = fixedUrl;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ url: publicUrl, error: publicUrl ? null : 'the tunnel did not report a URL in time.' }),
      timeoutMs,
    );

    const started = spawnTunnel((found, previous) => {
      onChange({ event: 'url', url: found, previous });
      finish({ url: found, label: choice.label, persistent: false });
    });
    started.on('error', (err) => finish({ url: null, error: err.message }));

    // A fixed address does not need to be discovered in the output.
    if (fixedUrl) finish({ url: fixedUrl, label: choice.label, persistent: true });
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

/** True when the address survives a restart, so printed QR codes keep working. */
function isPersistent() {
  return Boolean(fixedUrl || stableAddress);
}

function close() {
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (currentLaunch && currentLaunch.cleanup) currentLaunch.cleanup();
  if (child) child.kill();
  child = null;
  publicUrl = null;
  fixedUrl = null;
  stableAddress = false;
}

module.exports = { open, url, close, findUrl, waitUntilLive, isPersistent, pick };
