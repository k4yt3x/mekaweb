# mekaweb

A web interface for [meka](https://github.com/k4yt3x/meka). Chat with your agent, answer tool approvals, and manage sessions, memory, skills, schedules, and MCP servers from your browser.

mekaweb is a static application that connects directly to your meka server. It does not require a separate application server or user account. The supported API versions are **meka 0.59.0–0.64.1**. See the [changelog](CHANGELOG.md) for release history.

## Getting started

You need a running meka server, its base URL, and an API token. Configure providers, profiles, and tools in meka before connecting.

### Connect from a hosted site

The following example uses `https://web.meka.run` as the hosted UI address. GitHub Pages serves the frontend; your browser connects directly to your own meka server.

Merge these settings into your meka `config.toml`. The token scopes below enable all management features:

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

Set `MEKA_WEB_TOKEN` to your API token in the server's environment, then start or restart `meka serve`. You can keep an existing token entry instead; see meka's [token configuration](https://github.com/k4yt3x/meka/blob/0.64.1/docs/book/src/usage/http-api.md#token-configuration) for file-based tokens and scope options.

Enter that token and the appropriate **Meka base URL** in the web UI:

| Where meka runs                      | Example base URL           |
| ------------------------------------ | -------------------------- |
| On the same computer as your browser | `http://127.0.0.1:8080`    |
| On another computer on your LAN      | `http://192.168.1.10:8080` |
| Behind your HTTPS reverse proxy      | `https://meka.example.com` |

Replace example hostnames and IP addresses with your own. `0.0.0.0` is a listen address, not a URL to enter in the browser. Use `127.0.0.1:8080` as the bind address when access is limited to the same computer or a reverse proxy on that computer.

Local connections from an HTTPS site depend on browser permissions. Chrome can request [Local Network Access](https://developer.chrome.com/blog/local-network-access); allow it for the UI if you want to connect locally. Browsers without the relevant HTTP exceptions may require an HTTPS endpoint or a locally hosted UI. For internet access, use an HTTPS reverse proxy with a browser-trusted certificate; meka itself serves HTTP.

If you open a project Pages URL such as `https://k4yt3x.github.io/mekaweb/`, use its origin instead:

```toml
[serve]
cors_allowed_origins = ["https://k4yt3x.github.io"]
```

The repository path `/mekaweb/` is not part of the origin. If you use both frontend addresses, list both origins.

### Run locally

To run mekaweb from source, install Node.js 24 and npm 11, then run:

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. Enter a connection name, the meka base URL, and your token. Include any reverse-proxy path in the base URL, such as `https://example.com/meka/`.

The meka server must allow the web application's origin. For the default development URL:

```toml
[serve]
cors_allowed_origins = ["http://localhost:5173"]
```

Use the web UI's origin from the browser address bar: the scheme, hostname, and port, without any path, query, or fragment. A site hosted at `/mekaweb/` has the same origin as the root of that host.

For remote access, use HTTPS for both the web interface and the meka endpoint. On another device, `localhost` refers to that device, so use a reachable server address instead.

The interface has been checked in Chromium and Firefox, including narrow layouts. Safari and physical mobile devices have not been fully validated. Offline/PWA operation is not currently supported.

## Using mekaweb

- **Messages:** Enter sends; Shift+Enter adds a newline. The composer starts at two lines. Drag its top grip upward for longer drafts, or focus it and use arrow keys. Its height resets after a successful send. When idle, a message starts a direct streaming turn. While the agent works, messages use Steer by default; choose Queue or Interrupt in the composer's Settings. When a turn is running and the input is empty, Send becomes a red Stop button for that turn.
- **Conversation appearance:** Set **Conversation font size** and **Conversation max width** under **Settings → Appearance**. Both are saved in your browser. Width applies to the chat and composer, with a full-width option; font size applies to messages and their contents. Other pages and control text retain their sizes.
- **Reading options:** Open **Aa** in the session header to enter a font size or max width in pixels, then press **Enter** to apply. The **− / +** buttons and arrow keys apply 1 px font or 100 px width steps immediately. Leave width blank for full width; width also applies to the composer. Adjustments are temporary unless you choose **Save**, which applies both fields and saves them as defaults for this browser. **Reset**, changing sessions, or reloading restores your saved appearance settings.
- **Permissions:** Change permission mode directly beside Send, or press Shift+Tab in the message input to cycle through enabled modes. Select the profile beside permissions while the session is idle. Settings contains approval mode, working directory, skills, and delivery options. Images and skills can be sent while the session is idle.
- **Approvals:** Pending tool approvals remain visible when you move to another screen.
- **Workspace:** Collapse the navigation or session list to focus on a conversation. The details panel stays open until closed. Drag a panel divider to resize it, or use arrow keys when the divider has keyboard focus. Double-click resets its width.
- **Session titles:** Click the conversation heading to rename it. Enter, the checkmark, or clicking away saves; Escape or the cancel button discards the edit. Clearing the title restores the first-message label.
- **Sessions:** Search conversations from the session list. On meka 0.64.0 or newer, hover over a session or focus its row to reveal Rename, Pin, and Delete. These buttons stay visible in narrow and touch layouts, beside the title when space permits. Pins stay at the top of the list and are saved on the server. Use **Use first message** in Rename to reset a title. The session menu also offers fork, compact, rewind, export, and delete. Import accepts a meka JSON archive. Session-row deletion asks for confirmation; **Shift-click deletes immediately**, including sub-agent sessions.
- **History:** The conversation shows meka's current model context. Compaction and rewind can replace it. Export the full transcript when you need earlier history.

New sessions stream thinking when the provider supplies it. Injected context is hidden by default; enable **Show context added by meka** under **Settings → Diagnostics** to inspect it.

Withdraw and delivery-recovery controls appear inside their messages. If a submission has an uncertain outcome, inspect saved state before sending again. Use **Retry same submission** when offered for an inbox message; streaming direct turns cannot be safely retried automatically.

The interface supports Markdown tables, code highlighting and copying, math, diagrams, and authenticated image attachments. Collapsed tool calls show their primary argument when available; expand a call to inspect its full arguments and result. See [API support](docs/api-coverage.md) for available operations and backend limitations.

Completion alerts are configured under **Settings → Notifications**, with a **Test** button for each option:

- **Browser notifications** are optional and appear when mekaweb is in the background. They require HTTPS (or localhost), browser permission, and a supported browser.
- **In-app notifications** are enabled by default. When a different conversation finishes or fails, a toast shows its title and opens it when clicked. Toasts dismiss after six seconds, pausing while hovered or keyboard-focused.
- **Completion sound** is optional and plays a short chime while mekaweb is in the foreground, including when you’re viewing the completed conversation. Background browser notifications use the operating system’s sound settings instead. Audio may require a click or key press after reloading the app.

In-app alerts work independently of browser notification permission and service workers. Keep mekaweb open and connected: closed or suspended pages cannot receive completion events.

## iPhone and iPad

In Safari, use **Share → Add to Home Screen**. Leave **Open as Web App** enabled if shown. Mekaweb opens with the meka icon and its own app window. It still needs a network connection to load and reach meka.

Connect to your meka instance inside the installed app. Its browser storage is separate from Safari, so saved connections and tokens do not carry over. If an older installation still shows a letter icon after updating, remove it and add it again; you may need to enter your connection details again.

On iOS, browser notifications require opening the Home Screen app. They are not a reliable background completion alert: iOS can suspend the app and its live connection when you switch away or lock the screen. Delivery while suspended would require server-side Web Push, which mekaweb does not use. See [WebKit’s Home Screen documentation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) and [storage behavior](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).

## Connections and local data

New connections default to **Local storage (persistent)**, which uses `localStorage` to keep the API token across browser restarts. Choose **Session storage (this tab)** in the **Token storage** selector to use `sessionStorage` for the current tab's session instead. Existing connections retain their saved choice. Use persistent storage only on a trusted browser profile and hosting origin.

Connection settings, appearance, layout, and text drafts are saved in browser storage. File attachments are kept in memory and are lost on reload. Clearing browser data removes local settings and drafts, but does not delete server sessions.

If the active endpoint becomes unreachable, one banner appears above the workspace. Mekaweb checks for recovery automatically; **Retry** checks immediately. Recovery preserves your open view and drafts and does not repeat submissions. Warnings about uncertain actions remain with those actions.

Forgetting or replacing a token disconnects open tabs that used it. Forgetting a token does not revoke it on the server. Removing a connection, or replacing its endpoint URL, also removes that connection's local drafts. Provider credentials remain on the meka server. Disconnecting does not necessarily stop accepted work; use Stop first if you want to cancel the current turn.

Token scopes determine which controls are available. Tokens access the server's shared session namespace; they do not create separate user accounts.

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

For [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), select **GitHub Actions** as the repository's Pages source. Pushing a release tag such as `0.1.0` starts the **Deploy static site** workflow; you can also run it manually. It reads the site's configured URL to select the asset base path automatically, including `/` for a custom domain. Checks must pass before the site is published.

For a custom domain such as `web.meka.run` on a repository owned by `k4yt3x`:

1. Set **Settings → Pages → Custom domain** to `web.meka.run` in the repository.
2. Add a DNS `CNAME` record named `web` pointing to `k4yt3x.github.io`. The target has no scheme or repository path.
3. Run **Deploy static site**. The workflow selects `/` for the custom domain.
4. Enable **Enforce HTTPS** in Pages settings once the certificate is available.

See GitHub's [custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) for DNS and certificate setup. Users connecting from that domain allow `https://web.meka.run` in their meka CORS configuration.

## Development

Use npm with the committed lockfile. `.nvmrc` specifies Node 24; `.npmrc` saves exact dependency versions.

```sh
npm run check
```

This runs formatting, lint, strict TypeScript, a production build, and Node-based unit tests. `npm run format` applies formatting. CI also verifies generated API types and the `/mekaweb/` build. Automated checks do not launch browsers or meka.

Review browser behavior and live API workflows manually against a disposable meka instance. After relevant changes, check connection/scopes and two-tab credential handling; messages, approvals, and recovery; session/resource management; rich content, keyboard access, and narrow layouts. For routing or asset changes, check production navigation and reloads at both `/` and `/mekaweb/`.

The [architecture](docs/architecture.md) explains component boundaries and state invariants. [Schema tooling](docs/api/README.md) describes API type generation. Keep the architecture and [API support reference](docs/api-coverage.md) aligned with behavior changes, and keep credentials and local review artifacts out of version control.

### Releases

The web interface has its own version, independent of the meka server. `package.json` is the source of the mekaweb version displayed in Settings and the setup screen footer; `package-lock.json` records the same version.

Record user-visible changes under `Unreleased` in [CHANGELOG.md](CHANGELOG.md), grouped by Added, Changed, Deprecated, Removed, Fixed, or Security. Use one line per entry, under 100 characters, and mark breaking changes with `**Breaking:**`.

After committing the release changes, create and push the matching tag. For the initial `0.1.0` release:

```sh
git tag -a 0.1.0 -m "mekaweb 0.1.0"
git push origin HEAD
git push origin 0.1.0
```

For subsequent releases, run `npm version <version> --no-git-tag-version`, move the unreleased notes into a dated version section, and update the changelog's comparison links. Run `npm run check` and commit the updated package files and changelog before tagging. Tags use bare `major.minor.patch` numbers: no `v` prefix or prerelease suffix. The deployment workflow rejects tags that do not match the package and lockfile versions. Branch pushes run CI without automatically deploying.

If the `github-pages` environment restricts deployment branches and tags, add a **Tag** rule named `[0-9]*.[0-9]*.[0-9]*` in **Settings → Environments → github-pages**. See GitHub's [environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## License

Copyright (c) 2026 K4YT3X.

Licensed under the **GNU Affero General Public License, version 3 or later** (`AGPL-3.0-or-later`). See [LICENSE](LICENSE). Third-party components retain their respective licenses; see [third-party notices](docs/third-party.md).
