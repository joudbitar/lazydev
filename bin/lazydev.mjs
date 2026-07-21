#!/usr/bin/env node
// lazydev npx entrypoint — one command, no Caddy, one state directory.
//
//   npx lazydev            (once published)
//   node bin/lazydev.mjs   (works today, from a checkout)
//
// It resolves ONE state directory, scans $HOME for projects into it, and starts
// the daemon in the FOREGROUND serving the front door directly on :80 (falling
// back to a numbered port where :80 cannot be bound — Linux without
// CAP_NET_BIND_SERVICE). Ctrl-C stops it; the daemon handles SIGINT/SIGTERM.
//
// Nothing is written into any project directory. Everything lands in the state
// dir (registry, logs, control token); deleting it removes every trace. This
// path installs NO service — see `docs/adr/0001-npx-front-door.md` and the
// README for the one-command upgrade to the persistent daemon.
//
// Zero npm dependencies — Node built-ins only.

import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, resolveStatePaths } from '../lib/state.mjs';
import { decideBindFallback, formatProjectUrl } from '../lib/bind.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // repo root — where lazydev.mjs / scan.mjs live
const DAEMON = path.join(ROOT, 'lazydev.mjs');
const SCANNER = path.join(ROOT, 'scan.mjs');

// The front-door port, and the numbered port to fall back to when :80 can't be
// bound. Both overridable so the boot smoke test can force a non-privileged
// port on CI (no :80 there).
const FRONT_PORT = Number(process.env.LAZYDEV_PORT) || 80;
const FALLBACK_PORT = Number(process.env.LAZYDEV_FALLBACK_PORT) || 4000;

// Resolve ONE state directory: LAZYDEV_STATE_DIR wins, else the XDG state home
// (preferXdg), else ~/.local/state/lazydev. Everything derives from it.
const stateDir = resolveStateDir({
  env: process.env,
  home: os.homedir(),
  scriptDir: ROOT, // only used if preferXdg were false; here XDG default wins
  preferXdg: true,
});
const { configPath, logsDir } = resolveStatePaths({ env: process.env, stateDir });

function ensureStateDir() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

// Decide the port the daemon will actually serve on, so the URLs we print are
// the ones that WORK. Try to bind the front-door port on 127.0.0.1; if that
// fails with a fallback-eligible code (EACCES on Linux without the capability,
// or EADDRINUSE), fall back to the numbered port. We bind+immediately-close a
// throwaway listener only to learn the outcome — the daemon does the real,
// lasting bind moments later. A brief window where the port is free between our
// close and the daemon's bind is acceptable for a foreground dev tool.
function decideServePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      const decision = decideBindFallback({ attemptedPort: FRONT_PORT, errorCode: err && err.code, fallbackPort: FALLBACK_PORT });
      resolve(decision.fallback ? decision.port : FRONT_PORT);
    });
    probe.listen(FRONT_PORT, '127.0.0.1', () => {
      probe.close(() => resolve(FRONT_PORT));
    });
  });
}

// The environment a child (scan or daemon) inherits: pin the SAME state dir so
// scan writes the registry where the daemon reads it, and force the port the
// daemon serves on. Passing LAZYDEV_STATE_DIR (not just deriving) keeps both
// children on one layout even if the user's own env is unset.
function childEnvFor(servePort) {
  return {
    ...process.env,
    LAZYDEV_STATE_DIR: stateDir,
    LAZYDEV_PORT: String(servePort),
    LAZYDEV_FALLBACK_PORT: String(FALLBACK_PORT),
  };
}

// Run scan.mjs as a child so the EXACT scan logic runs and writes the registry
// into the state dir. Resolves on exit code 0, rejects otherwise.
function runScan(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCANNER], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`scan exited ${code}`))));
  });
}

// Read the enabled projects the scan just wrote, for the URL summary.
function readProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Array.isArray(parsed.projects) ? parsed.projects.filter((p) => p && p.enabled !== false) : [];
  } catch {
    return [];
  }
}

// Print the front-door URLs and the one-command persistent-upgrade hint. The
// port is included in every URL only when we are NOT on the front-door port :80
// (a browser reaches http://name.localhost with no suffix only there); on a
// fallback port the URL carries the :port so what we print is what works.
function printSummary(projects, servePort) {
  const fellBack = servePort !== FRONT_PORT;
  const note = fellBack ? ` (:${FRONT_PORT} was unavailable, using :${servePort})` : '';
  process.stdout.write(`\nlazydev is serving the front door on :${servePort}${note}.\n`);
  process.stdout.write(`state directory: ${stateDir}\n`);
  if (projects.length) {
    process.stdout.write(`\nyour projects:\n`);
    for (const p of projects) process.stdout.write(`  ${formatProjectUrl(p.host, servePort)}\n`);
  } else {
    process.stdout.write(`\nno projects found under ${os.homedir()}. add one with a "dev" script and re-run.\n`);
  }
  process.stdout.write(`\ndashboard: ${formatProjectUrl('lazydev', servePort)}\n`);
  process.stdout.write(`\nthis is a foreground run and stops when you press Ctrl-C.\n`);
  process.stdout.write(`to keep it running in the background: run ./install.sh (installs the persistent, Caddy-backed daemon).\n\n`);
}

// Spawn the daemon in the foreground, stdio inherited. It stays attached to this
// process group, so Ctrl-C (SIGINT) reaches it and its own SIGINT/SIGTERM
// handler shuts the children down cleanly. Resolves with the exit code.
function runDaemon(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DAEMON], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    // Forward the signals a user or supervisor might send, so the daemon child
    // gets them even if this launcher is the one signalled directly.
    const forward = (sig) => {
      try { child.kill(sig); } catch { /* already gone */ }
    };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));
    child.on('error', (err) => {
      process.stderr.write(`lazydev: could not start the daemon: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 0 : code || 0));
  });
}

async function main() {
  const arg = (process.argv[2] || '').trim();

  // `install` is a persistent-daemon step, not part of the npx foreground run.
  // Point at the installer rather than doing it here (this path installs nothing).
  if (arg === 'install') {
    process.stdout.write(
      'lazydev: to install the persistent background daemon, run ./install.sh from the checkout.\n' +
      'that path runs the daemon behind Caddy on macOS and keeps its own registry (lazydev scan).\n'
    );
    return 0;
  }

  ensureStateDir();

  // Decide the real serving port up front so scan, the daemon, and the printed
  // URLs all agree — and so the URLs we show are the ones that actually work.
  const servePort = await decideServePort();
  const env = childEnvFor(servePort);

  process.stdout.write('lazydev: scanning for projects...\n');
  try {
    await runScan(env);
  } catch (err) {
    process.stderr.write(`lazydev: scan failed (${err.message}); starting with whatever registry exists.\n`);
  }

  const projects = readProjects();
  printSummary(projects, servePort);

  return runDaemon(env);
}

main().then((code) => {
  if (typeof code === 'number' && code !== 0) process.exitCode = code;
});
