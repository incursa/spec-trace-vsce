---
artifact_id: WI-VSCE-EDITOR-REGISTER
title: Converge the Local Requirements Workspace
summary: Implement the manager-inspired local requirement register, inspector, and canonical typed editing controls.
---
# WI-VSCE-EDITOR-REGISTER

## Purpose

Deliver `REQ-VSCE-EDITOR-0021` through `REQ-VSCE-EDITOR-0025` using [`ARC-VSCE-EDITOR-REGISTER`](../../architecture/spec-trace-vsce/ARC-VSCE-EDITOR-REGISTER.md).

## Trace Links

- Addresses: `REQ-VSCE-EDITOR-0021` through `REQ-VSCE-EDITOR-0025`
- Uses design: [`ARC-VSCE-EDITOR-REGISTER`](../../architecture/spec-trace-vsce/ARC-VSCE-EDITOR-REGISTER.md)
- Verified by: [`VER-VSCE-EDITOR-REGISTER`](../../verification/spec-trace-vsce/VER-VSCE-EDITOR-REGISTER.md)

## Planned Changes

- reshape the existing browse-first index into a register with Overview and Reading views
- keep a persistent inspector beside the register and stack it responsively
- preserve source-index selection across projections and transient duplicate identifiers
- move document details ahead of the long requirements surface
- provide typed coverage selectors and repeatable canonical trace editors
- retain focused editing, add, remove, reorder, validation, and VS Code document lifecycle behavior
- refresh smoke coverage, screenshots, README, changelog, and Marketplace release evidence

## Out of Scope

- manager API or DTO reuse
- authentication, access roles, sharing, imports, and server pagination
- audit history, content versions, comparison, revalidation, or operational state
- a Contracts view before a typed local canonical contract shape exists
