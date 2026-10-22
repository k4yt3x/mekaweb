# mekaweb build helpers. The interface is compiled into the binary, so every build builds web/
# first.

# List recipes.
default:
    @just --list

# Build the interface into web/dist.
web:
    cd web && npm ci && npm run build

# Build the release binary, with the interface, into target/release/mekaweb.
build: web
    cargo build --release --locked

# Needs musl-tools (musl-gcc) for the bundled OpenSSL and SQLite, and the target:
# rustup target add x86_64-unknown-linux-musl
# Build a static binary for any Linux, into target/x86_64-unknown-linux-musl/release/mekaweb.
build-static: web
    cargo build --release --locked --target x86_64-unknown-linux-musl

# Run every check CI runs.
check:
    cargo +nightly fmt --check
    cargo sort -w --check
    cargo clippy --locked --all-targets -- -D warnings
    RUSTDOCFLAGS="-D warnings" cargo doc --locked --no-deps --document-private-items
    cargo test --locked
    cargo +1.95 check --locked --all-targets
    cd web && npm ci && npm run api:generate && git diff --exit-code -- src/api && npm run check
