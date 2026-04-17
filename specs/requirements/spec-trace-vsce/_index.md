# Spec Trace VS Code Extension

This folder contains the canonical requirements for the browser-safe Spec Trace VS Code extension.

Canonical entry point:

- [`SPEC-VSCE-BROWSE.json`](./SPEC-VSCE-BROWSE.json) - browser-safe repository browsing, artifact inspection, and local trace navigation
- [`SPEC-VSCE-DOC-EDITOR.json`](./SPEC-VSCE-DOC-EDITOR.json) - managed authoring surface for canonical architecture, work-item, and verification markdown artifacts
- [`SPEC-VSCE-EDITOR.json`](./SPEC-VSCE-EDITOR.json) - custom editor behavior for canonical specification JSON files
- [`SPEC-VSCE-MANAGEMENT.json`](./SPEC-VSCE-MANAGEMENT.json) - repository bootstrap and additive artifact management for specification, architecture, work-item, and verification artifacts
- [`SPEC-VSCE-QUALITY.json`](./SPEC-VSCE-QUALITY.json) - read-only viewing of repo-local quality and attestation artifacts inside the extension

Current requirement set:

- browser-safe repository browsing, artifact inspection, and local trace navigation across canonical artifacts
- managed authoring for canonical architecture, work-item, and verification markdown artifacts
- browser-hosted extension runtime
- read-only viewing of generated quality evidence and attestation artifacts already present in the repository
- structured custom editor for existing specification files
- validation, save safety, and lossless round-tripping for canonical spec JSON
- bootstrap-first initialization when Spec Trace scaffold is missing
- additive repair when the scaffold is partial
- templated creation flows for specification, architecture, work-item, and verification artifacts
- VS Code-native form controls first, with `@incursa/ui-kit` only for interactions native controls cannot represent cleanly

Deferred phases such as service-backed automation, GitHub-integrated workflows, language-specific adapters, code lenses, and broader repository orchestration should be specified separately.
