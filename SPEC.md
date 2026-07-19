# architecture

How lazydev is put together, for anyone who wants to change it. The user-facing
story is in [README.md](README.md); this is the internals.

## topology

```
browser  ->  http://<host>.localhost            (e.g. http://webapp.localhost)
         ->  Caddy on :80   (wildcard *.localhost -> localhost:4000)
         ->  lazydev daemon on :4000
               - parse Host header -> project
               - ensure that project's dev server is running (start if cold)
               - reverse-proxy the request (HTTP + WebSocket/HMR) to its port
               - record lastAccess; a reaper sleeps idle projects
         ->  the project's dev server on its own fixed port (e.g. :3000)
```

Caddy owns port 80 and forwards every `*.localhost` request to the daemon. The
daemon is the brain: it maps hostnames to projects, starts and stops dev servers
on demand, proxies traffic, and reaps idle projects. Each dev server runs on its
own fixed port. The daemon has zero npm dependencies, Node built-ins only.

## files

| File | Purpose |
|------|---------|
| `lazydev.mjs` | the proxy + lifecycle daemon (Node ESM, zero deps) |
| `scan.mjs` | scans `$HOME` for projects, writes and merges `projects.json` |
| `projects.json` | the registry (gitignored; see `projects.example.json`) |
| `lazydev` | the CLI (bash) |
| `install.sh` | writes the launchd plist and Caddyfile block, loads both |
| `uninstall.sh` | reverses the installer |
| `serve_static.py` | optional static server with cleanUrls, for static sites |
| `logs/` | runtime: `daemon.log` plus `<host>.log` per project |

## registry schema

`projects.json` is the single source of truth for what lazydev knows.

```json
{
  "port": 4000,
  "idleTimeoutMs": 1800000,
  "startTimeoutMs": 120000,
  "scanExclude": ["/archive/"],
  "projects": [
    {
      "host": "webapp",
      "dir": "/Users/you/code/webapp",
      "port": 3000,
      "startCmd": "pnpm dev",
      "framework": "next",
      "enabled": true
    }
  ]
}
```

Top level:

- `port` is the daemon's own port (default 4000, what Caddy forwards to).
- `idleTimeoutMs` is how long a project can sit untouched before the reaper sleeps it.
- `startTimeoutMs` is how long the daemon waits for a cold server to answer before giving up.
- `scanExclude` is an optional list of path substrings `scan` skips.

Per project:

- `host` is the subdomain label. The URL is `http://<host>.localhost`. Must be unique.
- `dir` is the absolute project directory. It may contain spaces, so it is passed as `cwd`, never interpolated into a shell string.
- `port` is the fixed port lazydev runs, health-checks, and proxies this project on.
- `startCmd` is the command run with `cwd=dir`. The daemon injects `PORT=<port>` into the environment. Vite ignores `PORT`, so Vite start commands must pass `--port <port> --strictPort` explicitly.
- `framework` is one of `next | vite | cra | astro | remix | sveltekit | node`, informational.
- `enabled` false keeps the project registered but parked; the daemon returns a disabled page and never starts it.

## host resolution

Given the incoming `Host` header:

1. Strip any `:port` suffix and a trailing `.localhost`.
2. Of the remaining dot-separated labels, the project key is the last one.
   - `webapp.localhost` resolves to `webapp`
   - `tenant.webapp.localhost` also resolves to `webapp`, and the original Host header is preserved upstream so the app's own multi-tenant logic still sees `tenant`
3. Look up an enabled project whose `host` equals that key. A miss returns a friendly page listing the available `*.localhost` URLs.

That last-label rule is why the Caddyfile matches both `*.localhost` and `*.*.localhost`.

## lifecycle notes

- Dev servers spawn as process-group leaders, so sleeping a project kills the whole tree with one signal (the package manager, the framework under it, its workers). Nothing is left squatting the port.
- Health probes try both loopbacks. On some machines `localhost` resolves only to `::1`, and plenty of dev servers listen on one family only, so the daemon probes `127.0.0.1` and `::1` separately.
- `scan` merges instead of overwriting: it preserves the port, start command, and enabled flag of any host already in the registry, and only assigns fresh ports to newly discovered projects. Hand-added entries whose directory still exists are carried through untouched.
