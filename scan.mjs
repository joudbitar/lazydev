#!/usr/bin/env node
// lazydev REGISTRY scanner.
// Scans ~ for Node web projects with a `dev` script and writes/merges
// <project-root>/projects.json per the lazydev BUILD CONTRACT (SPEC.md).
// Zero npm deps — Node built-ins only.

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import os from 'node:os';
import { mergeRegistry } from './lib/registry.mjs';

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
// 5. Generate startCmd.
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
// 6. Merge with the existing registry (loaded in step 0): assign unique hosts
//    (never RESERVED_HOST), preserve port/enabled/startCmd for known hosts,
//    fresh ports only for new hosts, and carry over hand-added entries whose
//    directory still exists. The merge itself is pure (lib/registry.mjs); we
//    inject the framework-aware helpers and the fs existence check.
// ---------------------------------------------------------------------------
const projects = mergeRegistry({
  existing,
  candidates,
  reservedHost: RESERVED_HOST,
  poolStart: POOL_START,
  poolStep: POOL_STEP,
  startCmdFor,
  sanitizeHost,
  dirExists: existsSync,
});

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
// 7. Report.
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
