# Development

Use npm with the committed lockfile. `.nvmrc` specifies Node 24; `.npmrc` saves exact dependency versions.

```sh
npm run check
```

This runs formatting, lint, strict TypeScript, a production build, and Node-based unit tests. `npm run format` applies formatting. CI also verifies generated API types and the `/mekaweb/` build. Automated checks do not launch browsers or meka.

Review browser behavior and live API workflows manually against a disposable meka instance. After relevant changes, check connection/scopes and two-tab credential handling; messages, approvals, and recovery; session/resource management; rich content, keyboard access, and narrow layouts. For routing or asset changes, check production navigation and reloads at both `/` and `/mekaweb/`.

The [architecture](architecture.md) explains component boundaries and state invariants. [Schema tooling](api/README.md) describes API type generation. Keep the architecture and [API support reference](api-coverage.md) aligned with behavior changes, and keep credentials and local review artifacts out of version control.

## GitHub Pages

For [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), select **GitHub Actions** as the repository's Pages source. Pushing a release tag such as `0.1.0` starts the **Deploy static site** workflow; you can also run it manually. It reads the site's configured URL to select the asset base path automatically, including `/` for a custom domain. Checks must pass before the site is published.

For a custom domain such as `web.meka.run` on a repository owned by `k4yt3x`:

1. Set **Settings → Pages → Custom domain** to `web.meka.run` in the repository.
2. Add a DNS `CNAME` record named `web` pointing to `k4yt3x.github.io`. The target has no scheme or repository path.
3. Run **Deploy static site**. The workflow selects `/` for the custom domain.
4. Enable **Enforce HTTPS** in Pages settings once the certificate is available.

See GitHub's [custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) for DNS and certificate setup. Users connecting from that domain allow `https://web.meka.run` in their meka CORS configuration.

## Releases

The web interface has its own version, independent of the meka server. `package.json` is the source of the mekaweb version displayed in Settings and the setup screen footer; `package-lock.json` records the same version.

Record user-visible changes under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md), grouped by Added, Changed, Deprecated, Removed, Fixed, or Security. Use one line per entry, under 100 characters, and mark breaking changes with `**Breaking:**`.

After committing the release changes, create and push the matching tag. For the initial `0.1.0` release:

```sh
git tag -a 0.1.0 -m "mekaweb 0.1.0"
git push origin HEAD
git push origin 0.1.0
```

For subsequent releases, run `npm version <version> --no-git-tag-version`, move the unreleased notes into a dated version section, and update the changelog's comparison links. Run `npm run check` and commit the updated package files and changelog before tagging. Tags use bare `major.minor.patch` numbers: no `v` prefix or prerelease suffix. The deployment workflow rejects tags that do not match the package and lockfile versions. Branch pushes run CI without automatically deploying.

If the `github-pages` environment restricts deployment branches and tags, add a **Tag** rule named `[0-9]*.[0-9]*.[0-9]*` in **Settings → Environments → github-pages**. See GitHub's [environment configuration](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
