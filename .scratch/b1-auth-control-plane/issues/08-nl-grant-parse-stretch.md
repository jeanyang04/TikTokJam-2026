# 08: NL grant parse (stretch)

**What to build:** A text box path to the same approval flow as ticket 06: the user describes a grant in plain English ("let Researcher read Writer's notes but nothing else"), the server calls Ark with a JSON schema to parse intent, validates with zod, re-checks that the referenced agents/resources exist and belong to the caller, and lands it as a pending card (`source:"nl_intent"`) identical in shape to a live-deny card.

**Blocked by:** 06 (Approval, grant, and timeline routes). Do not start before Sync 2 has passed — this is the only stretch item and is first to be cut if time is short.

**Status:** done. See `docs/SEAMS.md` § Natural-language grants.

- [x] `POST /api/grants/parse {text}` calls Ark server-side with a JSON schema for grant intent, when `isArkConfigured`. The request shape is **unverified against a live endpoint**; it follows `llm-proxy.ts`'s `${arkBaseUrl}/responses`, and every failure falls through to the grammar
- [x] Response validated with zod (`intentSchema`), before any name is resolved. The model's answer is untrusted input like any other
- [x] Referenced agent names re-checked against the store and the caller's ownership before any card is created
- [x] Successful parse creates an `ApprovalRequest{source:"nl_intent"}`, `kind:"grant"`, with the same `grant` payload `gateway.ts` builds. A test approves one with `allow_always` and asserts the PolicyGrant lands, which is what proves "identical downstream" rather than a shape assertion on the card
- [x] Regex fallback covers the demo grammar: `let <agent> read <agent>'s (notes|workspace)`, plus the curly apostrophe, `files`, and `write`
- [x] Test: valid NL phrase produces a pending card; a phrase referencing another tenant's agent is rejected before a card is created. 19 tests in `nl-grant.test.ts`

**Deliberate deviations, all recorded in SEAMS**

- **Another tenant's agent yields 404, not 403.** Names are not unique between tenants, so resolution is filtered to the caller's own agents first. That removes a name-existence oracle and a mis-hit on a shared name, and it means the route can reach nothing cross-tenant to refuse. CLAUDE.md rule 3 governs reaching an existing resource *by id*; no id is ever supplied here.
- **The route is exempt from the ownership gate** via `idlessRoutes` in `app.ts`, matched on the exact registered route string. It names no id, and it checks ownership itself.
- **A card that already exists is returned with `200`, not the contract's `201`.** It shares the gateway's dedupe key on purpose, so a Scene 1 live deny already covers the same access; claiming to have created it would be false and the badge would contradict it.
- **No CRM grants, and one action per card.** `crm_read`/`crm_write` are scope-gated and never consult `findLiveGrant`, so a `crm` PolicyGrant would be a row nothing reads.
- **`allow_run` on these cards is refused with a 409**, because `approvals.ts` would otherwise write a permanent grant from the narrower button.

**Left for others**

- **Zeon, the one real defect this ticket surfaced:** `approvals.ts`'s grant branch reads the run window off `card.jti` with no fallback when it is null, so `allow_run` yields `expiresAt: null`. Guarded from `AgentService.decideApproval` rather than fixed in your file. A `?? tenMinutesFromNow` there retires the guard and gives these cards all three buttons.
- **Zeon, contract:** `docs/API.md:73` needs the 200 case and the 404/422 this route answers.
- The Ark wire format is B2's; this is its second caller, and it is unverified against a live endpoint.
- F still has to build the text box (their Day 3 stretch).
