---
artifact_id: WI-VSCE-MANAGEMENT
title: Implement Bootstrap and Additive Artifact Management
summary: Delivery plan for repository initialization and template-backed artifact creation in the VS Code extension.
---
# WI-VSCE-MANAGEMENT

## Purpose

Plan the implementation work needed to satisfy [`SPEC-VSCE-MANAGEMENT`](../../requirements/spec-trace-vsce/SPEC-VSCE-MANAGEMENT.json) using the design in [`ARC-VSCE-MANAGEMENT`](../../architecture/spec-trace-vsce/ARC-VSCE-MANAGEMENT.md).

## Trace Links

- Addresses: `REQ-VSCE-MANAGEMENT-0001` through `REQ-VSCE-MANAGEMENT-0014`
- Uses design: [`ARC-VSCE-MANAGEMENT`](../../architecture/spec-trace-vsce/ARC-VSCE-MANAGEMENT.md)
- Verified by: [`VER-VSCE-MANAGEMENT`](../../verification/spec-trace-vsce/VER-VSCE-MANAGEMENT.md)

## Planned Changes

The implementation should add a management lane alongside the existing explorer and specification editor rather than reshaping those surfaces first. The likely code footprint is:

- command registrations and activation wiring in [`src/web/extension.ts`](../../../src/web/extension.ts)
- explorer affordances and refresh behavior in [`src/web/navigation/specTraceExplorer.ts`](../../../src/web/navigation/specTraceExplorer.ts)
- a new host-side management service under [`src/web`](../../../src/web) for repository state detection, path derivation, template rendering, and safe writes
- bundled scaffold and artifact templates stored with extension-owned assets
- tests covering repository-state transitions, path derivation, collision handling, and editor-opening behavior

## Delivery Slices

### Slice 1: Repository State and Initialize Command

Add repository-state detection and a command palette entry that can initialize a missing or partial scaffold. In an empty repository, this slice should make bootstrap the only first-step management action. It should establish the additive write rules, create the folder structure and minimal seed files, and land scaffold templates before artifact creation is layered on top.

### Slice 2: Create-Artifact Flows

Add templated creation flows for:

- specification JSON
- architecture markdown
- work-item markdown
- verification markdown

This slice should own target-path derivation, trace-link token population, and collision rejection. It should assume Slice 1 has already created the initial scaffold for truly empty repositories.

### Slice 3: Explorer Integration

Extend the explorer to surface create actions where users already browse artifacts:

- category empty states when no artifacts exist
- category or domain-level create affordances
- automatic refresh and open behavior after successful creation

### Slice 4: Verification and Hardening

Add tests for browser-host safety, partial-repository repair, duplicate targets, and post-create open behavior. This slice should also confirm the management lane does not disturb the existing specification editor.

## Out of Scope

This work item does not include:

- structured editors for markdown artifacts
- repository-local template override systems
- automatic repair of existing index content beyond creating missing domain `_index.md` files
- broader Workbench automation, code generation, or sync workflows

## Sequencing Notes

Slice 1 is the dependency anchor. For a repository in `missing` state, bootstrap is a hard gate before any artifact-specific creation flow. Slice 2 should not ship until scaffold detection and safe additive writes are already in place. Slice 3 can overlap with late Slice 2 work. Slice 4 should run against both empty and partially initialized repositories so the additive contract is exercised directly.
Because explorer-based create affordances extend an already shipped browse surface, a separate explorer requirement backfill should be authored before or alongside Slice 3.
