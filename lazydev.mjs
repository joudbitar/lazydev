#!/usr/bin/env node
// lazydev — on-demand local dev-server proxy daemon.
// Zero npm dependencies. Node v22 built-ins only.
//
// See ./SPEC.md (project root) for the full build contract.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
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

// The control-plane capability token lives next to the registry, so a test that
// points LAZYDEV_CONFIG at a temp file also gets an isolated token file there.
// (CONFIG_DIR is the module's own dir and is NOT overridable; deriving from the
// config file's directory keeps the real repo's control-token untouched in tests.)
const STATE_DIR = path.dirname(CONFIG_PATH);
const CONTROL_TOKEN_PATH = process.env.LAZYDEV_CONTROL_TOKEN_PATH || path.join(STATE_DIR, 'control-token');

const DEFAULTS = {
  port: 4000,
  idleTimeoutMs: 1_800_000, // 30 min
  startTimeoutMs: 120_000, // 2 min
  installTimeoutMs: 300_000, // 5 min
  connectionHardCapMs: 7_200_000, // 2h — a connection silent this long stops deferring the reaper
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
// connections[host] = Set of live connection records { lastByteAt }. A record is
// one proxied keep-alive HTTP socket or one WS/HMR upgrade; `lastByteAt` is the
// last time a byte crossed in either direction. `set.size` is the live count the
// user sees; the reaper only counts records whose silence is within the hard cap.
const connections = new Map();
// Guard so a keep-alive HTTP socket carrying many requests is counted ONCE (add
// a record on first request, decrement on socket close), not once per request.
const CONN_TRACKED = Symbol('lazydevConnTracked');

function projectByHost(host) {
  return config.projects.find((p) => p.host === host);
}

function getRuntime(host) {
  let r = runtime.get(host);
  if (!r) {
    // lastError persists on the record after startPromise clears, so the cold
    // status page can read WHY a background bring-up failed (see ensureUp). phase
    // is derived from `state` by phaseLabel(); we keep a slot but state is truth.
    r = { state: 'stopped', owned: false, child: null, pid: null, startPromise: null, upstreamHost: null, lastError: null, phase: null };
    runtime.set(host, r);
  }
  return r;
}

// Lazily create + return the host's live-connection Set (mirrors getRuntime).
function connSet(host) {
  let s = connections.get(host);
  if (!s) {
    s = new Set();
    connections.set(host, s);
  }
  return s;
}

// Add a live-connection record; returns it so the caller can bump lastByteAt and
// later remove it on socket close.
function addConn(host) {
  const rec = { lastByteAt: Date.now() };
  connSet(host).add(rec);
  return rec;
}

// Remove a record on socket close. Set.delete is idempotent, so wiring this to
// both 'close' and 'error' teardown paths cannot double-count.
function removeConn(host, rec) {
  connSet(host).delete(rec);
}

// Total live sockets for the host — what the status/CLI/dashboard display.
function connCount(host) {
  return connSet(host).size;
}

// Records that still DEFER the reaper: those with a byte within the hard cap. A
// connection silent longer than connectionHardCapMs no longer counts, so an
// abandoned-but-open tab stops protecting the project from the idle reaper.
function activeConnCount(host, now) {
  let n = 0;
  for (const rec of connSet(host)) {
    if (now - rec.lastByteAt <= config.connectionHardCapMs) n++;
  }
  return n;
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
    connectionHardCapMs: Number.isFinite(parsed.connectionHardCapMs) ? parsed.connectionHardCapMs : DEFAULTS.connectionHardCapMs,
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
    // Fresh attempt — clear any failure recorded by a previous bring-up so the
    // status page doesn't show stale wording while this one is in flight.
    r.lastError = null;
    // Probe the port (both loopback families). If something is already
    // listening, adopt it (do NOT spawn) and remember which family answered.
    const openHost = await probePort(project.port, 300);
    if (openHost) {
      r.upstreamHost = openHost;
      // Is it our own owned child, or an external process?
      if (r.owned && r.child && r.child.exitCode === null) {
        r.state = 'running';
      } else {
        r.state = 'running';
        r.owned = false;
        r.child = null;
        r.pid = null;
      }
      return;
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
        // Record before throwing: handleRequest no longer awaits us on the cold
        // path, so the status page reads r.lastError after startPromise clears.
        r.lastError = { code: e.code, message: e.message, at: Date.now() };
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
      // Record before throwing (see install-failed site): the cold status page
      // reads r.lastError after startPromise clears in the finally below.
      r.lastError = { code: e.code, message: e.message, at: Date.now() };
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
  // Escalate to SIGKILL if still alive after 5s. unref() so this lone timer can
  // never keep the process alive on its own — the daemon stays up via its
  // listeners in production, and a test that stop()s a child shouldn't have to
  // wait out this timer to exit.
  const escalate = setTimeout(() => {
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
  escalate.unref?.();
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

// Decide whether a cold-hit request should get the HTML status page (a human in
// a browser navigating) or a plain 503 (curl / XHR / webhook that wants data).
// A real navigation sets Sec-Fetch-Mode: navigate; failing that, the request is
// HTML only if Accept asks for text/html and did NOT lead with application/json
// (curl sends */*, fetch/XHR that wants JSON leads with application/json).
function wantsHtml(req) {
  const sfm = String((req.headers && req.headers['sec-fetch-mode']) || '').toLowerCase();
  if (sfm === 'navigate') return true;
  const accept = String((req.headers && req.headers['accept']) || '');
  const first = accept.split(',')[0].trim().toLowerCase();
  return /text\/html/i.test(accept) && !first.startsWith('application/json');
}

// Map the runtime `state` (the source of truth) to a human phase word for the
// status page. 'failed' is state==='stopped' WITH a recorded lastError; a plain
// 'stopped' before the first probe reads as 'waking'.
function phaseLabel(r) {
  if (r.state === 'installing') return 'installing';
  if (r.state === 'starting') return 'starting';
  if (r.state === 'stopped' && r.lastError) return 'failed';
  return 'waking';
}

// Self-refreshing HTML served on a cold navigation hit. Names the project + its
// phase, tails the install/start log, and — unless the start already failed —
// polls the SAME url with Accept: application/json and reloads once that stops
// returning 503 (i.e. the port answered and the request proxied to the app).
// `r` may be the live runtime record OR a {state, lastError} snapshot taken by
// handleRequest before it re-kicked bring-up; only those two fields are read.
//
// Log tails and the raw failure message can leak filesystem paths, so they are
// shown ONLY to an authorized caller (same-origin + capability token). An
// ordinary browser navigation carries no token, so `authorized` is false and the
// page redacts the log, pointing the user at `lazydev logs <host>` instead.
function statusPageHtml(project, r, authorized = false) {
  const host = project.host;
  const phase = phaseLabel(r);
  // Either the real log tail (authorized) or a redaction notice pointing at the
  // CLI, which reads the log locally where the token isn't needed.
  const logBlock = (lines) =>
    authorized
      ? `<p>Last lines of <code>logs/${esc(host)}.log</code>:</p><pre>${esc(tailLog(host, lines))}</pre>`
      : `<p class="muted">Log output is hidden. Check it with <code>lazydev logs ${esc(host)}</code>.</p>`;
  if (phase === 'failed') {
    // The raw error message can leak paths too — redact it for the unauthorized.
    const reason = authorized
      ? (r.lastError && (r.lastError.message || r.lastError.code)) || 'unknown error'
      : 'The dev server failed to start.';
    // Terminal page: no auto-refresh. Mirror the START_TIMEOUT copy so wording
    // stays consistent, and offer a manual retry link to the same URL.
    return htmlPage(
      `${host} — failed to start`,
      `<h1>${esc(host)} failed to start</h1>
       <p>The dev server did not open <code>127.0.0.1:${project.port}</code> within ${Math.round(config.startTimeoutMs / 1000)}s.</p>
       <p class="muted">${esc(reason)}</p>
       ${logBlock(40)}
       <p><a href="${esc('/')}">Retry</a></p>${dashboardHomeLink()}`
    );
  }
  // Non-terminal: waking / installing / starting. Show recent log output (may be
  // the '(no log output captured)' sentinel this early — that's fine) and a poll
  // loop that hands off to the app without a manual reload once the port answers.
  return htmlPage(
    `${host} — ${phase}`,
    `<h1>${esc(host)} is ${esc(phase)}</h1>
     <p class="muted">lazydev is bringing this project up. This page reloads into the app automatically once it answers.</p>
     ${logBlock(20)}${dashboardHomeLink()}
     <noscript><meta http-equiv="refresh" content="2"></noscript>
     <script>
       // Poll the same URL asking for JSON: while bringing up, handleRequest
       // returns 503; once the port answers the request proxies to the app and
       // the status is no longer 503 — that edge is our cue to reload.
       setInterval(async () => {
         try {
           const res = await fetch(location.href, { headers: { 'accept': 'application/json' }, cache: 'no-store' });
           if (res.status !== 503) location.reload();
         } catch (e) { /* daemon momentarily unreachable; keep polling */ }
       }, 1000);
     </script>`
  );
}

// Cold-hit answer for non-navigation clients (curl / XHR / webhook): a plain
// 503 with Retry-After and NO HTML body, so simple clients keep retrying and
// the status-page poll gets its 503 signal.
function sendRetry(res, project, r) {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' });
  res.end(phaseLabel(r) + '\n');
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
// Control-plane authorization: capability token + same-origin check
// ---------------------------------------------------------------------------

// The token authorizes every mutating control action (reload / stop / up) and
// the log-tail exposure on error pages. It is minted lazily — never at import
// time — so a bare `import` in a unit test writes nothing to disk unless that
// test opts in by calling ensureControlToken().
let CONTROL_TOKEN = null;
function ensureControlToken() {
  if (CONTROL_TOKEN) return CONTROL_TOKEN;
  // Reuse a token already on disk (survives daemon restarts so open CLI/tabs
  // keep working); otherwise mint one.
  try {
    const existing = fs.readFileSync(CONTROL_TOKEN_PATH, 'utf8').trim();
    if (existing) {
      CONTROL_TOKEN = existing;
      return CONTROL_TOKEN;
    }
  } catch {
    /* not present yet */
  }
  const tok = crypto.randomBytes(32).toString('hex');
  try {
    ensureDir(path.dirname(CONTROL_TOKEN_PATH));
    fs.writeFileSync(CONTROL_TOKEN_PATH, tok + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(CONTROL_TOKEN_PATH, 0o600);
    } catch {
      /* ignore */
    }
  } catch (err) {
    log(`control-token: could not persist to ${CONTROL_TOKEN_PATH} (${err.message}); using in-memory token`);
  }
  CONTROL_TOKEN = tok;
  return CONTROL_TOKEN;
}

// A control request is same-origin when it has NO Origin header (non-browser
// caller, e.g. the CLI) OR its Origin host matches the daemon's own Host header.
// A foreign Origin (some other site's page POSTing here) is refused. CSRF only
// applies to browser-driven cross-site requests; the CLI is not a browser, so
// the token alone is its proof.
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / CLI — no browser Origin to forge
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const selfHost = String(req.headers.host || '').toLowerCase();
  return originHost.toLowerCase() === selfHost;
}

// Authorized == same-origin AND correct token. Both are required for every
// mutating control action and for exposing log tails on error pages.
function isControlAuthorized(req) {
  if (!isSameOrigin(req)) return false;
  const tok = req.headers['x-lazydev-token'];
  return typeof tok === 'string' && tok.length > 0 && tok === ensureControlToken();
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
    lastAccess: la || null,
    idleForMs: la ? Date.now() - la : null,
    connCount: connCount(host),
    activeConnCount: activeConnCount(host, Date.now()),
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

  // One guard for every mutating control action: reject any POST /__lazydev/*
  // that is not both same-origin AND carrying the capability token. GET / and
  // GET /__lazydev/status stay ungated so the CLI's read path and the dashboard
  // load keep working; neither exposes anything sensitive.
  if (method === 'POST' && pathname.startsWith('/__lazydev/') && !isControlAuthorized(req)) {
    return sendJson(res, 403, { ok: false, reason: 'unauthorized' });
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
  // The dashboard is served same-origin, so injecting the control token into its
  // inline script is safe: the browser's same-origin policy stops other sites
  // reading this HTML. The Sleep button's fetch sends it back as a header, which
  // authorizes the stop POST. JSON.stringify quotes/escapes it for JS string use.
  const token = ensureControlToken();
  const rows = config.projects
    .map((p) => {
      const ls = liveState(p.host, p);
      const enabledNote = ls.enabled ? '' : ' <span class="muted">(disabled)</span>';
      const sleepBtn = ls.owned && ls.state !== 'stopped'
        ? `<button onclick="sleepHost('${esc(p.host)}')">Sleep</button>`
        : `<button disabled>Sleep</button>`;
      return `<tr>
        <td><a href="http://${esc(p.host)}.localhost/">http://${esc(p.host)}.localhost</a>${enabledNote}</td>
        <td>${esc(ls.framework)}</td>
        <td>${stateBadge(ls.state, ls.owned)}</td>
        <td>${ls.state === 'running' ? fmtIdle(ls.idleForMs) : '—'}</td>
        <td>${ls.connCount}</td>
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
    <thead><tr><th>Project</th><th>Framework</th><th>State</th><th>Idle</th><th>Conn</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">No projects registered.</td></tr>'}</tbody>
  </table>
  <script>
    async function sleepHost(h) {
      try {
        await fetch('/__lazydev/stop/' + encodeURIComponent(h), {
          method: 'POST',
          headers: { 'X-Lazydev-Token': ${JSON.stringify(token)} },
        });
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

  // Count the client SOCKET once, not per request: a browser holds a keep-alive
  // socket open across navigations (often with zero in-flight requests) — those
  // are exactly the "live tab" sockets the reaper must defer to. Guard with a
  // symbol so a reused socket doesn't add a second record (only one 'close'
  // fires, so per-request counting would inflate the count and leak records).
  const cs = req.socket;
  if (cs && !cs[CONN_TRACKED]) {
    cs[CONN_TRACKED] = true;
    const rec = addConn(host);
    cs.__lazydevRec = rec;
    cs.once('close', () => removeConn(host, rec));
    // A single 'data' listener keeps lastByteAt fresh on real traffic; a truly
    // silent keep-alive socket ages past the hard cap and stops deferring.
    cs.on('data', () => {
      rec.lastByteAt = Date.now();
    });
  }
  if (cs && cs.__lazydevRec) cs.__lazydevRec.lastByteAt = Date.now();

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

  const r = getRuntime(project.host);

  // Warm path: the project is running AND a probe/adopt already pinned the
  // family that answered. upstreamHost is the honest "port answered" signal, so
  // this is the only case where we proxy straight through (WS/HMR keep working).
  if (r.state === 'running' && r.upstreamHost) {
    lastAccess.set(project.host, Date.now());
    return proxyHttp(req, res, project);
  }

  // Cold / bringing-up path: do NOT await ensureUp — answer immediately and let
  // the client (or the status page's poll) drive the retry.
  //
  // Snapshot the phase + failure reason BEFORE kicking a fresh attempt below,
  // because kicking ensureUp synchronously clears r.lastError (fresh-attempt
  // reset) — so a page rendered off the live record after the kick would never
  // show the failure that just occurred. The snapshot is what the client sees;
  // the kick starts a new bring-up behind it so a reload lands on the app.
  const snapshot = { state: r.state, lastError: r.lastError };

  // Kick bring-up in the background exactly once. ensureUp claims r.startPromise
  // synchronously before any await (the #9cb548a fix), so calling it here and
  // dropping the promise still yields exactly ONE child for N concurrent hits.
  // The .catch is MANDATORY: since we no longer await, a start-timeout rejection
  // would otherwise surface as an unhandledRejection. lastError is recorded
  // inside ensureUp before it throws, so swallowing the rejection loses nothing.
  if (!r.startPromise) {
    ensureUp(project).catch(() => {});
  }

  // Navigation (browser) -> self-refreshing status page (200 so the browser
  // renders it and runs the poll script instead of showing its own error UI).
  // A failed start renders the failure reason + log tail in that same page, but
  // only for an authorized caller — an ordinary navigation carries no token, so
  // the log/error is redacted (see statusPageHtml).
  if (wantsHtml(req)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(statusPageHtml(project, snapshot, isControlAuthorized(req)));
    return;
  }

  // Everything else (curl / XHR / webhook, including the status page's own poll)
  // -> plain 503 with Retry-After, no HTML. Also covers the failed state: keep
  // it 503 so simple clients keep retrying; the failure detail is for humans.
  return sendRetry(res, project, snapshot);
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

  // Count this WS/HMR socket as one live connection. The record is created here,
  // after the upstream connected, so a failed-connect path above never leaks one.
  // teardown runs on 'error'/'close'/'end' of either socket; Set.delete is
  // idempotent, so removeConn is safe to call more than once.
  const rec = addConn(project.host);

  const teardown = () => {
    removeConn(project.host, rec);
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
  upstream.on('end', teardown);
  clientSocket.on('error', teardown);
  clientSocket.on('close', teardown);
  // A closed browser tab FIN-half-closes its HMR socket. Because the upstream
  // pipe keeps the socket's writable side open, 'close' never fires — so without
  // also tearing down on 'end', the record (and the socket pair) would leak and
  // the connection would keep deferring the reaper forever. Reap on either FIN.
  clientSocket.on('end', teardown);

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

  // Bump keeps both the idle clock (lastAccess) and this connection's byte clock
  // (rec.lastByteAt) fresh, so an actively-used HMR socket keeps deferring the
  // reaper while a silent one ages past the hard cap.
  const bump = () => {
    const t = Date.now();
    lastAccess.set(project.host, t);
    rec.lastByteAt = t;
  };
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
    // Only reap things WE started (adoption sets owned=false), so an external /
    // adopted dev server is never touched no matter how idle it looks.
    if (r.state !== 'running' || !r.owned) continue;
    // A live tab or active HMR socket (bytes within the hard cap) defers the
    // reap. A socket silent past connectionHardCapMs drops out of `active`, so an
    // abandoned tab stops protecting the project — it does NOT gate byte activity.
    const active = activeConnCount(host, now);
    if (active > 0) continue;
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
  // Mint (or reuse) the control token before the first request, so the file
  // exists for the CLI to read and the dashboard HTML can embed it.
  ensureControlToken();
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

// ---------------------------------------------------------------------------
// Self-test accessors
// ---------------------------------------------------------------------------
// The bundled node --test suite drives the reaper deterministically without
// RUN_AS_MAIN (which would listen and set the 30s interval). These expose just
// enough state to force ownership, inject connection presence, and age the idle
// clock — the raw Maps stay encapsulated. Prefixed `__` to signal test-only,
// matching the LAZYDEV_CONFIG / LAZYDEV_REAP_INTERVAL_MS self-test hooks.

// Force runtime fields on a host (e.g. {state:'running', owned:true,
// upstreamHost:'127.0.0.1'}). Needed because adoption forces owned=false, so a
// test that must exercise the REAP path cannot get owned=true via a real GET.
function __setRuntimeForTest(host, patch) {
  Object.assign(getRuntime(host), patch);
  return runtime.get(host);
}

// Inject a live-connection record and return it, so a test can age its
// lastByteAt into the past to synthesize a "silent past the hard cap" socket.
function __addConnForTest(host) {
  return addConn(host);
}

// Drive the idle clock directly for the pure-reaper unit test.
function __setLastAccessForTest(host, ms) {
  lastAccess.set(host, ms);
}

// Snapshot the connection counters for assertions: total live vs. deferring.
function __liveConnInfo(host) {
  return { count: connCount(host), active: activeConnCount(host, Date.now()) };
}

// Exported for the bundled self-test (no behavior change for the daemon itself).
// upstreamAgent is exposed so a test can destroy its pooled keep-alive sockets
// on teardown (they'd otherwise keep the test process from exiting).
export {
  resolveHostKey,
  loadConfig,
  inferInstallCmd,
  connectLoopback,
  probePort,
  LOOPBACK_HOSTS,
  createDaemonServer,
  isLoopbackAddress,
  wantsHtml,
  phaseLabel,
  statusPageHtml,
  getRuntime,
  ensureUp,
  stop,
  upstreamAgent,
  reapIdle,
  __setRuntimeForTest,
  __addConnForTest,
  __setLastAccessForTest,
  __liveConnInfo,
  ensureControlToken,
  isSameOrigin,
  isControlAuthorized,
  CONTROL_TOKEN_PATH,
};
