#!/usr/bin/env node
// lazydev REGISTRY scanner.
// Scans ~ for Node web projects with a `dev` script and writes/merges
// <project-root>/projects.json per the lazydev BUILD CONTRACT (SPEC.md).
// Zero npm deps — Node built-ins only.

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
// Self-locate: write the registry next to this script (project root), not a
// hardcoded ~/.config path, so the project is relocatable. HOME below is still
// the directory tree we SCAN for projects.
const CONFIG_DIR = import.meta.dirname;
const OUT = join(CONFIG_DIR, 'projects.json');
const MAXDEPTH = 4;

// Heavy / irrelevant dirs we never descend into.
const SKIP = new Set([
  'node_modules', '.git', 'Library', '.Trash', '.cache', '.npm', '.pnpm-store',
  '.vscode', '.next', 'dist', 'build', '.turbo', 'vendor', '.venv', 'venv',
  '__pycache__', 'Applications', '.local', '.config', '.rustup', '.cargo',
  'go', '.docker', '.ollama', '.android', '.gradle', '.m2', 'Music', 'Movies',
  'Pictures', 'Photos Library.photoslibrary',
]);

// Host name we must never emit (the daemon owns it).
const RESERVED_HOST = 'lazydev';

const POOL_START = 3010;
const POOL_STEP = 10;

// Vite-based frameworks ignore the injected PORT env and must take --port explicitly.
const VITE_BASED = new Set(['vite', 'astro', 'remix', 'sveltekit']);

// A "node"-type dev script only counts as a web/dev server if it looks like one.
const SERVER_HINT = /\b(next|vite|astro|remix|svelte|webpack|serve|start|dev-server|nodemon)\b/;

// ---------------------------------------------------------------------------
// 0. Load the existing registry up front: scan config lives there, and the
//    merge in step 7 preserves everything it already knows.
// ---------------------------------------------------------------------------
let existing = null;
if (existsSync(OUT)) {
  try { existing = JSON.parse(readFileSync(OUT, 'utf8')); } catch { existing = null; }
}
const existingByHost = new Map();
if (existing && Array.isArray(existing.projects)) {
  for (const p of existing.projects) {
    if (p && typeof p.host === 'string') existingByHost.set(p.host, p);
  }
}
// Optional registry config: path substrings the scanner must skip.
const scanExclude = existing && Array.isArray(existing.scanExclude) ? existing.scanExclude : [];

// ---------------------------------------------------------------------------
// 1. Walk the home dir, collecting project roots (a dir with a package.json).
// ---------------------------------------------------------------------------
const found = [];
function walk(dir, depth) {
  if (depth > MAXDEPTH) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
    found.push(dir);
    return; // project root — don't descend into its packages/workspaces
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (SKIP.has(e.name)) continue;
    walk(join(dir, e.name), depth + 1);
  }
}
walk(HOME, 0);

