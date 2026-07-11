---
artifact_id: VER-VSCE-EDITOR-REGISTER
title: Verify the Local Requirement Register and Inspector
summary: Verification plan for the responsive local requirements workspace and typed canonical editing.
---
# VER-VSCE-EDITOR-REGISTER

## Purpose

Verify `REQ-VSCE-EDITOR-0021` through `REQ-VSCE-EDITOR-0025` without weakening the existing custom-document lifecycle.

## Trace Links

- Verifies: `REQ-VSCE-EDITOR-0021` through `REQ-VSCE-EDITOR-0025`
- Related design: [`ARC-VSCE-EDITOR-REGISTER`](../../architecture/spec-trace-vsce/ARC-VSCE-EDITOR-REGISTER.md)
- Related work item: [`WI-VSCE-EDITOR-REGISTER`](../../work-items/spec-trace-vsce/WI-VSCE-EDITOR-REGISTER.md)

## Verification Approach

- core tests prove deterministic round-trip preservation of top-level, requirement, coverage, and trace extension fields
- browser smoke covers Overview and Reading, search/filter/sort selection, inspect, edit, typed coverage and trace changes, add/remove, and save
- narrow-viewport smoke confirms stacked inspector behavior and reachable actions without horizontal page scrolling
- validation smoke confirms real issues are announced and invalid content remains save-blocked
- existing extension-host coverage continues to prove save, undo/redo, revert, backup, and external-conflict behavior

## Release Evidence

The release is acceptable only when `npm test`, `npm run release:check`, VSIX packaging, GitHub Validate, and the GitHub Marketplace Publish workflow all pass for the same release content.

## Current Automated Evidence

- deterministic serialization tests preserve top-level, requirement, coverage, and trace extension fields
- browser smoke covers persistent inspection, Overview and Reading views, typed coverage and trace edits, focused editing, save, and reload persistence
- browser smoke checks narrow layout for horizontal overflow and verifies the inspector stacks instead of remaining sticky
- the existing extension-host suite remains the regression gate for browser-safe repository and custom-editor integration
