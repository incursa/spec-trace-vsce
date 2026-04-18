# Change Log

All notable changes to the Spec Trace extension are documented in this file.

## [Unreleased]

- No unreleased changes yet.

## [1.0.12]

- Managed architecture, work-item, and verification markdown files now open in the custom editor by default when opened normally from the workspace.
- Plain-text fallback remains available through the Open With flow for managed markdown files.

## [1.0.11]

- Expanded the managed markdown authoring surface with class-specific narrative sections for architecture, work-item, and verification artifacts.
- Broadened canonical trace editing so work items expose separate addressed, design-link, and verification-link lists.
- Added browser smoke coverage and core round-trip tests for the managed markdown editor surfaces.

## [1.0.10]

- Expanded browser-safe repository browsing with grouped artifact views, local filtering, trace navigation, and explicit fallback handling for malformed entries.
- Added managed markdown authoring for canonical architecture, work-item, and verification artifacts.
- Added read-only quality and attestation viewing for repo-local evidence and references.
- Updated artifact creation and browser smoke coverage for the new managed surfaces.

## [1.0.6]

- Added a Spec Trace repository explorer with category, domain, document, and requirement nodes.
- Added a custom editor for specification JSON files under `specs/requirements/**/*.json`.
- Reworked the requirement experience into a browse-first dense index with a dedicated detail screen.
- Added requirement search and coverage-state filters for large specifications.
- Added previous and next navigation in the requirement detail screen.
- Added browser-hosted smoke coverage for the repository explorer and custom editor flows.
- Updated the marketplace listing metadata, icon, and release packaging workflow.
