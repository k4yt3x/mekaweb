# Development

## Layout

- `crates/mekaweb`: the server, a Rust binary that signs you in, serves the interface, passes requests to meka, and runs Files, terminals, push notifications and meka's status. It is a Cargo workspace member; the workspace root is the repository root.
- `web`: the React interface, with its own `package.json`. `web/tools/schema` generates TypeScript types from meka's OpenAPI document and from mekaweb's.
- `config`: an example config, which goes to `~/.config/mekaweb/config.toml`; a test checks it parses. `deploy`: mekaweb's systemd unit, as a system service (`deploy/system`) or a user service (`deploy/user`).
- `docs`: user and developer documentation, and the captured meka API in `docs/api`.

## Running it

Run a meka on loopback, and mekaweb with a config whose `public_origin` is the Vite dev server's address, so its cookie and `Origin` check work as in production:

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
npm run dev
```

Vite passes `/api` (with WebSockets) and `/meka` to `MEKAWEB_GATEWAY`, `http://127.0.0.1:4180` unless set. A debug build of mekaweb reads `web/dist` from disk, so `npm run build` updates the interface it serves without rebuilding it. Passkeys work on `localhost` over HTTP; push notifications need HTTPS or `localhost`, and a real push service.

The [justfile](../justfile) holds the usual steps: `just build` builds the interface and then the release binary, `just build-static` a static musl one, and `just check` runs every check CI runs.

## Checks

The interface uses npm with the committed lockfile in `web/`. `web/.nvmrc` specifies Node 24; `web/.npmrc` saves exact dependency versions.

```sh
cd web
npm run check
```

This runs formatting, lint, strict TypeScript, a production build (which also writes compressed copies of its text files), and Node-based unit tests. Formatting covers `web/` and the repository's Markdown, docs, and workflows, using the root `.prettierrc.json`; `npm run format` applies it. CI also verifies that `npm run api:generate`, which needs the Rust toolchain, leaves the generated types unchanged.

The server uses the Rust toolchain named by `rust-version` in `Cargo.toml` or newer, and nightly rustfmt for comment wrapping. Run from the repository root:

```sh
cargo +nightly fmt --check
cargo sort -w --check
cargo clippy --locked --all-targets -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps --document-private-items
cargo test --locked
```

Its tests run the API in process against a stand-in meka, terminals against `/bin/sh`, and Web Push encryption against RFC 8291's example. The server is Linux-only: Files reads `/proc` for mount points and folders' paths, and moves with `renameat2`.

Review browser behavior and live workflows manually against a disposable meka, through mekaweb: signing in with a password and a passkey; messages, approvals, and recovery when meka or mekaweb restarts; Files and the terminal in a session, and meka's status in Settings; rich content, keyboard access, and narrow layouts. Chromium's virtual authenticator, through the DevTools protocol's `WebAuthn` domain, stands in for a passkey.

The [architecture](architecture.md) explains component boundaries and state invariants. [Schema tooling](api/README.md) describes API type generation. Keep the architecture and [API support reference](api-coverage.md) aligned with behavior changes, and keep credentials and local review artifacts out of version control.

## Releases

mekaweb has its own version, independent of meka's. `web/package.json` is the source of the version the interface shows; `web/package-lock.json` and the workspace version in `Cargo.toml` record the same version. Each release states which meka versions it supports, in `web/src/api/meka-versions.json`.

Record user-visible changes under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md), grouped by Added, Changed, Deprecated, Removed, Fixed, or Security. Use one line per entry, at most 100 characters including `- `, and mark breaking changes with `**Breaking:**`.

To release, run `npm version <version> --no-git-tag-version` in `web/`, set the same version in `Cargo.toml` and build once to update `Cargo.lock`, move the unreleased notes into a dated version section, and update the changelog's comparison links. Run the checks and commit before tagging. Tags use bare `major.minor.patch` numbers: no `v` prefix or prerelease suffix.

Pushing a tag runs the **Release** workflow. It checks the tag against the three versions, builds the interface, builds static musl binaries for x86-64 and ARM64 on runners of each, and publishes them as `mekaweb-x86_64-linux` and `mekaweb-aarch64-linux` with `SHA256SUMS` in a GitHub release whose notes are the version's changelog section.

web.meka.run, the static site of earlier releases, is retired. GitHub Pages keeps serving its last deployment, mekaweb 0.23.1, until the site is unpublished; nothing in this repository deploys it anymore.
