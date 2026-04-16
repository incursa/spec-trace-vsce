# Marketplace Release Runbook

This runbook covers the remaining steps to publish the extension to the Visual Studio Code Marketplace.

## Preflight

Run the local release gate:

```bash
npm run release:check
```

That command currently verifies:

- TypeScript compilation
- ESLint
- Web extension tests
- Browser smoke tests
- Production bundle generation

## Required Manifest Metadata

The following manifest data must be finalized before a real Marketplace publish:

- `publisher`
- `license` or a `LICENSE` file plus matching manifest entry
- `repository`
- `homepage`
- `bugs`

Current values are now wired in:

- `publisher`: `incursa`
- `license`: `Apache-2.0`
- `repository`: `https://github.com/incursa/spec-trace-vsce`
- `homepage`: `https://github.com/incursa/spec-trace-vsce`
- `bugs`: `https://github.com/incursa/spec-trace-vsce/issues`

## Assets

The repository now includes marketplace-facing images:

- `images/icon.png`
- `images/requirements-index.png`
- `images/requirements-filtered.png`
- `images/requirement-detail.png`

Before publishing, verify that:

- The icon is the intended brand asset.
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

With a Marketplace publisher and PAT configured:

```bash
npx @vscode/vsce publish
```

If this becomes part of CI, prefer a non-interactive release workflow with a stored Marketplace token.

## Current Blocking Items

- A Marketplace PAT is still required for the actual `vsce publish` step.
- No automated publish workflow exists yet.