// ---------------------------------------------------------------------------
// 2. Exclusion rules (hard skips).
// ---------------------------------------------------------------------------
function isExcluded(dir, framework, dev) {
  // Registry config: skip any dir whose path contains a scanExclude entry.
  if (scanExclude.some((s) => typeof s === 'string' && s && dir.includes(s))) return true;
  // Plain node project whose dev script doesn't look like a web/dev server.
  if (framework === 'node' && !SERVER_HINT.test(dev)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 3. Detection helpers.
// ---------------------------------------------------------------------------
function pmOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function frameworkOf(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return 'next';
  if (deps.vite) return 'vite';
  if (deps['react-scripts']) return 'cra';
  if (deps.astro) return 'astro';
  if (deps['@remix-run/dev']) return 'remix';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  return 'node';
}

function pmRun(pm) {
  switch (pm) {
    case 'pnpm': return 'pnpm dev';
    case 'yarn': return 'yarn dev';
    case 'bun': return 'bun run dev';
    default: return 'npm run dev';
  }
}

function sanitizeHost(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// 4. Build candidate rows.
// ---------------------------------------------------------------------------
const candidates = [];
for (const dir of found) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { continue; }
  const dev = pkg.scripts && pkg.scripts.dev;
  if (!dev) continue;
  const framework = frameworkOf(pkg);
  if (isExcluded(dir, framework, dev)) continue;
  candidates.push({ dir, name: basename(dir), pm: pmOf(dir), framework, dev });
}

// ---------------------------------------------------------------------------
// 5. Assign unique hosts (sanitized basename, collision -> -2, -3, ...).
//    Never emit RESERVED_HOST.
// ---------------------------------------------------------------------------
const used = new Set([RESERVED_HOST]);
// Sort by dir for deterministic collision suffixing.
candidates.sort((a, b) => a.dir.localeCompare(b.dir));
for (const c of candidates) {
  let base = sanitizeHost(c.name) || 'project';
  if (base === RESERVED_HOST) base = `${base}-2`;
  let host = base;
  let n = 1;
  while (used.has(host)) {
    n += 1;
    host = `${base}-${n}`;
  }
  used.add(host);
  c.host = host;
}

// ---------------------------------------------------------------------------
// 6. Generate startCmd.
//    Vite-based: "<pmrun> -- --port <port> --strictPort".
//    PORT-env (next/cra/node): just "<pmrun>" (daemon injects PORT).
// ---------------------------------------------------------------------------
function startCmdFor(framework, pm, port) {
  const run = pmRun(pm);
  if (VITE_BASED.has(framework)) {
    return `${run} -- --port ${port} --strictPort`;
  }
  return run;
}

// ---------------------------------------------------------------------------
// 7. Merge with the existing registry (loaded in step 0): preserve
//    port/enabled/startCmd for known hosts; fresh ports only for new hosts.
// ---------------------------------------------------------------------------

// Ports already taken by anything the registry knows about.
const takenPorts = new Set();
for (const p of existingByHost.values()) {
  if (Number.isFinite(p.port)) takenPorts.add(p.port);
}

function nextFreePort() {
  let p = POOL_START;
  while (takenPorts.has(p)) p += POOL_STEP;
  takenPorts.add(p);
  return p;
}

// Deterministic port assignment for new hosts: sort by host.
const sortedByHost = [...candidates].sort((a, b) => a.host.localeCompare(b.host));
const portByHost = new Map();
for (const c of sortedByHost) {
  const prev = existingByHost.get(c.host);
  if (prev && Number.isFinite(prev.port)) {
    portByHost.set(c.host, prev.port); // preserve existing
  } else {
    portByHost.set(c.host, nextFreePort());
  }
}

// ---------------------------------------------------------------------------
// 8. Build final project objects (back in dir-sorted order).
// ---------------------------------------------------------------------------
const projects = candidates.map((c) => {
  const port = portByHost.get(c.host);
  const prev = existingByHost.get(c.host);
  const startCmd = prev && typeof prev.startCmd === 'string'
    ? prev.startCmd
    : startCmdFor(c.framework, c.pm, port);
  const enabled = prev && typeof prev.enabled === 'boolean' ? prev.enabled : true;
  return {
    host: c.host,
    dir: c.dir,
    port,
    startCmd,
    framework: c.framework,
    enabled,
  };
});

// Carry over registry entries the walk didn't rediscover (hand-added static
// servers, projects outside HOME) as long as their directory still exists.
const discovered = new Set(projects.map((p) => p.host));
for (const [host, prev] of existingByHost) {
  if (discovered.has(host)) continue;
  if (!prev.dir || !existsSync(prev.dir)) continue;
  projects.push(prev);
}

const out = {
  port: existing && Number.isFinite(existing.port) ? existing.port : 4000,
  idleTimeoutMs: existing && Number.isFinite(existing.idleTimeoutMs) ? existing.idleTimeoutMs : 1800000,
  startTimeoutMs: existing && Number.isFinite(existing.startTimeoutMs) ? existing.startTimeoutMs : 120000,
  ...(scanExclude.length ? { scanExclude } : {}),
  projects,
};

mkdirSync(CONFIG_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

// ---------------------------------------------------------------------------
// 9. Report.
// ---------------------------------------------------------------------------
const tilde = (p) => p.replace(HOME, '~');
const rows = [...projects].sort((a, b) => a.port - b.port);
const w = {
  host: Math.max('HOST'.length, ...rows.map((r) => r.host.length)),
  port: Math.max('PORT'.length, ...rows.map((r) => String(r.port).length)),
  fw: Math.max('FRAMEWORK'.length, ...rows.map((r) => r.framework.length)),
  cmd: Math.max('STARTCMD'.length, ...rows.map((r) => r.startCmd.length)),
};
console.log(`\nWrote ${rows.length} projects to ${tilde(OUT)}\n`);
console.log(
  '  ' + 'HOST'.padEnd(w.host) + '  ' + 'PORT'.padEnd(w.port) + '  ' +
  'FRAMEWORK'.padEnd(w.fw) + '  ' + 'STARTCMD'.padEnd(w.cmd) + '  ' + 'DIR'
);
for (const r of rows) {
  console.log(
    '  ' + r.host.padEnd(w.host) + '  ' + String(r.port).padEnd(w.port) + '  ' +
    r.framework.padEnd(w.fw) + '  ' + r.startCmd.padEnd(w.cmd) + '  ' + tilde(r.dir)
  );
}
console.log(`\nTotal: ${rows.length} projects.\n`);
