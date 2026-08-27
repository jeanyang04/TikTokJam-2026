# 02: Store v2 migration + permissions field

**What to build:** The JSON store (`store.ts`) learns the new v2 shape (`Agent.ownerId`, `Agent.permissions`, and the new `runTokens`/`policyGrants`/`approvals`/`runEvents` collections, per Zeon's `types.ts`) and migrates existing v1 files up automatically, filling sane defaults so nothing that loaded before stops loading.

**Blocked by:** Zeon's `types.ts` being finalized (external — not a ticket in this list; coordinate in chat, don't block on it silently).

**Status:** ready-for-agent

- [ ] `store.ts` detects `version:1` files and migrates to `version:2` on load
- [ ] Migrated agents get `ownerId:"user-jean"`, `permissions` defaulted from existing sandbox/network config, `tools:[]`
- [ ] New empty collections (`runTokens`, `policyGrants`, `approvals`, `runEvents`) are created on migration
- [ ] A v1 fixture file loads without error and produces valid v2 data
- [ ] `npm run check` stays green
- [ ] Test: existing v1 store file loads, migrated fields have expected defaults
