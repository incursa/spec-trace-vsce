# Marketplace Release Runbook

This runbook covers packaging and publishing updates to the existing Visual Studio Code Marketplace extension.

## Preflight

Run the local release gate:

```bash
npm run release:check
```

This command verifies:

- TypeScript compilation
- ESLint
- Production browser and desktop bundle generation
- Browser extension-host tests, including proof that desktop commands are not registered on web
- Browser-based custom-editor, explorer, and quality-view smoke coverage
- Required brand assets and the exact 128-pixel Marketplace icon
- VSIX packaging and required/forbidden content inspection
- SHA-256 sidecar generation

The package and sidecar are written to:

```text
artifacts/packages/spec-trace-vsce-<version>.vsix
artifacts/packages/spec-trace-vsce-<version>.vsix.sha256
```

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

Packaging uses the locked `@vscode/vsce` development dependency.

Recommended flow:

```bash
npm install
npm run release:check
```

If repository metadata is still not set in `package.json`, `vsce` will not be able to resolve relative README image URLs automatically. In that case you must either:

- add the real `repository` field to `package.json`, or
- package and publish with explicit `--baseContentUrl` and `--baseImagesUrl` values

## Publish

The normal release path is the repository's **Release** GitHub Actions workflow (`.github/workflows/publish.yml`). A `v<package-version>` tag runs the locked release gate, uploads the VSIX and checksum, creates a GitHub Release, and publishes that inspected VSIX using the repository-level `VSCE_PAT` secret. The Marketplace job remains associated with the protected `marketplace` environment. Manual dispatch can build only, or can explicitly request GitHub Release and Marketplace publication.

To publish from GitHub:

1. Confirm the worktree is clean and `package.json`, `package-lock.json`, and `CHANGELOG.md` agree on the version.
2. Run `npm ci` and `npm run release:check`.
3. Verify the generated SHA-256 and inspect the package locally.
4. Commit and push the release branch, then merge it through the repository's normal review flow.
5. Create and push the matching `v<version>` tag only after release authorization.
6. Verify the GitHub Release assets and Marketplace version after the protected environment approves publication.

For a deliberate recovery publish, use the already-inspected VSIX:

```bash
npx vsce publish --packagePath artifacts/packages/spec-trace-vsce-<version>.vsix
```

If a tag workflow fails before publication, fix the release commit and use a new version; do not move a public release tag. If Marketplace publication alone fails, rerun the protected job or publish the exact GitHub Release VSIX after verifying its checksum.

## Release Requirements

- The repository must contain a valid `VSCE_PAT` Actions secret for the `incursa` publisher.
- The version in `package.json` must not already exist in the Marketplace.
- Publishing is an explicit release action; packaging and local verification do not publish automatically.
