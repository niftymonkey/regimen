# The instruments are Guidance, Enforcement, and Feedback, cut by mechanism

> Status: accepted (2026-05-18)

Regimen's three instruments are cut by the mechanism each uses on the interaction: Guidance (advisory skills that instruct the agent), Enforcement (mandatory mechanisms that compel an outcome regardless of the model), and Feedback (sensing that observes how the interaction went). The cut is by mechanism rather than by purpose. The reliability boundary between advisory and mandatory is fundamental: an advisory skill and a mandatory mechanism are different kinds of thing even when they serve the same goal, and a cut by purpose would bundle them together and hide that boundary.

Update: the cut of the three as co-equal instruments is superseded by ADR-0013, which makes Feedback the center and Guidance and Enforcement the levers. The advisory-versus-mandatory boundary between Guidance and Enforcement recorded here is preserved as the distinction between the two levers.

Update: the cut is by mechanism, not by form, so each lever is broader than its most visible instance. Guidance spans any advisory offering (a skill, a standing-instruction line in `CLAUDE.md` or `AGENTS.md`, an MCP server or CLI the agent may use); Enforcement spans any deterministic mechanism (a hook or gate, a permission boundary, a CI or pre-merge check, a sandbox, schema-constrained output). Skills and gates are the most visible instances, not the whole of either category.

## Considered options

- Cut the instruments by purpose instead of by mechanism. Rejected: it bundles advisory and mandatory mechanisms into one box and hides the reliability boundary that actually matters.
- Add a fourth instrument for the AI's standing context. Rejected: context is a property of the interaction that the instruments act on, not an addition Regimen makes.
