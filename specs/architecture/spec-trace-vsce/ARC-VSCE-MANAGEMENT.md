---
artifact_id: ARC-VSCE-MANAGEMENT
title: Extension Bootstrap and Additive Management
summary: Browser-safe design for repository state detection, scaffold initialization, and template-backed creation of Spec Trace artifacts.
---
# ARC-VSCE-MANAGEMENT

## Purpose

Define how the extension should satisfy [`SPEC-VSCE-MANAGEMENT`](../../requirements/spec-trace-vsce/SPEC-VSCE-MANAGEMENT.json) without changing its browser-host constraint or coupling artifact management to external tooling.

## Trace Links

- Satisfies: `REQ-VSCE-MANAGEMENT-0001` through `REQ-VSCE-MANAGEMENT-0014`
- Related requirements: [`SPEC-VSCE-MANAGEMENT`](../../requirements/spec-trace-vsce/SPEC-VSCE-MANAGEMENT.json)
- Related implementation surfaces: [`package.json`](../../../package.json), [`src/web/extension.ts`](../../../src/web/extension.ts), [`src/web/navigation/specTraceExplorer.ts`](../../../src/web/navigation/specTraceExplorer.ts), [`src/web/editor/host/specificationCustomEditor.ts`](../../../src/web/editor/host/specificationCustomEditor.ts)

## Current Baseline

The extension already has two stable surfaces:

- a repository explorer that reads canonical artifact folders and opens existing files
- a structured editor for specification JSON files under `specs/requirements`

That baseline is browse-first. It does not create scaffold, does not create new artifacts, and assumes the workspace already conforms to a Spec Trace repository layout.
Because the explorer already ships as a user-visible surface, changes to explorer empty states and create affordances should be paired with a separate browse-surface requirement backfill rather than treated as undocumented behavior.

## Design Overview

The management design adds a browser-safe host-side service with four responsibilities:

1. determine repository state as `missing`, `partial`, or `ready`
2. enforce bootstrap as the first management step when repository state is `missing`
3. instantiate bundled templates into canonical file paths under the current workspace
4. expose those operations through command palette actions and explorer affordances

The design keeps specification editing in the existing custom editor and treats markdown artifact creation as text-first for now. Rich markdown editors remain a separate future lane.

## Repository State Model

Repository state should be derived from the presence of the core scaffold expected by the extension and the local Workbench config:

- `missing`: the workspace lacks the core `specs` scaffold and cannot create or discover canonical artifacts without initialization
- `partial`: some canonical folders or seed files exist, but required scaffold elements are absent for one or more artifact classes
- `ready`: the workspace contains the minimum scaffold needed for browsing and managed creation

This model allows the extension to remain additive. A partial repository does not trigger reinitialization. It enables targeted creation of only the missing directories or seed files.

In `missing` state, management UI should foreground initialization and suppress artifact-specific creation affordances until bootstrap completes. In `partial` state, additive repair and creation can coexist because the repository already has a recognized Spec Trace foothold.

## Template Catalog

Templates should be bundled with the extension and resolved from extension-owned assets rather than from repository-local files during the first delivery pass. The catalog should include:

- repository scaffold templates for category roots, domain `_index.md` files, and `.workbench/config.json`
- a specification JSON template aligned to the current custom editor and validator
- markdown templates for architecture, work-item, and verification artifacts with explicit trace-link sections

Template rendering should be deterministic and limited to local token substitution such as domain, artifact id, title, capability, summary, and trace references. The renderer should not attempt code generation, language-aware inference, or remote fetches.

For bootstrap seed files, "empty" should mean minimal valid starter content rather than literal zero-byte files when a file must parse or convey required structure. That keeps the scaffold immediately usable after initialization.

## Management Entry Points

Management should be reachable from VS Code-native surfaces that already fit the extension:

- command palette actions for initialize and create-artifact flows
- explorer empty states when a category has no discoverable artifacts
- explorer toolbar or context actions when a category or domain is selected

These flows should stay host-driven through [`src/web/extension.ts`](../../../src/web/extension.ts) and the explorer provider in [`src/web/navigation/specTraceExplorer.ts`](../../../src/web/navigation/specTraceExplorer.ts). They do not require a new webview to ship the first pass.

When repository state is `missing`, the initialize action should be the primary management affordance. Create-artifact actions should appear only after bootstrap has produced the initial scaffold.

## Bootstrap Flow

The initialization flow should:

1. validate that a workspace folder is open
2. inspect repository state and compute the missing scaffold entries
3. collect only initialization inputs that cannot be derived, such as an optional default domain or maintainer owner string
4. create the missing scaffold entries through `vscode.workspace.fs`, including folder structure and the minimal seed files needed for discovery and authoring flows
5. refresh the explorer and offer to create the first artifact immediately

Bootstrap should never rewrite existing files. If a seed file already exists, that file is treated as authoritative and left untouched.

The initial scaffold should be enough to make the repository recognizable and operable without any manual folder creation. At minimum that means the canonical `specs` category directories, extension-expected local configuration, and minimal index or starter files needed for the explorer and subsequent create flows.

## Artifact Creation Flow

The create-artifact flow should:

1. choose artifact class: specification, architecture, work-item, or verification
2. collect minimal metadata for the selected template
3. derive the canonical target path from artifact class and domain
4. create the domain folder and `_index.md` when that domain is new for the selected class
5. reject collisions before writing
6. write the rendered file
7. open the result in the correct editor and refresh explorer state

For markdown artifacts, trace-link inputs should be written into explicit sections rather than inferred from repository history or parsed document content. This keeps the first pass predictable and auditable.

## Safety and Constraints

The design intentionally keeps these invariants:

- all writes remain inside the current workspace root
- all filesystem operations use browser-host-safe VS Code APIs
- existing files are never silently overwritten
- index creation is additive only; user-authored indexes are not rewritten in place during this pass
- specification JSON continues to be the only structured editor surface in scope

## Deferred Follow-On Work

The first management pass does not include:

- structured editors for architecture, work-item, or verification markdown artifacts
- repository-local template overrides or inheritance rules
- automatic trace-link inference from other artifacts
- code lenses, bulk operations, or cross-repository management

Those capabilities should be specified separately once the bootstrap and additive creation path is in place.
