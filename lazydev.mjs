#!/usr/bin/env node
// lazydev — on-demand local dev-server proxy daemon.
// Zero npm dependencies. Node v22 built-ins only.
//
// See ./SPEC.md (project root) for the full build contract.

import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

// Resolve all state relative to THIS file's directory, so the whole project is
// relocatable: move or clone it anywhere and the registry, logs, and daemon
// travel together. (Was hardcoded to ~/.config/lazydev before centralizing.)
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const DAEMON_LOG = path.join(LOGS_DIR, 'daemon.log');
const CONFIG_PATH = process.env.LAZYDEV_CONFIG || path.join(CONFIG_DIR, 'projects.json');

const DEFAULTS = {
  port: 4000,
  idleTimeoutMs: 1_800_000, // 30 min
  startTimeoutMs: 120_000, // 2 min
  installTimeoutMs: 300_000, // 5 min
};

// Loopback families to try, in order. `localhost` on this machine resolves
// ::1 (IPv6) first; Next binds 0.0.0.0 (reachable via 127.0.0.1) but Vite binds
// `localhost` -> ::1 ONLY, so we must try both families everywhere we connect.
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}
ensureDir(LOGS_DIR);

function ts() {
  return new Date().toISOString();
}

function log(...parts) {
  const line = `[${ts()}] ${parts.join(' ')}`;
  // stdout
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* ignore */
  }
  // daemon.log (best-effort)
  try {
    fs.appendFileSync(DAEMON_LOG, line + '\n');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Config / registry
// ---------------------------------------------------------------------------

// config: { port, idleTimeoutMs, startTimeoutMs, projects: [...] }
let config = { ...DEFAULTS, projects: [] };

// Per-host live runtime state. Keyed by project host.
//   { project, state: 'stopped'|'installing'|'starting'|'running', owned: bool,
//     child: ChildProcess|null, pid: number|null, startPromise: Promise|null,
//     upstreamHost: string|null }  // loopback family that accepted the port
const runtime = new Map();
// lastAccess[host] = epoch ms of last proxied request
const lastAccess = new Map();

function projectByHost(host) {
  return config.projects.find((p) => p.host === host);
}

function getRuntime(host) {
  let r = runtime.get(host);
  if (!r) {
    r = { state: 'stopped', owned: false, child: null, pid: null, startPromise: null, upstreamHost: null, conflictDir: null };
    runtime.set(host, r);
  }
  return r;
}

function loadConfig(reason) {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    log(`config: could not read ${CONFIG_PATH} (${err.code || err.message}); keeping previous registry`);
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`config: invalid JSON in ${CONFIG_PATH} (${err.message}); keeping previous registry`);
    return false;
  }
  const next = {
    port: Number.isFinite(parsed.port) ? parsed.port : DEFAULTS.port,
    idleTimeoutMs: Number.isFinite(parsed.idleTimeoutMs) ? parsed.idleTimeoutMs : DEFAULTS.idleTimeoutMs,
    startTimeoutMs: Number.isFinite(parsed.startTimeoutMs) ? parsed.startTimeoutMs : DEFAULTS.startTimeoutMs,
    installTimeoutMs: Number.isFinite(parsed.installTimeoutMs) ? parsed.installTimeoutMs : DEFAULTS.installTimeoutMs,
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
  };
  config = next;
  log(`config: loaded ${config.projects.length} project(s) from ${CONFIG_PATH}${reason ? ` (${reason})` : ''}`);
  return true;
}

// fs.watch with debounce — wrapped so a watch failure cannot crash the daemon.
let watchTimer = null;
let watcher = null;
function startConfigWatch() {
  try {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
    watcher = fs.watch(CONFIG_PATH, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try {
          loadConfig('fs.watch');
        } catch (err) {
          log(`config: reload via watch failed: ${err.message}`);
        }
      }, 200);
    });
    watcher.on('error', (err) => {
      log(`config: watcher error: ${err.message}`);
    });
  } catch (err) {
    // Watch failure (e.g. file does not exist yet) must NOT crash the daemon.
    log(`config: fs.watch unavailable for ${CONFIG_PATH} (${err.message}); SIGHUP still works`);
  }
}

// ---------------------------------------------------------------------------
// Host -> project key resolution (SPEC rule)
// ---------------------------------------------------------------------------

function resolveHostKey(hostHeader) {
  if (!hostHeader) return null;
  // strip :port
  let h = String(hostHeader).trim().toLowerCase();
  // host may be "name:4000" or "[::1]:4000"; we only care about the name part
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && h.indexOf(']') === -1) {
    h = h.slice(0, colon);
  }
  // strip trailing .localhost
  if (h.endsWith('.localhost')) {
    h = h.slice(0, -'.localhost'.length);
  } else if (h === 'localhost') {
    return null;
  }
  if (!h) return null;
  const labels = h.split('.').filter(Boolean);
  if (labels.length === 0) return null;
  // project key is the LAST remaining dotted label
  return labels[labels.length - 1];
}

