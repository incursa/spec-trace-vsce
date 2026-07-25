# Optional Workbench Integration

The desktop entry point is an enhancement over the portable SpecTrace core. It
is never required to browse, validate, navigate, or edit canonical artifacts.

## Discovery

The extension checks the configured `specTrace.workbench.executable`, then
`.workbench/bin`, `.workbench/tools`, and finally executable entries on `PATH`.
It does not download, restore, or update Workbench itself.

## Allowed contract

`src/node/workbench/contracts.ts` is the complete allowlist:

| Operation | Workbench arguments after global `--repo` and `--format json` |
|---|---|
| Doctor | `doctor --json` |
| Validate | `validate` |
| Quality display | `quality show` |
| Proof health | `quality proof-health` |
| Quality preview | `quality sync --dry-run` |
| Quality synchronization | `quality sync` |

Arguments are passed without a shell. Standard input is closed. Standard output
must be one JSON value. Exit codes `0` and `1` are accepted because Workbench
uses `1` for completed doctor or validation runs with warnings. Other exit
codes, invalid JSON, timeout, cancellation, or output-limit overflow fail
closed.

## Trust and mutation boundary

All commands require a trusted, local file-system workspace. Quality
synchronization first executes the Workbench dry-run contract, displays its
structured result, and requires modal confirmation before the writing command.

Repository repair remains implemented by the portable extension because its
additive plan is locally inspectable and never overwrites existing files. The
extension intentionally does not expose Workbench `init`: that command is
interactive and includes setup surfaces outside the deterministic JSON
consulting-workstation contract.

No Codex, AI, voice, GitHub, worktree, pull-request, or credential-management
command is available through this extension.

## Contract parity

`src/shared/fixtures/workbench-contract.json` mirrors the canonical layout,
identifier prefixes, validation profiles, and validation categories from the
Workbench contract. Browser-host tests compare the fixture with the portable
constants and verify the desktop argument allowlist. If Workbench changes these
contracts, update the fixture and tests in the same reviewed change.
