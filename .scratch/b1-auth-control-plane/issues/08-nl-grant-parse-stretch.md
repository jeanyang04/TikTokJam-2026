# 08: NL grant parse (stretch)

**What to build:** A text box path to the same approval flow as ticket 06: the user describes a grant in plain English ("let Researcher read Writer's notes but nothing else"), the server calls Ark with a JSON schema to parse intent, validates with zod, re-checks that the referenced agents/resources exist and belong to the caller, and lands it as a pending card (`source:"nl_intent"`) identical in shape to a live-deny card.

**Blocked by:** 06 (Approval, grant, and timeline routes). Do not start before Sync 2 has passed — this is the only stretch item and is first to be cut if time is short.

**Status:** ready-for-agent

- [ ] `POST /api/grants/parse {text}` calls Ark server-side with a JSON schema for grant intent
- [ ] Response validated with zod
- [ ] Referenced agent/resource names re-checked against the store and the caller's ownership before any card is created
- [ ] Successful parse creates an `ApprovalRequest{source:"nl_intent"}` identical in downstream handling to a live-deny card
- [ ] Regex fallback covers the demo grammar: `let <agent> read <agent>'s (notes|workspace)`
- [ ] Test: valid NL phrase produces a pending card; a phrase referencing another tenant's agent is rejected before a card is created
