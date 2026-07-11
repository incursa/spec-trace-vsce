---
artifact_id: ARC-VSCE-EDITOR-REGISTER
title: Local Requirement Register and Inspector
summary: Design for a manager-inspired requirements workspace that retains local canonical file authority and VS Code document semantics.
---
# ARC-VSCE-EDITOR-REGISTER

## Purpose

Define the local-only requirements workspace used to satisfy `REQ-VSCE-EDITOR-0021` through `REQ-VSCE-EDITOR-0025` in [`SPEC-VSCE-EDITOR`](../../requirements/spec-trace-vsce/SPEC-VSCE-EDITOR.json).

## Trace Links

- Satisfies: `REQ-VSCE-EDITOR-0021` through `REQ-VSCE-EDITOR-0025`
- Related implementation: [`src/web/editor/webview/main.ts`](../../../src/web/editor/webview/main.ts)
- Host lifecycle: [`src/web/editor/host/specificationCustomEditor.ts`](../../../src/web/editor/host/specificationCustomEditor.ts)

## Authority Boundary

[`SpecificationDocument`](../../../src/web/editor/core/specification.ts) remains the sole content model. Search, filters, sorting, view selection, row expansion, and inspector selection are webview state only. They never enter canonical JSON and never create an undo entry.

The register projects each displayed row from a source requirement index. Sorting and filtering change display order only. Editing, moving, and removing always target the source index. Selection retains an index hint as well as an identifier so a temporarily blank or duplicate identifier cannot silently redirect edits to another requirement.

## Register and Inspector

The default workspace combines:

- compact document details above the requirement task
- Overview and Reading register views
- local search, coverage/issue filters, and sorting
- a selected-requirement inspector beside the register at wide widths
- a stacked inspector at narrow widths
- a focused edit screen for high-attention changes

Overview presents locally derived coverage, trace, notes, and validation state. Reading emphasizes authored identifiers, titles, and complete normative statements. No server lifecycle meaning is inferred.

## Typed Editing

Coverage editing changes only the canonical `positive`, `negative`, `edge`, and `fuzz` keys and preserves nested `x_...` keys. Adding coverage uses the deliberate authoring defaults `required`, `required`, `required`, and `optional`; removing it removes the whole optional `coverage` object.

Trace editing changes only `satisfied_by`, `implemented_by`, `verified_by`, `derived_from`, `supersedes`, `upstream_refs`, and `related`. Known lists are repeatable controls. Nested extension keys remain untouched.

## Service Features Excluded

The extension does not import the manager record DTO or add network, authentication, sharing, import, audit, record-version, comparison, operational validation/evidence state, or revalidation concepts. A Contracts view remains unavailable until a typed local canonical contract shape exists.

## Document Lifecycle

The existing custom-document provider remains authoritative for edit history, dirty state, undo and redo, save, revert, backup, validation-before-write, deterministic serialization, and external disk conflict detection. The webview reports document edits but never claims that persistence succeeded before the host synchronizes state back.
