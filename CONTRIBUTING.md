# Contributing

Use an intentional branch and keep browser-safe code under `src/web`. Code under
`src/web` must not import Node built-ins, launch processes, or assume a local
file-system URI. Optional desktop integration belongs under `src/node` and must
enforce Workspace Trust before process execution.

Before opening a pull request:

```bash
npm ci
npm run release:check
```

The release gate runs type checking, linting, browser-host tests, webview smoke
coverage, production bundling, asset verification, VSIX packaging, content
inspection, and SHA-256 generation. Do not commit secrets, customer material,
or generated VSIX packages.
