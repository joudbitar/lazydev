# lazydev

A local proxy that starts dev servers on demand behind permanent URLs.

Every project on your machine gets a stable address, `http://<name>.localhost`, whether or not its dev server is running. The first request wakes the server; thirty idle minutes put it back to sleep. You stop running `pnpm dev` in fifteen tabs, stop guessing which port is which, and stop feeding RAM to a server you opened on Tuesday.

```
$ npx lazydev
lazydev: scanning for projects...

  HOST    PORT  FRAMEWORK  STARTCMD     DIR
  api     3010  next       pnpm dev     ~/code/api
  blog    3020  astro      npm run dev  ~/code/blog
  webapp  3030  vite       pnpm dev     ~/code/webapp

lazydev is serving the front door on :4000 (:80 was unavailable, using :4000).

your projects:
  http://api.localhost:4000
  http://blog.localhost:4000
  http://webapp.localhost:4000

dashboard: http://lazydev.localhost:4000
```

<!-- gif: record `npx lazydev` in a terminal, then visit a sleeping project in the browser. the tab spins a few seconds while the server boots, then the app appears. ~10s with QuickTime or Kap, crop to terminal + browser. -->

## How it works

Visit a project's URL. If its dev server is up, the request is proxied straight to it. If it's asleep, lazydev runs the project's start command, waits for the port to answer, then proxies. After 30 minutes without traffic the server is killed and its port freed. The URL never changes; only the process comes and goes. A cold start of a Next app takes about 8 seconds on my machine, timed with curl.

`*.localhost` resolves to your own machine by web standard (RFC 6761), so there is nothing to set up: no /etc/hosts edits, no custom DNS resolver, no browser proxy config. Hot-module reload works through the proxy; WebSocket connections are piped raw. Subdomains route to their parent project, so `tenant.myapp.localhost` reaches `myapp` with the Host header intact and your app's multi-tenant logic still sees `tenant`.

`npx lazydev` scans your home directory for projects with a `dev` script in their `package.json`, assigns each a free port, and serves in the foreground until Ctrl-C. Everything it writes lands in one state directory (`~/.local/state/lazydev`); nothing touches your project folders, and deleting that directory removes every trace. Anything the scan can't see (a static folder, a Python server) is one JSON entry in its `projects.json`: name, directory, port, start command.

## The persistent install

The npx run serves on :4000, so URLs carry the port. The installed version gets you the portless URLs and survives reboots. macOS, Node 20+, and Caddy (`brew install caddy`):

```bash
git clone https://github.com/joudbitar/lazydev ~/lazydev
~/lazydev/install.sh
lazydev scan
```

`install.sh` loads a LaunchAgent for the daemon and adds a three-line wildcard block to your Caddyfile, then reloads both. No sudo anywhere. `uninstall.sh` puts everything back. It also links a CLI onto your PATH:

```
lazydev              status table: every project, URL, state, idle time, port
lazydev open <x>     wake <x> and open it in the browser
lazydev sleep <x>    stop <x> now instead of waiting for the idle timer
lazydev logs <x> -f  tail <x>'s dev-server output
lazydev scan         find new projects and register them
lazydev dash         the status table as a web page, at http://lazydev.localhost
lazydev restart      bounce the daemon
```

## How it's built

The daemon is one Node file with zero npm dependencies: router, reverse proxy, process supervisor, and idle reaper in about 2,000 lines of built-ins. The registry is one JSON file. On the npx path the daemon serves the front door itself; the installed path puts Caddy on :80 in front and lets launchd keep the daemon alive.

The decisions that matter:

- Port 80 is weirder than it looks. macOS lets a non-root user bind `0.0.0.0:80` but refuses `127.0.0.1:80`, found by installing on a real Mac after the unit tests passed. So Caddy binds `0.0.0.0:80` and 403s any client that isn't loopback, while the npx path never touches `0.0.0.0` at all: it binds loopback on a numbered port and prints URLs that carry it. The full reasoning is in [docs/adr/0001-npx-front-door.md](docs/adr/0001-npx-front-door.md).
- Every listener fails closed. Requests and WebSocket upgrades arriving on a non-loopback address get a 403 even if a bind is ever misconfigured, and the control plane (sleep, restart, config) requires a capability token the daemon mints at boot, so a random web page can't tell your daemon to do anything.
- Dev servers spawn as process-group leaders, so sleeping a project kills the whole tree with one signal: pnpm, the framework under it, its workers. No orphaned process squatting port 3000.
- Health probes try both loopbacks. On some Macs `localhost` resolves only to `::1`, and plenty of dev servers listen on one family only; probing `127.0.0.1` and `::1` separately is the difference between "it works" and a mystery 502.
- `scan` merges instead of overwriting, so a rescan never clobbers the port or start command you fixed by hand.

## What it doesn't do

- Portless URLs from npx alone. `http://webapp.localhost` with no `:4000` needs a listener on :80, which means the Caddy install on macOS or CAP_NET_BIND_SERVICE on Linux. `npx lazydev` runs fine on Linux; the installer is macOS launchd, and a systemd port is the PR I'd merge first.
- https, yet. The installed path is a Caddy config line away; the npx path would need TLS in Node.
- Anything except dev servers. Databases, Docker, queues, and tunnels are out of scope. It is also not a production process manager; stopping idle servers is the point here and the opposite of what production wants.

## Alternatives

[hotel](https://github.com/typicode/hotel) proved people want this (10k stars) and then went quiet; it starts servers on access but never stops them, and pretty domains need a browser proxy config. [chalet](https://github.com/jeansaad/chalet) is its maintained fork, same model. [puma-dev](https://github.com/puma/puma-dev) has real wake and sleep but is built around Rails and installs its own DNS resolver for `.test`. [rpx](https://github.com/stacksjs/rpx) is the closest living tool, part of the Stacks ecosystem. Use lazydev if you want a permanent URL for every project, your RAM back, and a codebase you can read in one sitting.

## License

MIT
