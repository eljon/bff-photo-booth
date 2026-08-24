import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable PNG so the server's magic-byte check is exercised honestly. */
export function makePng(width = 4, height = 4) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Boot the real entry point in a child process, isolated from the repo state. */
export async function startServer(env = {}) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const os = await import('node:os');

  const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-test-'));
  const port = await freePort();

  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DRY_RUN: '1',
      PRINTS_DIR: path.join(sandbox, 'prints'),
      PHOTOBOOTH_CONFIG: path.join(sandbox, 'config.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errors = [];
  const output = [];
  child.stderr.on('data', (data) => errors.push(data.toString()));
  child.stdout.on('data', (data) => output.push(data.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited: ${errors.join('')}`);
    try {
      const response = await fetch(`${base}/api/session`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start: ${errors.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  const configPath = path.join(sandbox, 'config.json');
  return {
    base,
    sandbox,
    configPath,
    printsDir: path.join(sandbox, 'prints'),
    stderr: () => errors.join(''),
    /** Everything the booth printed at startup — the banner guests are read from. */
    banner: () => output.join(''),
    /** The access key the booth generated for itself on first run. */
    accessKey() {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8')).accessKey;
      } catch {
        return '';
      }
    },
    async close() {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      fs.rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

/** Run the real booth agent against a relay, as the MacBook would. */
export async function startAgent(relayUrl, token, env = {}) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const os = await import('node:os');

  const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-agent-'));

  const child = spawn(process.execPath, [path.join(root, 'server', 'agent.js')], {
    env: {
      ...process.env,
      RELAY_URL: relayUrl,
      BOOTH_TOKEN: token,
      DRY_RUN: '1',
      PRINTS_DIR: path.join(sandbox, 'prints'),
      AGENT_NAME: 'test booth mac',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (data) => output.push(data.toString()));
  child.stderr.on('data', (data) => output.push(data.toString()));

  return {
    sandbox,
    printsDir: path.join(sandbox, 'prints'),
    log: () => output.join(''),
    exited: () => child.exitCode,
    async close() {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      fs.rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

/** Poll until `check` returns truthy, or give up. */
export async function until(check, { timeoutMs = 10_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
