# Spec Trace VS Code Extension

This folder contains the initial canonical requirements for the browser-safe Spec Trace VS Code extension.

Canonical entry point:

- [`SPEC-VSCE-EDITOR.json`](./SPEC-VSCE-EDITOR.json) - custom editor behavior for canonical specification JSON files

Initial pass scope:

- browser-hosted extension runtime
- structured custom editor for existing specification files
- validation, save safety, and lossless round-tripping for canonical spec JSON
- VS Code-native form controls first, with `@incursa/ui-kit` only for interactions native controls cannot represent cleanly

Later phases such as custom commands, documentation-focused extensions, language-specific adapters, code lenses, and broader repository automation should be specified separately.
