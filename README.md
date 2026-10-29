# mekaweb

A web interface for [meka](https://github.com/k4yt3x/meka), served from the meka host.

mekaweb is a server you install beside meka, on Linux, macOS or Windows. It signs you in, serves the interface, and passes your requests to meka on loopback, so meka itself is never exposed to your network or the internet. Put mekaweb behind a Cloudflare Tunnel or an HTTPS proxy, and reach your meka from any browser, or install it on your phone's Home Screen.

Besides meka's sessions, memory, skills, schedules, MCP servers, accounts and profiles, mekaweb adds what meka leaves to the host:

- **Sign-in** with a password or a passkey, a list of the devices signed in, and a sign-in log.
- **Files** beside each session, at its working directory: preview, upload, download, mention a file in a message.
- **A terminal** docked under each session that keeps running when you leave, to come back to from any device.
- **Push notifications** when a turn finishes, fails, or waits for your approval or answer, even with the app closed.
- **Data saver** for mobile data, and preferences shared by every device.

This release supports **meka 0.85.0** and newer.

web.meka.run, the static site that reached meka straight from the browser, is retired; its last release was mekaweb 0.23.1.

## Install

See [Installing mekaweb](docs/install.md). In short, with `~/.config/mekaweb/config.toml` naming meka's address and its token ([`config/mekaweb.toml`](config/mekaweb.toml) is the example):

```sh
mekaweb user add <username>
mekaweb serve
```

## Develop

Install Node.js 24, npm 11 and the Rust toolchain. Run mekaweb against a meka, with its `public_origin` set to the dev server's address:

```toml
listen = "127.0.0.1:4180"
public_origin = "http://localhost:5173"
state_dir = "/tmp/mekaweb-dev"

[meka]
url = "http://127.0.0.1:8080"
token_file = "/tmp/mekaweb-dev/meka-token"
```

```sh
cargo run -- --config dev.toml user add me
cargo run -- --config dev.toml serve
cd web
npm ci
npm run dev
```

The dev server passes `/api` and `/meka` to mekaweb at `MEKAWEB_GATEWAY`, `http://127.0.0.1:4180` unless set. See [Development](docs/development.md) for the checks and releases.

## Documentation

- [Installing mekaweb](docs/install.md): meka and mekaweb as services, HTTPS, and your phone
- [Using mekaweb](docs/usage.md): signing in, Files, the terminal, notifications, and Data saver
- [API support](docs/api-coverage.md): supported meka operations and limits
- [Architecture](docs/architecture.md): the server, the interface, and their invariants
- [Development](docs/development.md): layout, checks, and releases
- [Changelog](CHANGELOG.md)

## License

Copyright (c) 2026 K4YT3X.

Licensed under the **GNU Affero General Public License, version 3 or later** (`AGPL-3.0-or-later`). See [LICENSE](LICENSE). Third-party components retain their respective licenses; see [third-party notices](docs/third-party.md).
