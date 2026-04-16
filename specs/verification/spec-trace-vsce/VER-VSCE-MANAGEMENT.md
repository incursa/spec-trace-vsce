---
artifact_id: VER-VSCE-MANAGEMENT
title: Verify Bootstrap and Additive Artifact Management
summary: Verification approach for repository initialization and template-backed creation flows in the browser-hosted extension.
---
# VER-VSCE-MANAGEMENT

## Purpose

Define how the extension will verify satisfaction of [`SPEC-VSCE-MANAGEMENT`](../../requirements/spec-trace-vsce/SPEC-VSCE-MANAGEMENT.json) once implementation begins.

## Trace Links

- Verifies: `REQ-VSCE-MANAGEMENT-0001` through `REQ-VSCE-MANAGEMENT-0014`
- Related design: [`ARC-VSCE-MANAGEMENT`](../../architecture/spec-trace-vsce/ARC-VSCE-MANAGEMENT.md)
- Related work item: [`WI-VSCE-MANAGEMENT`](../../work-items/spec-trace-vsce/WI-VSCE-MANAGEMENT.md)

## Verification Approach

Verification should combine focused automated tests with browser-host smoke coverage:

- unit-style tests for repository-state detection, path derivation, template token substitution, and collision checks
- extension-host tests for command registration, scaffold initialization, create-artifact flows, and explorer refresh behavior
- smoke coverage that opens a newly created specification in the custom editor and newly created markdown artifacts in the standard text editor
- negative tests that confirm existing files are not overwritten, empty repositories route to bootstrap first, and partial repositories are repaired additively

## Verification Matrix

### Repository State and Bootstrap

- `REQ-VSCE-MANAGEMENT-0001` to `REQ-VSCE-MANAGEMENT-0005`
- Evidence: automated tests that exercise `missing`, `partial`, and `ready` repository states, confirm `missing` state foregrounds bootstrap before artifact creation, and confirm the expected folder structure and minimal seed files are created without overwriting existing content

### Template-Backed Artifact Creation

- `REQ-VSCE-MANAGEMENT-0006` to `REQ-VSCE-MANAGEMENT-0011`
- Evidence: automated tests that render each artifact class, assert canonical target paths, confirm trace-link population, and reject duplicate targets

### Editor and Explorer Integration

- `REQ-VSCE-MANAGEMENT-0012` and `REQ-VSCE-MANAGEMENT-0013`
- Evidence: extension-host tests that execute create commands, refresh the explorer, and assert the correct editor surface opens for the resulting file

### Browser-Host Safety

- `REQ-VSCE-MANAGEMENT-0014`
- Evidence: existing web-extension test execution plus smoke runs in the browser-hosted development session showing the management flows complete without Node-only APIs or helper processes

## Expected Evidence

Implementation should leave behind auditable evidence in the repository test suite and any browser smoke artifacts already used by the extension. If a scenario cannot be automated immediately, the gap should be recorded explicitly rather than assumed covered.
