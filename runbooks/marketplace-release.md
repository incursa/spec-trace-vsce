# Marketplace Release Runbook

This runbook covers packaging and publishing updates to the existing Visual Studio Code Marketplace extension.

## Preflight

Run the local release gate:

```bash
npm run release:check
npm run test:webview
```

Together, these commands verify:

- TypeScript compilation
- ESLint
- Production web bundle generation
- Browser-based custom-editor, explorer, and quality-view smoke coverage through `npm run test:webview`

Note: the broader `npm test` suite and the custom editor smoke flow both use `vscode-test-web`, which depends on downloading a VS Code web test harness and can fail transiently due to upstream rate limits. `npm run release:check` intentionally avoids that external dependency and focuses on publishable output, so run the webview smoke locally before dispatching Publish.

## Required Manifest Metadata

The following manifest data must be finalized before a real Marketplace publish:

- `publisher`
- `license` or a `LICENSE` file plus matching manifest entry
- `repository`
- `homepage`
- `bugs`

Current values are now wired in:

- `publisher`: `incursa`
- `license`: `SEE LICENSE IN LICENSE`
- `repository`: `https://github.com/incursa/spec-trace-vsce`
- `homepage`: `https://github.com/incursa/spec-trace-vsce`
- `bugs`: `https://github.com/incursa/spec-trace-vsce/issues`

## Assets

The repository now includes marketplace-facing images:

- `images/icon.png`
- `images/spectrace-readme-banner.png`
- `images/spectrace-wordmark-vscode.svg`
- `images/requirements-index.png`
- `images/requirements-filtered.png`
- `images/requirement-detail.png`

Before publishing, verify that:

- The icon is the intended brand asset.
- The files listed in `BRAND-ASSET-LICENSE.md` and `TRADEMARKS.md` are included in the VSIX and remain outside Apache-2.0.
- The screenshots still match the shipped UI.
- The README does not reference stale paths or old UI states.

## Packaging

After the publisher and account setup are in place, package with the latest `@vscode/vsce`.

Recommended flow:

```bash
npm install
npm run release:check
npx @vscode/vsce package
```

If repository metadata is still not set in `package.json`, `vsce` will not be able to resolve relative README image URLs automatically. In that case you must either:

- add the real `repository` field to `package.json`, or
- package and publish with explicit `--baseContentUrl` and `--baseImagesUrl` values

## Publish

The normal release path is the repository's manually triggered **Publish** GitHub Actions workflow (`.github/workflows/publish.yml`). It installs the locked dependencies, runs the release gate, and then publishes the version declared in `package.json` using the repository-level `VSCE_PAT` secret. The job is associated with the `marketplace` environment.

To publish from GitHub:

1. Push the release commit to the branch you intend to publish.
2. Open **Actions** in GitHub and select **Publish**.
3. Choose **Run workflow**, select the release branch, and confirm the run.
4. Verify that the release gate and Marketplace publish steps both pass.

For a deliberate local publish instead, use:

```bash
npx @vscode/vsce publish
```

## Release Requirements

- The repository must contain a valid `VSCE_PAT` Actions secret for the `incursa` publisher.
- The version in `package.json` must not already exist in the Marketplace.
- Publishing is an explicit release action; packaging and local verification do not publish automatically.
