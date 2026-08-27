# 02: Store v2 migration + permissions field

**What to build:** The JSON store (`store.ts`) learns the new v2 shape (`Agent.ownerId`, `Agent.permissions`, and the new `runTokens`/`policyGrants`/`approvals`/`runEvents` collections, per Zeon's `types.ts`) and migrates existing v1 files up automatically, filling sane defaults so nothing that loaded before stops loading.

**Blocked by:** Zeon's `types.ts` being finalized (external — not a ticket in this list; coordinate in chat, don't block on it silently).

**Status:** done

- [x] `store.ts` detects `version:1` files and migrates to `version:2` on load
- [x] Migrated agents get `ownerId:"user-jean"`, `permissions` defaulted from existing sandbox/network config, `tools:[]`
- [x] New empty collections (`runTokens`, `policyGrants`, `approvals`, `runEvents`) are created on migration
- [x] A v1 fixture file loads without error and produces valid v2 data
- [x] `npm run check` stays green
- [x] Test: existing v1 store file loads, migrated fields have expected defaults

`migrateDatabase` itself landed with Zeon's contract commit (`0c6a2a8`); this ticket
added the tests that pin it (`store.test.ts`, commit `e374e0a`).

**Deviation on the permissions default.** `DEFAULT_PERMISSIONS` hardcodes
`sandbox: "workspace-write"` rather than reading `config.codexSandboxMode`, and
`config.ts` has no network setting at all, so "defaulted from existing
sandbox/network config" only ever meant sandbox. The value is inert today —
`buildCodexArgs` still reads `config.codexSandboxMode` directly — but once B2 wires
per-agent permissions, an operator running `CODEX_SANDBOX_MODE=read-only` gets
migrated agents silently widened to workspace-write. Left for B2's seam.
