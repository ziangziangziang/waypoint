# Archive

This directory keeps previously vendored components that are no longer part of Waypoint runtime.

## `archive/codex`

- Origin: `https://github.com/openai/codex`
- Stored as a Git submodule for provenance and reproducibility.
- Last tracked commit in this repository: `7ff14d9cac9f0ad512fad3810e0c9f70f44e95d5`

### Why archived

Waypoint v0.4 realigns scope around:

- local model proxy
- web playground
- lightweight benchmark tooling

The archived Codex subtree is retained for historical reference only and is not used by the active Waypoint server/CLI runtime paths.
