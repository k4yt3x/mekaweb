# Meka Studio

A web interface for [Meka](https://github.com/k4yt3x/meka), served from the Meka host.

Meka Studio is a server you install beside Meka, on Linux, macOS or Windows. It signs you in, serves the interface, and passes your requests to Meka on loopback, so Meka itself is never exposed to your network or the internet. Put Meka Studio behind a Cloudflare Tunnel or an HTTPS proxy, and reach your Meka from any browser, or install it on your phone's Home Screen.

Besides Meka's sessions, memory, skills, schedules, MCP servers, accounts and profiles, Meka Studio adds what Meka leaves to the host:

- **Sign-in** with a password or a passkey, a list of the devices signed in, and a sign-in log.
- **Files** beside each session, as a tree from its working directory: upload, download, move, mention a file in a message, with git's changes marked.
- **An editor** for the files, VS Code's Monaco, that follows what the agent changes on disk.
- **Terminals** in each session's editor tabs, which keep running when you leave, for any device to come back to.
- **Push notifications** when a turn finishes, fails, or waits for your approval or answer, even with the app closed.
- **Data saver** for mobile data, and preferences shared by every device.

This release supports **Meka 0.92.0** and newer.

web.meka.run, the static site that reached Meka straight from the browser, is retired; its last release was Meka Studio 0.23.1.

## Install

See [Installing Meka Studio](docs/install.md). In short, with `~/.config/meka-studio/config.toml` naming Meka's address and its token ([`config/meka-studio.toml`](config/meka-studio.toml) is the example):

```sh
meka-studio user add <username>
meka-studio serve
```

## Develop

Install Node.js 24, npm 11 and the Rust toolchain. Run Meka Studio against a Meka, with its `public_origin` set to the dev server's address:

```toml
listen = "127.0.0.1:4180"
public_origin = "http://localhost:5173"
state_dir = "/tmp/meka-studio-dev"

[meka]
url = "http://127.0.0.1:8080"
token_file = "/tmp/meka-studio-dev/meka-token"
```

```sh
cargo run -- --config dev.toml user add me
cargo run -- --config dev.toml serve
cd web
npm ci
npm run dev
```

The dev server passes `/api` and `/meka` to Meka Studio at `MEKA_STUDIO_GATEWAY`, `http://127.0.0.1:4180` unless set. See [Development](docs/development.md) for the checks and releases.

## Documentation

- [Installing Meka Studio](docs/install.md): Meka and Meka Studio as services, HTTPS, and your phone
- [Using Meka Studio](docs/usage.md): signing in, Files, the terminal, notifications, and Data saver
- [API support](docs/api-coverage.md): supported Meka operations and limits
- [Architecture](docs/architecture.md): the server, the interface, and their invariants
- [Development](docs/development.md): layout, checks, and releases
- [Changelog](CHANGELOG.md)

## License

Copyright (c) 2026 K4YT3X.

Licensed under the **GNU Affero General Public License, version 3 or later** (`AGPL-3.0-or-later`). See [LICENSE](LICENSE). Third-party components retain their respective licenses; see [third-party notices](docs/third-party.md).
