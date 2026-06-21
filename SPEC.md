# lazydev — on-demand local dev server proxy (BUILD CONTRACT)

`lazydev` makes every local web project reachable at a stable URL
(`http://<host>.localhost`). The dev server is **not** running until the first
request hits that URL; lazydev starts it on demand, proxies the request, and
**stops it again after 30 minutes of inactivity**. Think "Vercel preview URLs,
but local, with sleep/wake."

## Topology (already decided — do not change)

```
browser  ->  http://<host>.localhost            (e.g. http://tradepulse.localhost)
         ->  Caddy on :80   (wildcard *.localhost -> localhost:4000)
         ->  lazydev daemon on :4000
               - parse Host header -> project
               - ensure that project's dev server is running (start if cold)
               - reverse-proxy the request (HTTP + WebSocket/HMR) to its port
               - record lastAccess; a reaper sleeps idle projects
         ->  the project's dev server on its own fixed port (e.g. :3000)
```

## Environment facts (this machine)

- `node` = `/usr/local/bin/node` (v22.12.0). **Zero npm dependencies** — Node built-ins only.
- `pnpm` = `/Users/joudbitar/.npm-global/bin/pnpm`, `npm` = `/Users/joudbitar/.npm-global/bin/npm`.
- `caddy` = `/opt/homebrew/bin/caddy` (Homebrew, runs via `brew services`, Caddyfile at `/opt/homebrew/etc/Caddyfile`).
- HOME = `/Users/joudbitar`. macOS (darwin), zsh.
- Daemon listens on **:4000**. Caddy binds :80 with NO sudo on this machine.

## Files (all under `~/.config/lazydev/`)

| File | Owner agent | Purpose |
|------|-------------|---------|
| `lazydev.mjs` | DAEMON | the proxy + lifecycle daemon (Node ESM, zero deps) |
| `scan.mjs` | REGISTRY | scans `~` for projects, writes/merges `projects.json` |
| `projects.json` | REGISTRY | the registry (schema below) |
| `install.sh` | INSTALLER | writes launchd plist + new Caddyfile, (re)loads both |
| `com.lazydev.proxy.plist.tmpl` or inline | INSTALLER | LaunchAgent template |
| `lazydev` (CLI, bash, executable) | CLI | `ls / status / logs / scan / restart / up / stop` |
| `README.md` | CLI | usage docs |
| `logs/` | (runtime) | `daemon.log` + `<host>.log` per project |

## `projects.json` schema (THE CONTRACT — every agent must honor exactly)

```json
{
  "port": 4000,
  "idleTimeoutMs": 1800000,
  "startTimeoutMs": 120000,
  "projects": [
    {
      "host": "tradepulse",
      "dir": "/Users/joudbitar/tradepulse",
      "port": 3000,
      "startCmd": "pnpm dev",
      "framework": "next",
      "enabled": true
    }
  ]
}
```

- `host` — the subdomain label. URL is `http://<host>.localhost`. Unique.
- `dir` — absolute project dir (may contain spaces; never interpolate it into a shell string — pass as `cwd`).
- `port` — the fixed port lazydev will run/health-check/proxy this project on.
- `startCmd` — shell command run **with cwd=dir**. The daemon injects `PORT=<port>` into the env. For Vite (which ignores `PORT`) the startCmd MUST pass `--port <port> --strictPort` explicitly.
- `framework` — `next|vite|cra|astro|remix|sveltekit|node` (informational).
- `enabled` — if false, daemon returns a 404-style "disabled" page and never starts it.

## Host -> project resolution rule (daemon)

Given the incoming `Host` header:
1. Strip any `:port` suffix and a trailing `.localhost`.
2. Of the remaining dot-separated labels, the project key is the **LAST** one.
   - `tradepulse.localhost` -> `tradepulse`
   - `traypal.localhost` -> `traypal`
   - `trinity.traypal.localhost` -> `traypal`  (subdomains route to the parent project; the original Host header is preserved upstream so the app's own multi-tenant logic still sees `trinity`)
3. Look up an `enabled` project whose `host` equals that key. Miss -> friendly 502/404 HTML listing available `*.localhost` URLs.

## Cutover / port notes

- `tradepulse` is pinned to **3000** (its package.json `dev` is already `next dev -p 3000`); keep it at 3000.
- Two stray dev servers are currently listening on :3000 and :3001 (orphans). The orchestrator will kill them after install so lazydev owns all lifecycle; the daemon must handle "port already in use by something we didn't start" gracefully (see DAEMON spec).
- Projects to register (14): the 5 doctor sites + `doctor-site-template` under `~/Doctors/`, `cut-coach` (`~/life`), `sahtein-menus` (`~/omega`), `dashboard` (`~/sanad`), `tradepulse`, `traypal`, `traypal-menus`, `uwc-lnc-portal` (`~/uwc_lnc`), and `new-project` (`~/Documents/New project`, Vite).
- EXCLUDE: `~/life/memory` (CLI tool, no HTTP) and any `~/tradepulse-marathon-*` worktree.
