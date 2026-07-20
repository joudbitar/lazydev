# lazydev

A local proxy that starts dev servers on demand behind permanent URLs.

Every project on your machine gets a stable address, `http://<name>.localhost`, whether or not its dev server is running. The first request wakes the server; thirty idle minutes put it back to sleep. You stop running `pnpm dev` in fifteen tabs, stop guessing which port is which, and stop feeding RAM to a server you opened on Tuesday.

```
$ lazydev
lazydev  daemon up 1h  ·  sleeps idle projects after 30m

HOST        URL                          STATE     IDLE  PORT
admin       http://admin.localhost       sleeping  —     3020
api         http://api.localhost         running   2m    3040
blog        http://blog.localhost        sleeping  —     3050
docs        http://docs.localhost        sleeping  —     3060
marketing   http://marketing.localhost   sleeping  —     3010
webapp      http://webapp.localhost      running   6s    3000
```

<!-- gif: visit a sleeping project in the browser. the tab spins a few seconds while the server boots, then the app appears. record ~10s with QuickTime or Kap, crop to the browser window. -->

## how it works

Visit `http://<name>.localhost`. If that project's dev server is up, the request is proxied straight to it. If it's asleep, lazydev runs the project's start command, waits for the port to answer, then proxies. After 30 minutes without traffic the server is killed and its port freed. The URL never changes; only the process comes and goes. A cold start of a Next app takes about 8 seconds on my machine, timed with curl.

The CLI:

```
lazydev              status table: every project, URL, state, idle time, port
lazydev open <x>     wake <x> and open it in the browser
lazydev sleep <x>    stop <x> now instead of waiting for the idle timer
lazydev logs <x> -f  tail <x>'s dev-server output
lazydev scan         find new projects and register them
lazydev dash         the status table as a web page, at http://lazydev.localhost
lazydev restart      bounce the daemon
```

To add a project, put it anywhere under your home directory and run `lazydev scan`. Anything with a `dev` script in its `package.json` gets found, assigned a free port, and merged into the registry without touching entries you've edited by hand. Everything else (a static folder, a Python server) is one JSON entry in `projects.json`: name, directory, port, start command.

Hot-module reload works through the proxy; WebSocket connections are piped raw. Subdomains route to their parent project, so `tenant.myapp.localhost` reaches `myapp` with the Host header intact and your app's multi-tenant logic still sees `tenant`.

## run it locally

You need Node 22 and nothing else. One command scans your home directory, wakes the proxy, and prints a URL for every project:

```bash
npx lazydev
```

This runs in the foreground and serves the front door itself, so there is no Caddy and no second process. On macOS it binds port 80 directly, so the URLs are the bare `http://<name>.localhost`. On Linux an unprivileged process cannot take port 80, so it falls back to a numbered port and prints URLs with that port, like `http://webapp.localhost:7420`. Ctrl-C stops it.

Everything it writes goes into one state directory (`$XDG_STATE_HOME/lazydev`, or `~/.local/state/lazydev`): the registry, the logs, the control token. Nothing lands in your project folders. Delete that directory and lazydev is gone, since this path installs no service.

Until lazydev is published to npm, run the entrypoint from a checkout, which is the same code path:

```bash
git clone https://github.com/joudbitar/lazydev ~/lazydev
node ~/lazydev/bin/lazydev.mjs
```

To keep it running after you close the terminal, install it as a background daemon:

```bash
~/lazydev/install.sh
```

The installer detects your platform. On macOS it loads a LaunchAgent; on Linux it writes a systemd user unit with `AmbientCapabilities=CAP_NET_BIND_SERVICE` so the daemon can bind :80 as your own user, then `systemctl --user enable --now` starts it. Both point at the same state directory `npx lazydev` used, so your registry carries over, and both come back on reboot. `lazydev install` and `lazydev uninstall` do the same thing from the linked CLI, and `uninstall.sh` puts everything back. On Linux the installer also enables lingering (`loginctl enable-linger`) so the daemon survives logout; if it cannot, it prints the one command to run.

One Linux wrinkle: browsers resolve `*.localhost` to loopback on their own, but glibc command-line tools on many distributions do not resolve arbitrary `*.localhost` subdomains. Point curl at loopback when you test from the terminal:

```bash
curl --resolve webapp.localhost:80:127.0.0.1 http://webapp.localhost/
```

If the daemon fell back to a numbered port, use that port on both sides (`--resolve webapp.localhost:7420:127.0.0.1 http://webapp.localhost:7420/`). macOS resolves `*.localhost` for CLI tools too, so this is Linux only.

## how it's built

The daemon is one Node file with zero npm dependencies: router, reverse proxy, process supervisor, and idle reaper in about 1,200 lines of built-ins. It serves the front door itself. launchd (or a systemd user unit) keeps it alive. The registry is one JSON file.

The decisions that matter:

- The daemon owns the front door directly. It parses the Host header, reverse-proxies HTTP, and pipes WebSocket and HMR connections raw, so it binds port 80 itself with no second proxy to install. macOS grants an unprivileged process that bind; Linux does not without `CAP_NET_BIND_SERVICE`, so `npx lazydev` falls back to a numbered port and the background service grants the capability. The cost is that a daemon restart briefly drops the front door with it, and https on `*.localhost` is gone until it is a TLS implementation in Node. See `docs/adr/0001-npx-front-door.md` for why that trade won.
- Whatever port it lands on, it binds only the loopback families (127.0.0.1 and ::1) and 403s any request that did not arrive on a loopback address, so nothing off the machine can reach a dev server.
- Dev servers spawn as process-group leaders, so sleeping a project kills the whole tree with one signal: pnpm, the framework under it, its workers. No orphaned process squatting port 3000.
- `*.localhost` resolves to your own machine by web standard (RFC 6761), so there is nothing to set up: no /etc/hosts edits, no custom DNS resolver, no browser proxy config.
- Health probes try both loopbacks. On some Macs `localhost` resolves only to `::1`, and plenty of dev servers listen on one family only; probing `127.0.0.1` and `::1` separately is the difference between "it works" and a mystery 502.
- `scan` merges instead of overwriting, so a rescan never clobbers the port or start command you fixed by hand.

## what it doesn't do

- https, yet. Dropping Caddy dropped its one-line TLS with it, and I am not writing a TLS stack in Node. `*.localhost` stays http.
- Anything except dev servers. Databases, Docker, queues, and tunnels are out of scope. It is also not a production process manager; stopping idle servers is the point here and the opposite of what production wants.

## alternatives

[hotel](https://github.com/typicode/hotel) proved people want this (10k stars) and then went quiet; it starts servers on access but never stops them, and pretty domains need a browser proxy config. [chalet](https://github.com/jeansaad/chalet) is its maintained fork, same model. [puma-dev](https://github.com/puma/puma-dev) has real wake and sleep but is built around Rails and installs its own DNS resolver for `.test`. [rpx](https://github.com/stacksjs/rpx) is the closest living tool, part of the Stacks ecosystem. Use lazydev if you want a permanent URL for every project, your RAM back, and a codebase you can read in one sitting.

## license

MIT
