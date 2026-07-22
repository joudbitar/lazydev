#!/usr/bin/env node
// lazydev registry helper for the add-project skill. Zero deps, Node 20+.
//
//   node registry.mjs list
//   node registry.mjs add --host myapp --dir /abs/path --start-cmd "cmd" \
//        [--framework node] [--port 3200] [--parked]
//   node registry.mjs remove --host myapp
//   node registry.mjs verify --host myapp [--timeout-s 120]
//
// The daemon watches the registry file and hot-reloads on write, so `add`
// IS the deployment. `verify` polls the URL through the front door until the
// project answers 200 (503 means the daemon is cold-starting it — keep
// waiting). Exit codes: 0 ok, 1 validation/registry error, 2 verify timeout.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Piping into `head` closes stdout early; that is fine, not a crash.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(HERE, '..', '..', '..', '..'); // repo root when the skill ships in the checkout

function fail(msg) {
  process.stderr.write(`registry.mjs: ${msg}\n`);
  process.exit(1);
}

// Same resolution order the skill documents: env override, XDG state dir,
// the default state dir, then a checkout-local projects.json.
function findRegistry() {
  const cands = [];
  if (process.env.LAZYDEV_STATE_DIR) cands.push(path.join(process.env.LAZYDEV_STATE_DIR, 'projects.json'));
  if (process.env.XDG_STATE_HOME) cands.push(path.join(process.env.XDG_STATE_HOME, 'lazydev', 'projects.json'));
  cands.push(path.join(os.homedir(), '.local', 'state', 'lazydev', 'projects.json'));
  cands.push(path.join(CHECKOUT, 'projects.json'));
  for (const p of cands) if (fs.existsSync(p)) return p;
  fail(`no registry found; looked at:\n  ${cands.join('\n  ')}\nstart lazydev once so it creates one, or pass LAZYDEV_STATE_DIR.`);
}

function readRegistry(file) {
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file} is not valid JSON (${err.message}); fix it before writing anything.`);
  }
  if (!Array.isArray(reg.projects)) fail(`${file} has no projects array.`);
  return reg;
}

function writeRegistry(file, reg) {
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
}

// A port is usable when no registry entry claims it and nothing is listening
// on it right now (test-bind, both loopback families best-effort).
function portListening(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

async function pickPort(reg) {
  const used = new Set(reg.projects.map((p) => p.port));
  for (let port = 3010; port < 65000; port += 10) {
    if (used.has(port)) continue;
    if (await portListening(port)) continue;
    return port;
  }
  fail('no free port found in the 3010+ pool.');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'parked') args.parked = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

async function cmdAdd(args, file, reg) {
  const host = String(args.host || '').trim();
  const dir = String(args.dir || '').trim().replace(/\/+$/, '');
  const startCmd = String(args['start-cmd'] || '').trim();
  if (!/^[a-z0-9-]+$/.test(host)) fail(`--host must be lowercase a-z0-9- (got "${host}").`);
  if (host === 'lazydev') fail('the host "lazydev" is reserved for the daemon.');
  if (reg.projects.some((p) => p.host === host)) fail(`host "${host}" is already registered; use remove first or pick another name.`);
  if (!path.isAbsolute(dir)) fail(`--dir must be absolute (got "${dir}").`);
  if (!fs.existsSync(dir)) fail(`--dir does not exist: ${dir}`);
  if (!startCmd) fail('--start-cmd is required; see PORTS.md for per-ecosystem commands.');

  const port = args.port ? Number(args.port) : await pickPort(reg);
  if (!Number.isFinite(port) || port <= 0) fail(`--port must be a positive number (got "${args.port}").`);
  if (reg.projects.some((p) => p.port === port)) fail(`port ${port} is already claimed in the registry.`);

  const entry = {
    host,
    dir,
    port,
    startCmd: startCmd.includes('<port>') ? startCmd.replaceAll('<port>', String(port)) : startCmd,
    framework: String(args.framework || 'node'),
    enabled: !args.parked,
  };
  reg.projects.push(entry);
  writeRegistry(file, reg);
  process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
  process.stdout.write(`registered in ${file}; the daemon hot-reloads on write.\n`);
  process.stdout.write(entry.enabled
    ? `next: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} verify --host ${host}\n`
    : `parked (enabled: false); flip enabled to true in the registry to activate.\n`);
}

function cmdRemove(args, file, reg) {
  const host = String(args.host || '').trim();
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.host !== host);
  if (reg.projects.length === before) fail(`no entry with host "${host}".`);
  writeRegistry(file, reg);
  process.stdout.write(`removed "${host}"; ${reg.projects.length} projects remain. If its server is still running, kill it (check the port with lsof).\n`);
}

// Poll through the front door. :80 first (the portless happy path), then the
// registry's own configured port as the fallback-run case.
async function cmdVerify(args, file, reg) {
  const host = String(args.host || '').trim();
  const entry = reg.projects.find((p) => p.host === host);
  if (!entry) fail(`no entry with host "${host}".`);
  const timeoutS = Number(args['timeout-s']) || 120;
  const bases = [`http://${host}.localhost/`, `http://${host}.localhost:${reg.port || 4000}/`];
  const deadline = Date.now() + timeoutS * 1000;
  let last = 'no response';
  while (Date.now() < deadline) {
    for (const url of bases) {
      try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        last = `${res.status} at ${url}`;
        if (res.status >= 200 && res.status < 400) {
          process.stdout.write(`ok: ${url} answered ${res.status}\n`);
          return;
        }
      } catch (err) {
        last = `${err.cause?.code || err.name} at ${url}`;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.stderr.write(`verify timed out after ${timeoutS}s (last: ${last}).\nread the server's own output: <state-dir>/logs/${host}.log\n`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const file = findRegistry();
const reg = readRegistry(file);

if (cmd === 'list') {
  for (const p of reg.projects) process.stdout.write(`${p.enabled === false ? '○' : '●'} ${p.host}  :${p.port}  ${p.startCmd}  ${p.dir}\n`);
} else if (cmd === 'add') {
  await cmdAdd(args, file, reg);
} else if (cmd === 'remove') {
  cmdRemove(args, file, reg);
} else if (cmd === 'verify') {
  await cmdVerify(args, file, reg);
} else {
  fail('usage: registry.mjs <list|add|remove|verify> [--host --dir --start-cmd --framework --port --parked --timeout-s]');
}
