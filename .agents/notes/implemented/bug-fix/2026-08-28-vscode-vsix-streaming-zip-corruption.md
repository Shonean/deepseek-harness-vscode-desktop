# Agent Note: pack-vsix's streaming zip corrupted entries; batch zipSync plus verification replaces it

Status: implemented

English | [中文](2026-08-28-vscode-vsix-streaming-zip-corruption.zh.md)

## Problem

The first closure-bearing VSIX (~12.6k entries) failed to extract reliably: bsdtar aborted partway and `unzip -t` reported bad CRCs on three KaTeX font entries under the web frontend's assets. A byte comparison confirmed real archive damage — the extracted bytes differed from the packed source files — so the corruption happened while writing the archive, not while materializing the closure. `scripts/pack-vsix.mjs` built the archive with fflate's streaming `Zip`/`ZipDeflate`, pushing every entry synchronously into one `Zip` instance. A 59-entry repro of the same pattern on the same font directory produced a clean archive, so the failure is scale- or ordering-dependent inside the streaming state machine; the exact trigger was not isolated.

## Decision

`pack-vsix.mjs` builds the archive with fflate's batch `zipSync` (one synchronous call over the full entry map, ~200 MB peak for the ~120 MB closure input) and then verifies the artifact before reporting success: `unzipSync` reads the whole archive back and throws on any CRC or structure mismatch, and the entry count is compared against the packed map. A corrupted entry now fails the pack instead of surfacing as an unextractable VSIX.

## Alternatives considered

- Fixing the streaming pattern (awaiting per-entry completion through the `Zip` callback handshake) was rejected: fflate 0.8's `Zip` does not expose per-entry completion, and the failure mode was not understood well enough to trust a handshake against it.
- Shelling out to `bsdtar --format zip` was rejected: GNU tar (the default `tar` on Linux CI images) cannot write zip, so the script would become platform-conditional.
- Keeping streaming and adding a post-hoc `unzip -t` gate was rejected: it would still rely on the code path that produced the damage.

## Consequences

- Packed VSIXes are CRC-verified end to end on every pack; the first post-fix artifact passed `unzip -t` with zero errors across all ~12.6k entries.
- Peak memory during pack is a few hundred MB (entry map + archive + verification read-back) — acceptable for a packaging script.
- The one-shot failure mode to watch for remains extraction performance on the user's machine, not archive integrity.
- Verification: full `unzip -t` green on the repacked VSIX; manual install of that artifact completed with all 12,625 files on disk.