// ---------------------------------------------------------------------------
// Port probing
// ---------------------------------------------------------------------------

// Open a single TCP connection to `host:port`, resolving the live socket on
// connect or rejecting on error/timeout. Caller owns the returned socket.
function connectOnce(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let done = false;
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      if (done) return;
      done = true;
      sock.setTimeout(0);
      resolve(sock);
    });
    const fail = (err) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      reject(err || new Error('connect failed'));
    };
    sock.once('timeout', () => fail(new Error('timeout')));
    sock.once('error', fail);
  });
}

// Happy-Eyeballs-style loopback connect: try 127.0.0.1 then ::1 (sequential
// fallback). Resolves { socket, host } with the family that actually accepted,
// so callers can pin the proxy/HMR upstream to the right family. The caller
// owns and must consume/destroy the socket.
async function connectLoopback(port, timeoutMs = 300) {
  let lastErr;
  for (const host of LOOPBACK_HOSTS) {
    try {
      const socket = await connectOnce(host, port, timeoutMs);
      return { socket, host };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`no loopback family accepted :${port}`);
}

// Single TCP probe — resolves a host string (127.0.0.1 or ::1) if EITHER
// loopback family has a listener within `timeoutMs`, else null.
async function probePort(port, timeoutMs = 300) {
  try {
    const { socket, host } = await connectLoopback(port, timeoutMs);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    return host;
  } catch {
    return null;
  }
}

// Resolve the working directory of the process LISTENing on `port`, via lsof
// (macOS). Returns the cwd string, or null when it cannot be determined (lsof
// missing/ENOENT, non-zero exit, timeout, or unparseable output). NEVER throws
// — a null return means "unknown", and ensureUp degrades to the legacy adopt
// instead of blocking. Two -F (field) queries: first the listening PID on the
// port, then that PID's cwd file descriptor.
function defaultResolvePidCwd(port) {
  let pid;
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpn'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    // -F output is one field per line; a `p<pid>` line starts each process
    // record. A listener may show multiple fds but the same pid repeats — take
    // the first.
    for (const line of out.split('\n')) {
      if (line[0] === 'p') {
        pid = line.slice(1).trim();
        break;
      }
    }
    if (!pid) return null;
  } catch {
    return null;
  }
  try {
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    // The `n<path>` line carries the cwd path for the cwd fd.
    for (const line of out.split('\n')) {
      if (line[0] === 'n') {
        const p = line.slice(1).trim();
        return p || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Mutable binding so the bundled self-test can swap in a fake resolver (same
// spirit as LAZYDEV_CONFIG / LAZYDEV_REAP_INTERVAL_MS) and never spawn lsof.
// ensureUp calls through this binding, so the setter must reassign it in place.
let resolvePidCwd = defaultResolvePidCwd;
function __setResolvePidCwd(fn) {
  resolvePidCwd = typeof fn === 'function' ? fn : defaultResolvePidCwd;
}

// True if two directory paths refer to the same directory. Resolves both (so
// trailing-slash / `.` segments don't matter) and, best-effort, dereferences
// symlinks — lsof reports the real path, but project.dir may be a symlink, so a
// plain string compare would wrongly flag a legitimate manual server.
function sameDir(a, b) {
  if (!a || !b) return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  let realA = ra;
  let realB = rb;
  try {
    realA = fs.realpathSync(ra);
  } catch {
    /* path may not exist locally (e.g. lsof's view); fall back to resolved */
  }
  try {
    realB = fs.realpathSync(rb);
  } catch {
    /* ignore */
  }
  return realA === realB;
}

// Poll until SOME loopback family accepts a connection or we time out. Resolves
// the host string that worked (so ensureUp can pin state.upstreamHost).
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      const host = await probePort(port, 250);
      if (host) return resolve(host);
      if (Date.now() >= deadline) {
        return reject(new Error(`timeout waiting for loopback:${port} after ${timeoutMs}ms`));
      }
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: ensureUp / stop
// ---------------------------------------------------------------------------

function logFdFor(host) {
  const file = path.join(LOGS_DIR, `${host}.log`);
  try {
    return fs.openSync(file, 'a');
  } catch (err) {
    log(`spawn: cannot open log fd for ${host}: ${err.message}`);
    return 'ignore';
  }
}

function tailLog(host, lines = 40) {
  const file = path.join(LOGS_DIR, `${host}.log`);
  try {
    const data = fs.readFileSync(file, 'utf8');
    const all = data.split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(no log output captured)';
  }
}

// Infer the dependency-install command from the FIRST token of startCmd.
//   pnpm dev    -> pnpm install
//   npm run dev -> npm install
//   yarn dev    -> yarn install
//   bun dev     -> bun install
//   (anything else / empty) -> npm install
function inferInstallCmd(startCmd) {
  const first = String(startCmd || '').trim().split(/\s+/)[0] || '';
  switch (first) {
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    case 'bun':
      return 'bun install';
    case 'npm':
    default:
      return 'npm install';
  }
}

// Run the install step for a project whose node_modules is missing. Streams to
// logs/<host>.log, has its own timeout, and resolves true ONLY on exit code 0.
// On non-zero/timeout it kills the install process and resolves false.
function runInstall(project, r) {
  const host = project.host;
  const installCmd = inferInstallCmd(project.startCmd);
  return new Promise((resolve) => {
    const logFd = logFdFor(host);
    log(`install: ${host} -> sh -c '${installCmd}' (cwd=${project.dir})`);
    let child;
    try {
      child = spawn('sh', ['-c', installCmd], {
        cwd: project.dir,
        env: {
          ...process.env,
          PORT: String(project.port),
          FORCE_COLOR: '1',
          BROWSER: 'none',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        detached: true, // group leader -> kill -pid kills the whole install tree
        stdio: ['ignore', logFd, logFd],
      });
    } catch (err) {
      if (typeof logFd === 'number') {
        try {
          fs.closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
      log(`install-spawn-error: ${host}: ${err.message}`);
      return resolve(false);
    }

    if (typeof logFd === 'number') {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }

    // Track the install child so a shutdown/stop can reach it.
    r.child = child;
    r.pid = child.pid;
    r.owned = true;

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      log(`install-timeout: ${host} exceeded ${config.installTimeoutMs}ms -> SIGKILL`);
      killGroup(r, 'SIGKILL');
      finish(false);
    }, config.installTimeoutMs);

    child.on('error', (err) => {
      log(`install-error: ${host}: ${err.message}`);
      finish(false);
    });
    child.on('exit', (code, signal) => {
      log(`install-exit: ${host} pid=${child.pid} code=${code} signal=${signal}`);
      finish(code === 0);
    });
  });
}

// Idempotent, concurrency-safe. Returns the runtime state object.
async function ensureUp(project) {
  const host = project.host;
  const r = getRuntime(host);
  r.project = project;

  // If a start is already in flight, share it.
  if (r.startPromise) {
    await r.startPromise;
    return r;
  }

  // Already known running with a live owned child? done.
  if (r.state === 'running' && r.owned && r.child && r.child.exitCode === null) {
    return r;
  }

  // Claim the bring-up mutex synchronously — BEFORE any await — so N concurrent
  // requests to a cold project share ONE promise instead of each spawning its
  // own dev server (which then collide on the project's fixed port). The port
  // probe and the adopt-or-spawn decision all live inside this closure; there
  // must be no `await` between the `r.startPromise` check above and this line.
  r.startPromise = (async () => {
    // Probe the port (both loopback families). If something is already
    // listening, decide whether to adopt it (do NOT spawn) by verifying the
    // listener's working directory. All of this runs inside the mutex closure.
    const openHost = await probePort(project.port, 300);
    if (openHost) {
      // Our own live child re-probed: keep it (no ownership check needed).
      if (r.owned && r.child && r.child.exitCode === null) {
        r.upstreamHost = openHost;
        r.state = 'running';
        r.conflictDir = null;
        return;
      }
      // External listener: verify ownership by cwd before adopting. A dev server
      // you started by hand FROM the project dir is yours (matching cwd); a
      // stray process squatting the port is not.
      const cwd = resolvePidCwd(project.port); // null when lsof unavailable/unresolved
      if (cwd === null) {
        // Cannot determine cwd (lsof missing, etc.) -> degrade to the legacy
        // adopt rather than blocking a possibly-legitimate server.
        log(`adopt: ${host} port ${project.port} busy, cwd unresolved -> adopting (external, unverified)`);
        r.upstreamHost = openHost;
        r.state = 'running';
        r.owned = false;
        r.child = null;
        r.pid = null;
        r.conflictDir = null;
        return;
      }
      if (sameDir(cwd, project.dir)) {
        log(`adopt: ${host} external listener cwd matches ${project.dir} -> adopting`);
        r.upstreamHost = openHost;
        r.state = 'running';
        r.owned = false;
        r.child = null;
        r.pid = null;
        r.conflictDir = null;
        return;
      }
      // Mismatch: someone else owns this port. Do NOT proxy — surface a visible
      // conflict and reject so no caller ever pipes a request to the foreigner.
      log(`conflict: ${host} port ${project.port} held by process in ${cwd} (expected ${project.dir}) -> conflict`);
      r.state = 'conflict';
      r.owned = false;
      r.child = null;
      r.pid = null;
      r.upstreamHost = null;
      r.conflictDir = cwd; // remember foreign cwd for status/dashboard detail
      const e = new Error('portConflict');
      e.code = 'PORT_CONFLICT';
      e.host = host;
      e.conflictDir = cwd;
      throw e; // rejects startPromise -> handleRequest/handleUpgrade/up never proxy
    }

    // Need to spawn. Install (if needed) and start are ONE atomic operation, so
    // a second concurrent request never launches a second install.
    // First start with no deps installed -> install them before starting.
    const nodeModules = path.join(project.dir, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
      r.state = 'installing';
      const ok = await runInstall(project, r);
      if (!ok) {
        // Install failed/timed out — runInstall already killed it on timeout,
        // but a non-zero exit leaves the child reaped; make sure the group dies.
        killGroup(r, 'SIGKILL');
        r.state = 'stopped';
        r.owned = false;
        r.child = null;
        r.pid = null;
        const e = new Error('installFailed');
        e.code = 'START_TIMEOUT'; // route through the existing 502-with-log page
        e.host = host;
        throw e;
      }
    }

    const logFd = logFdFor(host);
    log(`start: ${host} -> sh -c '${project.startCmd}' (cwd=${project.dir}, PORT=${project.port})`);
    let child;
    try {
      child = spawn('sh', ['-c', project.startCmd], {
        cwd: project.dir,
        env: {
          ...process.env,
          PORT: String(project.port),
          FORCE_COLOR: '1',
          BROWSER: 'none',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        detached: true, // own process-group leader -> kill -pid kills the group
        stdio: ['ignore', logFd, logFd],
      });
    } catch (err) {
      if (typeof logFd === 'number') {
        try {
          fs.closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
      r.state = 'stopped';
      r.owned = false;
      r.child = null;
      r.pid = null;
      throw err;
    }

    // We hold the fd open via the child's stdio; close our copy.
    if (typeof logFd === 'number') {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }

    r.child = child;
    r.pid = child.pid;
    r.owned = true;
    r.state = 'starting';

    child.on('exit', (code, signal) => {
      log(`exit: ${host} pid=${child.pid} code=${code} signal=${signal}`);
      // Only flip to stopped if this is still the active child.
      if (r.child === child) {
        r.state = 'stopped';
        r.child = null;
        r.pid = null;
        r.owned = false;
      }
    });
    child.on('error', (err) => {
      log(`spawn-error: ${host}: ${err.message}`);
    });

    try {
      const upHost = await waitForPort(project.port, config.startTimeoutMs);
      r.upstreamHost = upHost; // pin the family that answered (Vite -> ::1)
      r.state = 'running';
      r.owned = true;
      log(`ready: ${host} listening on ${upHost}:${project.port}`);
    } catch (err) {
      // Start timed out — kill the whole group and surface logs to the caller.
      log(`start-timeout: ${host} did not open :${project.port} within ${config.startTimeoutMs}ms`);
      killGroup(r, 'SIGKILL');
      r.state = 'stopped';
      r.owned = false;
      r.child = null;
      r.pid = null;
      const e = new Error(`startTimeout`);
      e.code = 'START_TIMEOUT';
      e.host = host;
      throw e;
    }
  })();

  try {
    await r.startPromise;
  } finally {
    r.startPromise = null;
  }
  return r;
}

function killGroup(r, signal) {
  const pid = r.pid;
  if (!pid) return;
  try {
    // negative pid => the whole process group (child is group leader via detached)
    process.kill(-pid, signal);
  } catch {
    // group gone or single process — try the bare pid
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}

// Stop an OWNED project. No-op (with reason) for external / already-stopped.
function stop(host, reason = 'manual') {
  const r = runtime.get(host);
  if (!r) return { ok: false, reason: 'unknown host' };
  if (!r.owned || !r.pid) {
    return { ok: false, reason: 'not owned by lazydev' };
  }
  const pid = r.pid;
  log(`stop: ${host} (pid group ${pid}, ${reason}) -> SIGTERM`);
  killGroup(r, 'SIGTERM');
  // Escalate to SIGKILL if still alive after 5s.
  setTimeout(() => {
    try {
      // signal 0 = liveness check
      process.kill(-pid, 0);
      log(`stop: ${host} still alive after 5s -> SIGKILL`);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* already gone */
    }
  }, 5000);
  r.state = 'stopped';
  r.owned = false;
  r.child = null;
  r.pid = null;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function htmlPage(title, bodyInner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 0; padding: 3rem 1.5rem; max-width: 860px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: #1115; padding: 1rem; border-radius: 8px; overflow:auto; font-size: 12.5px; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul { padding-left: 1.2rem; }
  .muted { opacity: 0.65; }
</style></head><body>${bodyInner}</body></html>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function availableList() {
  const items = config.projects
    .filter((p) => p.enabled)
    .map((p) => `<li><a href="http://${esc(p.host)}.localhost/">http://${esc(p.host)}.localhost</a> <span class="muted">(${esc(p.framework || 'node')})</span></li>`)
    .join('');
  return `<ul>${items || '<li class="muted">no enabled projects</li>'}</ul>`;
}

function sendHtml(res, status, title, inner) {
  const body = htmlPage(title, inner);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// True only for loopback: IPv4 127.0.0.0/8, IPv6 ::1, and IPv4-mapped IPv6 like
// ::ffff:127.0.0.1. Everything else (LAN IPs, 0.0.0.0, '', undefined) is false.
// Used to fail-closed on any request that did not arrive on a loopback bind.
function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  let a = addr;
  // Strip an IPv4-mapped IPv6 prefix so ::ffff:127.0.0.1 is judged as 127.0.0.1.
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) a = mapped[1];
  if (a === '::1') return true;
  // IPv4 127.0.0.0/8
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) return Number(m[1]) === 127;
  return false;
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

function liveState(host, project) {
  const r = runtime.get(host);
  const la = lastAccess.get(host) || 0;
  let state = r ? r.state : 'stopped';
  let owned = r ? r.owned : false;
  return {
    host,
    url: `http://${host}.localhost`,
    port: project.port,
    enabled: project.enabled !== false,
    framework: project.framework || 'node',
    state,
    owned,
    conflict: state === 'conflict',
    conflictDir: r ? r.conflictDir || null : null,
    lastAccess: la || null,
    idleForMs: la ? Date.now() - la : null,
  };
}

function statusPayload() {
  return {
    uptimeMs: Date.now() - STARTED_AT,
    idleTimeoutMs: config.idleTimeoutMs,
    projects: config.projects.map((p) => liveState(p.host, p)),
  };
}

async function handleControl(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  // Dashboard home (host key === lazydev, path /)
  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    return sendHtml(res, 200, 'lazydev', dashboardHtml());
  }

  if (method === 'GET' && pathname === '/__lazydev/status') {
    return sendJson(res, 200, statusPayload());
  }

  if (method === 'POST' && pathname === '/__lazydev/reload') {
    const ok = loadConfig('control:reload');
    return sendJson(res, ok ? 200 : 500, { ok });
  }

  if (method === 'POST' && pathname.startsWith('/__lazydev/stop/')) {
    const host = decodeURIComponent(pathname.slice('/__lazydev/stop/'.length));
    const result = stop(host, 'control');
    return sendJson(res, 200, result);
  }

  if (method === 'POST' && pathname.startsWith('/__lazydev/up/')) {
    const host = decodeURIComponent(pathname.slice('/__lazydev/up/'.length));
    const project = projectByHost(host);
    if (!project) return sendJson(res, 404, { ok: false, reason: 'unknown host' });
    if (project.enabled === false) return sendJson(res, 409, { ok: false, reason: 'disabled' });
    try {
      await ensureUp(project);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 502, { ok: false, reason: err.code || err.message });
    }
  }

  // GET requests to /__lazydev/* that aren't matched, or anything else.
  return sendHtml(res, 404, 'lazydev — not found', `<h1>lazydev</h1><p class="muted">No such control endpoint: <code>${esc(method)} ${esc(pathname)}</code></p>${dashboardHomeLink()}`);
}

function dashboardHomeLink() {
  return `<p><a href="http://lazydev.localhost/">&larr; lazydev dashboard</a></p>`;
}

function stateBadge(state, owned) {
  if (state === 'running') {
    return owned
      ? '<span style="background:#16a34a;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px">running</span>'
      : '<span style="background:#0891b2;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px">running (external)</span>';
  }
  if (state === 'starting') {
    return '<span style="background:#d97706;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px">starting</span>';
  }
  if (state === 'installing') {
    return '<span style="background:#7c3aed;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px">installing</span>';
  }
  if (state === 'conflict') {
    return '<span style="background:#dc2626;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px">conflict</span>';
  }
  return '<span style="background:#64748b;color:#fff;padding:2px 8px;border-radius:999px;font-size:12px">sleeping</span>';
}

function fmtIdle(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function dashboardHtml() {
  const rows = config.projects
    .map((p) => {
      const ls = liveState(p.host, p);
      const enabledNote = ls.enabled ? '' : ' <span class="muted">(disabled)</span>';
      const sleepBtn = ls.owned && ls.state !== 'stopped'
        ? `<button onclick="sleepHost('${esc(p.host)}')">Sleep</button>`
        : `<button disabled>Sleep</button>`;
      // On conflict, hovering the state cell explains which foreign cwd holds it.
      const stateTitle = ls.state === 'conflict' && ls.conflictDir
        ? ` title="port held by ${esc(ls.conflictDir)}"`
        : '';
      return `<tr>
        <td><a href="http://${esc(p.host)}.localhost/">http://${esc(p.host)}.localhost</a>${enabledNote}</td>
        <td>${esc(ls.framework)}</td>
        <td${stateTitle}>${stateBadge(ls.state, ls.owned)}</td>
        <td>${ls.state === 'running' ? fmtIdle(ls.idleForMs) : '—'}</td>
        <td>${sleepBtn}</td>
      </tr>`;
    })
    .join('');

  return `<h1>lazydev</h1>
  <p class="muted">On-demand local dev proxy · uptime ${fmtIdle(Date.now() - STARTED_AT)} · idle sleep after ${Math.round(config.idleTimeoutMs / 60000)}m</p>
  <style>
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.5rem 0.7rem; border-bottom: 1px solid #8884; }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
    button { font: inherit; padding: 3px 12px; border-radius: 6px; border: 1px solid #8886;
             background: transparent; cursor: pointer; }
    button:disabled { opacity: .4; cursor: default; }
    button:not(:disabled):hover { background: #8882; }
  </style>
  <table>
    <thead><tr><th>Project</th><th>Framework</th><th>State</th><th>Idle</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">No projects registered.</td></tr>'}</tbody>
  </table>
  <script>
    async function sleepHost(h) {
      try {
        await fetch('/__lazydev/stop/' + encodeURIComponent(h), { method: 'POST' });
      } catch (e) {}
      location.reload();
    }
    setTimeout(() => location.reload(), 5000);
  </script>`;
}

// ---------------------------------------------------------------------------
// Reverse proxy (HTTP)
// ---------------------------------------------------------------------------

// Order the loopback families to try: the one we detected first, the other as
// fallback. `::1` must be passed as the `host` option (never embedded in a URL
// string) so Node connects over IPv6 correctly.
function loopbackOrder(preferred) {
  if (preferred === '::1') return ['::1', '127.0.0.1'];
  if (preferred === '127.0.0.1') return ['127.0.0.1', '::1'];
  return [...LOOPBACK_HOSTS];
}

// Keep-alive pool for upstream connections. Reusing sockets is the right call
// for a local proxy (asset bursts, HMR polling) — but ONLY because we now pipe
// the request immediately below. The previous version gated `req.pipe()` on the
// socket's 'connect' event; a pooled (already-connected) socket never re-emits
// 'connect', so every reused request stalled until the upstream's ~5s
// keepAliveTimeout closed it. That was the "weirdly slow" bug.
const upstreamAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 256 });

function proxyHttp(req, res, project) {
  const host = project.host;
  const r = runtime.get(host);
  // ensureUp() already probed both loopback families and pinned the one that
  // answered (Vite -> ::1, Next -> 127.0.0.1), so we proxy straight to it — no
  // per-request family race, which lets us pipe the body immediately.
  const upHost = (r && r.upstreamHost) || loopbackOrder(r && r.upstreamHost)[0];

  const upstream = http.request(
    {
      host: upHost,
      port: project.port,
      method: req.method,
      path: req.url,
      headers: req.headers, // preserve original Host header for multi-tenant apps
      agent: upstreamAgent,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
      upRes.on('error', () => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
    }
  );

  upstream.on('error', (err) => {
    log(`proxy-error: ${host}: ${err.code || err.message} on ${upHost}:${project.port}`);
    if (!res.headersSent) {
      sendHtml(
        res,
        502,
        'lazydev — upstream error',
        `<h1>Upstream connection failed</h1>
         <p>Could not reach <code>${esc(host)}</code> on <code>${esc(upHost)}:${project.port}</code>.</p>
         <p class="muted">${esc(err.message)}</p>${dashboardHomeLink()}`
      );
    } else {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  req.on('error', () => {
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  });

  // Pipe immediately — correct for BOTH a fresh socket and a pooled
  // already-connected one. (Piping also calls upstream.end() when req ends,
  // which flushes bodyless GETs.)
  req.pipe(upstream);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

// Every loopback listener we bind under RUN_AS_MAIN, so shutdown() can close
// them all (127.0.0.1 primary + ::1 best-effort).
const daemonServers = [];

// Build a daemon HTTP server: the request try/catch wrapper plus the upgrade
// (WebSocket/HMR) handler, both fail-closed against non-loopback binds. Called
// once per loopback listener under RUN_AS_MAIN, and directly by the self-test.
function createDaemonServer() {
  const srv = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      log(`request-handler crash: ${err && err.stack ? err.stack : err}`);
      try {
        if (!res.headersSent) {
          sendHtml(res, 500, 'lazydev — error', `<h1>Internal error</h1><pre>${esc(String(err && err.message))}</pre>`);
        } else {
          res.destroy();
        }
      } catch {
        /* ignore */
      }
    }
  });

  srv.on('upgrade', (req, clientSocket, head) => {
    handleUpgrade(req, clientSocket, head).catch((err) => {
      log(`upgrade-handler crash: ${err && err.message}`);
      try {
        clientSocket.destroy();
      } catch {
        /* ignore */
      }
    });
  });

  return srv;
}

async function handleRequest(req, res) {
  // Fail-closed: only serve requests that arrived on a loopback address. Even if
  // a listener ends up bound to a routable interface, a request from off-box is
  // rejected here rather than reaching the control plane or a dev server.
  if (!isLoopbackAddress(req.socket && req.socket.localAddress)) {
    log(`forbidden: non-loopback request on ${req.socket && req.socket.localAddress}`);
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden\n');
    return;
  }

  const hostHeader = req.headers.host || '';
  const key = resolveHostKey(hostHeader);
  // Parse URL relative to a dummy base; we only need pathname.
  const url = new URL(req.url, 'http://localhost');

  // Control plane: key === lazydev OR path starts with /__lazydev/.
  if (key === 'lazydev' || url.pathname.startsWith('/__lazydev/')) {
    return handleControl(req, res, url);
  }

  if (!key) {
    return sendHtml(
      res,
      502,
      'lazydev',
      `<h1>lazydev</h1><p>No project resolved from host <code>${esc(hostHeader)}</code>.</p>
       <p>Available projects:</p>${availableList()}`
    );
  }

  const project = projectByHost(key);
  if (!project) {
    return sendHtml(
      res,
      502,
      'lazydev — no such project',
      `<h1>No project for <code>${esc(key)}</code></h1>
       <p>Nothing is registered under that host. Available projects:</p>${availableList()}`
    );
  }

  if (project.enabled === false) {
    return sendHtml(
      res,
      404,
      'lazydev — disabled',
      `<h1>${esc(project.host)} is disabled</h1>
       <p class="muted">This project is marked <code>enabled: false</code> in the registry.</p>${dashboardHomeLink()}`
    );
  }

  // Ensure the dev server is up, then proxy.
  try {
    await ensureUp(project);
  } catch (err) {
    if (err && err.code === 'START_TIMEOUT') {
      return sendHtml(
        res,
        502,
        'lazydev — start timed out',
        `<h1>${esc(project.host)} failed to start</h1>
         <p>The dev server did not open <code>127.0.0.1:${project.port}</code> within ${Math.round(config.startTimeoutMs / 1000)}s.</p>
         <p>Last lines of <code>logs/${esc(project.host)}.log</code>:</p>
         <pre>${esc(tailLog(project.host, 40))}</pre>${dashboardHomeLink()}`
      );
    }
    return sendHtml(
      res,
      502,
      'lazydev — start error',
      `<h1>${esc(project.host)} could not start</h1><pre>${esc(String(err && err.message))}</pre>
       <p>Log tail:</p><pre>${esc(tailLog(project.host, 40))}</pre>${dashboardHomeLink()}`
    );
  }

  lastAccess.set(project.host, Date.now());
  proxyHttp(req, res, project);
}

// ---------------------------------------------------------------------------
// WebSocket / HMR upgrade proxy
// ---------------------------------------------------------------------------

async function handleUpgrade(req, clientSocket, head) {
  // Fail-closed: same loopback gate as handleRequest, for WS/HMR upgrades.
  if (!isLoopbackAddress(clientSocket && clientSocket.localAddress)) {
    log(`forbidden upgrade: non-loopback on ${clientSocket && clientSocket.localAddress}`);
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  const hostHeader = req.headers.host || '';
  const key = resolveHostKey(hostHeader);

  // Never proxy the control plane over websockets.
  if (key === 'lazydev') {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  const project = key ? projectByHost(key) : null;
  if (!project || project.enabled === false) {
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    await ensureUp(project);
  } catch (err) {
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  lastAccess.set(project.host, Date.now());

  // Connect to the upstream over the detected loopback family (Vite -> ::1),
  // with sequential fallback to the other family on connection failure.
  const r = runtime.get(project.host);
  const hosts = loopbackOrder(r && r.upstreamHost);

  let upstream;
  try {
    let connectErr;
    for (const upHost of hosts) {
      try {
        upstream = await connectOnce(upHost, project.port, 3000);
        if (r) r.upstreamHost = upHost; // remember the family that worked
        break;
      } catch (err) {
        connectErr = err;
      }
    }
    if (!upstream) throw connectErr || new Error('no loopback family accepted');
  } catch (err) {
    log(`ws-connect-error: ${project.host}: ${err.message}`);
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  const teardown = () => {
    try {
      clientSocket.destroy();
    } catch {
      /* ignore */
    }
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  };

  upstream.on('error', (err) => {
    log(`ws-upstream-error: ${project.host}: ${err.message}`);
    teardown();
  });
  upstream.on('close', teardown);
  clientSocket.on('error', teardown);
  clientSocket.on('close', teardown);

  // Socket is already connected — replay the original request line + headers.
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  const h = req.rawHeaders;
  for (let i = 0; i < h.length; i += 2) {
    lines.push(`${h[i]}: ${h[i + 1]}`);
  }
  upstream.write(lines.join('\r\n') + '\r\n\r\n');
  if (head && head.length) upstream.write(head);

  // Bidirectional pipe.
  clientSocket.pipe(upstream);
  upstream.pipe(clientSocket);

  const bump = () => lastAccess.set(project.host, Date.now());
  clientSocket.on('data', bump);
  upstream.on('data', bump);
}

// ---------------------------------------------------------------------------
// Idle reaper
// ---------------------------------------------------------------------------

function reapIdle() {
  const now = Date.now();
  for (const project of config.projects) {
    const host = project.host;
    const r = runtime.get(host);
    if (!r) continue;
    // Only reap things WE started.
    if (r.state !== 'running' || !r.owned) continue;
    const la = lastAccess.get(host) || 0;
    if (la === 0) continue; // never accessed; leave it
    const idle = now - la;
    if (idle > config.idleTimeoutMs) {
      const mins = Math.round(idle / 60000);
      const result = stop(host, 'idle');
      if (result.ok) {
        log(`slept ${host} (idle ${mins}m)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signals & global error handling — the daemon must never die.
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});

process.on('SIGHUP', () => {
  log('SIGHUP -> reloading config');
  try {
    loadConfig('SIGHUP');
  } catch (err) {
    log(`SIGHUP reload failed: ${err.message}`);
  }
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} -> stopping all owned children`);
  for (const [host, r] of runtime.entries()) {
    if (r.owned && r.pid) {
      killGroup(r, 'SIGTERM');
      log(`shutdown: SIGTERM ${host} (pid group ${r.pid})`);
    }
  }
  // Give children a moment to exit, then go.
  setTimeout(() => {
    for (const srv of daemonServers) {
      try {
        srv.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }, 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Only auto-boot when run directly (e.g. via launchd / CLI). When imported by a
// unit test, skip listening so pure helpers (inferInstallCmd, connectLoopback…)
// can be exercised without occupying :4000 or spawning anything.
const RUN_AS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_AS_MAIN) {
  loadConfig('boot');
  startConfigWatch();
  // Reaper cadence is 30s in production. LAZYDEV_REAP_INTERVAL_MS exists solely so
  // the bundled self-test can exercise the idle reaper quickly (same spirit as the
  // LAZYDEV_CONFIG override). Production never sets it.
  const REAP_INTERVAL_MS = Number(process.env.LAZYDEV_REAP_INTERVAL_MS) || 30_000;
  setInterval(reapIdle, REAP_INTERVAL_MS).unref?.();

  // Bind loopback only, in two families. 127.0.0.1 is the primary front door
  // (Caddy proxies here) — a port collision there is fatal. ::1 is best-effort:
  // some machines have no IPv6 loopback, so a bind failure there must never take
  // the daemon down. Nothing off this box can reach either address.
  const primary = createDaemonServer();
  daemonServers.push(primary);
  primary.on('error', (err) => {
    log(`server error (127.0.0.1): ${err && err.message}`);
    if (err && err.code === 'EADDRINUSE') {
      log(`FATAL: 127.0.0.1:${config.port} already in use; exiting`);
      process.exit(1);
    }
  });
  primary.listen(config.port, '127.0.0.1', () => {
    log(`lazydev listening on 127.0.0.1:${config.port} (config=${CONFIG_PATH})`);
    log(`dashboard: http://lazydev.localhost/  (or http://127.0.0.1:${config.port}/ with Host: lazydev.localhost)`);
  });

  const secondary = createDaemonServer();
  daemonServers.push(secondary);
  secondary.on('error', (err) => {
    // Best-effort: never fatal. Keep serving on 127.0.0.1 regardless.
    log(`note: IPv6 loopback [::1]:${config.port} unavailable (${err && err.code || err && err.message}); serving on 127.0.0.1 only`);
  });
  secondary.listen(config.port, '::1', () => {
    log(`lazydev also listening on [::1]:${config.port}`);
  });
}

// Exported for the bundled self-test (no behavior change for the daemon itself).
export { resolveHostKey, loadConfig, inferInstallCmd, connectLoopback, probePort, LOOPBACK_HOSTS, createDaemonServer, isLoopbackAddress, sameDir, __setResolvePidCwd };
