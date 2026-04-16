# Spec Trace VS Code Extension

This folder contains the canonical requirements for the browser-safe Spec Trace VS Code extension.

Canonical entry point:

- [`SPEC-VSCE-EDITOR.json`](./SPEC-VSCE-EDITOR.json) - custom editor behavior for canonical specification JSON files
- [`SPEC-VSCE-MANAGEMENT.json`](./SPEC-VSCE-MANAGEMENT.json) - repository bootstrap and additive artifact management for specification, architecture, work-item, and verification artifacts

Current requirement set:

- browser-hosted extension runtime
- structured custom editor for existing specification files
- validation, save safety, and lossless round-tripping for canonical spec JSON
- bootstrap-first initialization when Spec Trace scaffold is missing
- additive repair when the scaffold is partial
- templated creation flows for specification, architecture, work-item, and verification artifacts
- VS Code-native form controls first, with `@incursa/ui-kit` only for interactions native controls cannot represent cleanly

Deferred phases such as richer markdown-focused editors, language-specific adapters, code lenses, and broader repository automation should be specified separately.
