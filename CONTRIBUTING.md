# Contributing

The daemon is one Node file with zero npm dependencies, and it stays that way; a PR that adds a dependency will be asked to lose it. `npm test` runs the whole suite with `node --test`, no setup. CI runs it on macOS and Linux, Node 20 and 22.

The PR I'd merge first is the Linux installer: a systemd user unit with `CAP_NET_BIND_SERVICE` so Linux gets the background service and the portless URLs too. The daemon already passes its tests on Linux; only the launchd install in `bin/lazydev.mjs` is macOS.

Ground rules:

- New behavior comes with a test next to the others in `test/`.
- Loopback-only is not negotiable. Read [SECURITY.md](SECURITY.md) before touching anything that listens.
- For anything bigger than a fix, open an issue first so you don't build something that won't merge.
