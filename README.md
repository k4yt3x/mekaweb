# mekaweb

A web interface for [meka](https://github.com/k4yt3x/meka), hosted at [web.meka.run](https://web.meka.run).

mekaweb is a static site that connects your browser directly to your own meka server. There is no separate backend or account. It supports **meka 0.71.0** and newer; it refuses older servers when connecting.

## Getting started

Allow the site's origin and add an API token in your meka `config.toml`:

```toml
[serve]
bind = "0.0.0.0:8080"
cors_allowed_origins = ["https://web.meka.run"]

[[serve.tokens]]
token = "${MEKA_WEB_TOKEN}"
description = "Web interface"
scopes = [
  "sessions:r", "sessions:w",
  "memory:r", "memory:w",
  "skills:r", "skills:w",
  "schedule:r", "schedule:w",
  "mcp:r", "mcp:w",
]
```

Start `meka serve` with `MEKA_WEB_TOKEN` set, open [web.meka.run](https://web.meka.run), and enter the server's base URL, such as `http://127.0.0.1:8080`, and the token. Token scopes determine which controls are available; see meka's [token configuration](https://github.com/k4yt3x/meka/blob/0.71.0/docs/book/src/usage/http-api.md#token-configuration).

An HTTPS site reaching a local server needs browser permission, such as Chrome's [Local Network Access](https://developer.chrome.com/blog/local-network-access). For access over the internet, put meka behind an HTTPS reverse proxy.

## Run locally

Install Node.js 24 and npm 11, then run:

```sh
npm ci
npm run dev
```

Open the URL printed by Vite and allow its origin in meka:

```toml
[serve]
cors_allowed_origins = ["http://localhost:5173"]
```

Use the origin from the browser address bar: the scheme, hostname, and port, without any path. Include any reverse-proxy path in the base URL, such as `https://example.com/meka/`.

## Static hosting

Build and preview the application:

```sh
npm ci
npm run build
npm run preview -- --host 127.0.0.1
```

Serve the contents of `dist/` from any static host. Hash routes need no server-side rewrites. JavaScript, highlighting assets, and fonts are bundled locally.

For hosting under a path such as `/mekaweb/`:

```sh
MEKAWEB_BASE_PATH=/mekaweb/ npm run build
MEKAWEB_BASE_PATH=/mekaweb/ npm run preview -- --host 127.0.0.1
```

The base path must start and end with `/`. It controls where the frontend assets are hosted, not the meka endpoint. Add the deployed site's origin to meka's CORS configuration. Never embed tokens or provider credentials in build variables.

## Documentation

- [Using mekaweb](docs/usage.md): connection details, features, notifications, and local data
- [API support](docs/api-coverage.md): supported meka operations and limits
- [Architecture](docs/architecture.md): component boundaries and state invariants
- [Development](docs/development.md): checks, GitHub Pages deployment, and releases
- [Changelog](CHANGELOG.md)

## License

Copyright (c) 2026 K4YT3X.

Licensed under the **GNU Affero General Public License, version 3 or later** (`AGPL-3.0-or-later`). See [LICENSE](LICENSE). Third-party components retain their respective licenses; see [third-party notices](docs/third-party.md).
