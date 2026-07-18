# Unified Agent Strategy and KOL Search

## Goal

Make KOL Campaign OS equally reliable for Codex, Kimi, and other tool-capable
agents. Agents may connect through MCP or HTTP, but all business execution must
remain inside KOL Campaign OS. External web discovery, direct candidate writes,
and agent-defined Strategy schemas are not allowed.

The stable external workflow is:

```text
user conversation
-> Strategy Intake
-> system-generated Strategy draft
-> explicit Strategy publish confirmation
-> explicit Finder run confirmation
-> system-controlled KOL search
-> human candidate approval
```

## Ownership

KOL Campaign OS owns:

- the Strategy schema and its versions
- Strategy generation, normalization, and validation
- confirmation records and expiry
- provider selection and KOL discovery
- evidence import, crawling, analysis, and author aggregation
- Finder execution state and recovery
- candidate creation and deduplication

The external agent owns only:

- collecting the user's natural-language brief
- relaying system-generated clarification questions
- showing system-generated summaries
- forwarding explicit user confirmations
- reporting system status and results

The user owns:

- supplying business context
- confirming Strategy publication
- confirming a Finder run and its potential API cost
- approving candidates into the KOL master data

## Strict Execution Mode

OS Strict Mode is always enabled for agent workflows.

Allowed transports are MCP and HTTP. A browser may be used only to operate the
OS user interface; it is not an alternate discovery provider. A pure-chat agent
may provide instructions but may not claim to have executed a task.

An agent must never:

- use its own web or browser search to discover KOLs
- select or orchestrate discovery providers
- submit profile-only results as candidates
- construct or write internal Strategy JSON directly
- write `raw_candidates` or other business tables directly
- score or approve candidates outside the OS workflow
- switch to an external discovery path after an OS provider failure

Provider or configuration failures must fail closed. The run becomes `blocked`
and reports the exact OS setting that needs attention.

## Settings Cleanup

Remove the `Agent / Automation Providers` settings area. BrowserAct, Playwright
Local, and Custom Tool Gateway are not valid OS discovery providers, and keeping
reserved controls for them would contradict Strict Execution Mode.

Maton Gateway remains supported, but only as a YouTube platform data provider.
`youtube.maton_gateway` is the canonical configuration key. Finder must read the
selected YouTube platform provider and then load `youtube.maton_gateway`; it must
not read `agent.maton_gateway` as the primary configuration.

Configuration cleanup is intentionally direct:

1. Keep `youtube.maton_gateway` unchanged as the only canonical Maton setting.
2. Delete the obsolete `agent.maton_gateway` record without copying or fallback.
3. Delete other obsolete `agent.*` automation-provider records for BrowserAct,
   Playwright Local, and Custom Tool Gateway.
4. Stop reading and writing `agents.active`, `agents.providers`, and all
   automation-provider settings after cleanup.

The cleanup must never modify `youtube.maton_gateway` or `agent.external_api`.

Rename `External Agent API` to `Agent Access` in the user interface. This area
owns MCP and HTTP access, protocol version, access credentials, connection
status, and the always-enabled Strict Mode notice. It must not claim that an
external agent can import or write Raw Candidates directly.

The resulting settings information architecture is:

- platform data providers
- AI model providers
- agent access
- cloud storage
- runtime and OS-provider fallback policy

Runtime fallback may select only formally integrated OS platform providers. It
must never fall back to agent browser search or browser automation.

## Transport Architecture

MCP is the preferred agent transport. HTTP is a compatibility transport for
agents that support function or HTTP calling but not MCP. One session selects a
transport once and does not switch transports during a run.

Both transports are thin adapters over the same internal action interface:

```text
MCP adapter  ---+
                +-> Agent Action interface -> Strategy Intake / Agent Run
HTTP adapter ---+
```

MCP and HTTP must use the same action names, input schemas, output schemas,
status values, and error codes. A single machine-readable schema source must
generate or validate:

- MCP tool definitions
- HTTP/OpenAPI action definitions
- server-side request validation
- agent-facing reference documentation

The adapters must not contain Strategy, Finder, provider, or database business
logic.

## External Action Interface

The initial interface contains eight actions:

- `inspect_os`
- `list_campaigns`
- `start_strategy_intake`
- `continue_strategy_intake`
- `revise_strategy_draft`
- `publish_strategy`
- `start_kol_search`
- `get_kol_search_status`

`inspect_os` reports protocol compatibility and OS readiness. It must not invite
the agent to choose an alternate execution method.

Example capability response:

```json
{
  "protocol_version": "1.0",
  "system": "kol-campaign-os",
  "strict_mode": true,
  "allowed_transports": ["mcp", "http"],
  "external_discovery_allowed": false,
  "direct_candidate_creation_allowed": false,
  "manual_approval_required": true
}
```

## Strategy Contract

Strategy is a system-owned, versioned contract. The external agent submits a
natural-language brief and structured intake answers, not the internal Strategy
document.

The first contract version must include stable sections for:

- product and campaign context
- target audience and market
- creator personas and exclusions
- platform plan
- discovery keywords and exclusions
- eligibility rules
- ranking weights
- risk rules
- Finder handoff

Each Strategy stores:

- `schema_version`
- `revision`
- lifecycle status
- editable draft configuration
- immutable published configuration
- generated user-facing summary
- validation results
- source material metadata

High-frequency lookup fields such as campaign, market, language, primary
platform, status, schema version, and revision may remain normal database
columns. Complex configuration may remain JSON initially, but it must be
validated against the system schema before storage and publication.

Publishing creates an immutable revision. Finder runs bind to the exact
published Strategy revision, not to a mutable draft.

## Strategy Intake

`start_strategy_intake` accepts a campaign identifier and natural-language
brief. OS extracts known facts, identifies missing required facts, and returns
either clarification questions or a generated draft.

Strategy Intake is a mandatory business-context gate, not an optional assistant
feature. No Strategy draft may become publishable and no Finder confirmation may
be created until the gate is complete.

At minimum, OS must obtain and have the user confirm:

- the exact campaign, project, product, or service being promoted
- the campaign goal
- target market or region
- content language
- exactly one initial target platform
- target creator profile or persona
- important product selling points and content scenarios
- exclusions, competitors, or prohibited creator types when applicable
- target count
- follower or creator-tier preference, or explicit acceptance of system defaults

The system, not the external agent, decides whether required context is missing.
The agent must relay OS questions without silently answering them from old
conversations, recent database rows, placeholder campaigns, inferred defaults,
or its own assumptions.

Before draft generation, OS returns a normalized intake summary and asks the
user to confirm that the captured requirements are correct. This intake
confirmation is distinct from Strategy publication confirmation: the first
confirms the user's requirements, while the second approves the generated
Strategy revision.

`continue_strategy_intake` accepts answers using question identifiers generated
by OS. The external agent must not invent required fields or silently infer a
campaign, product, market, platform, or Strategy.

`revise_strategy_draft` accepts a natural-language change request. OS applies
the change to the fixed contract, increments the revision, validates the result,
and produces a new summary and confirmation record.

Strategy Intake states are:

```text
collecting_input
-> awaiting_intake_confirmation
-> generating
-> draft_ready
-> awaiting_publish_confirmation
-> ready
```

Terminal or exceptional states are `blocked`, `failed`, and `cancelled`.

## Explicit Confirmation

Strategy publication and Finder execution require separate confirmations.
Confirmation is an OS record, not an agent interpretation of conversational
sentiment.

There are three explicit user gates in total:

1. confirm the normalized Strategy Intake requirements
2. confirm publication of the generated Strategy revision
3. confirm the Finder run, target platform, target count, and potential cost

Completing a later gate is impossible without valid completion records for all
earlier gates.

For Strategy publication, OS returns a user-facing summary and a confirmation
record bound to:

- action `publish_strategy`
- Strategy identifier
- exact draft revision
- expiry time

The user must explicitly confirm publication. Ambiguous phrases, silence, or an
agent's own judgment do not count. Any draft edit invalidates the prior
confirmation.

For Finder execution, OS creates a second confirmation bound to:

- action `start_kol_search`
- Strategy identifier and published revision
- one target platform
- target count
- expiry time

A Strategy confirmation cannot authorize Finder execution. Finder confirmation
exists separately because the run may incur provider and AI costs.

## Agent Run

`start_kol_search` creates a persistent Agent Run after validating its Finder
confirmation. The external request remains small and stable:

```json
{
  "protocol_version": "1.0",
  "strategy_id": 45,
  "strategy_revision": 4,
  "target_platform": "youtube",
  "target_count": 20,
  "confirmation_id": "confirm_finder_xxx",
  "idempotency_key": "conversation-123-request-5"
}
```

`idempotency_key` prevents duplicate runs when an agent retries after a timeout.
The external identifier is always `run_id`. Callers treat it as opaque; they do
not parse whether an early implementation maps it to a Finder task or a later
implementation maps it to an `agent_runs` row.

The Agent Run state machine is:

```text
awaiting_run_confirmation
-> queued
-> discovering
-> collecting_evidence
-> analyzing
-> generating_candidates
-> awaiting_human_review
```

Exceptional states are `blocked`, `failed`, and `cancelled`. Each response
includes progress, a stable error code when relevant, and one explicit next
action. The run must be persisted so processing can resume after a server
restart without duplicating completed stages.

## Finder Invariants

Agent Run preserves the existing Video Evidence Finder invariants:

- one run targets exactly one of YouTube, Instagram, or TikTok
- OS chooses the configured platform provider
- evidence video platform equals target platform
- profile URLs identify authors but are not video evidence
- every candidate is supported by analyzed video evidence
- evidence is deduplicated before analysis
- analyzed evidence is aggregated by author
- AI score ranks candidates but is not a hard rejection threshold
- high-risk and hard-filter failures do not enter the normal candidate pool
- candidate approval remains manual

## Compatibility and Versioning

Protocol `1.x` may add optional fields but must not remove fields, change their
meaning, or reinterpret existing statuses. Breaking changes require a new major
protocol version.

MCP must not mirror current Express routes one-to-one. During transition, an
internal adapter may orchestrate existing Strategy and Finder routes. Agent Run
can later replace that implementation without changing the external action
interface.

The first MCP release should not expose internal endpoints such as evidence
import, evidence analysis, candidate generation, provider selection, or direct
database operations.

## Error Handling

All adapters return the same structured errors. Required categories include:

- `protocol_version_unsupported`
- `os_not_ready`
- `campaign_not_found`
- `strategy_input_required`
- `strategy_validation_failed`
- `confirmation_required`
- `confirmation_expired`
- `strategy_revision_changed`
- `platform_provider_unavailable`
- `ai_provider_unavailable`
- `discovery_failed`
- `analysis_failed`
- `run_not_found`

Blocked responses identify the OS configuration page or field that needs user
attention. They must never suggest external web discovery as a fallback.

## Verification

Automated tests must prove:

- MCP and HTTP validate against the same action schemas
- the same action produces equivalent responses through both transports
- external agents cannot submit internal Strategy JSON
- incomplete intake produces system questions rather than an invalid draft
- Strategy generation cannot start before explicit intake confirmation
- agents cannot fill missing context from recent records, placeholders, or inferred defaults
- changing an intake answer invalidates intake confirmation and any generated draft based on it
- YouTube Finder reads Maton credentials only from `youtube.maton_gateway`
- an existing `youtube.maton_gateway` configuration is never overwritten or changed by cleanup
- cleanup removes `agent.maton_gateway` without copy or fallback
- cleanup removes other obsolete agent automation records
- Agent Automation providers are absent from settings responses and the user interface
- Strategy publication requires a valid, current confirmation
- draft revision changes invalidate old confirmations
- Finder requires a separate valid confirmation
- idempotent retries return the existing run
- one run uses one target platform and OS-selected providers only
- provider failures become `blocked` without external discovery
- a run resumes after restart without repeating completed stages
- only analyzed video evidence generates Raw Candidates
- the run stops at human candidate approval

End-to-end acceptance must run the same campaign brief through Codex and Kimi
and produce the same Strategy contract, run states, and OS-controlled Finder
workflow regardless of transport.

## Delivery Sequence

Implement in this order:

1. Remove Agent Automation settings and make `youtube.maton_gateway` canonical.
2. Strategy Contract v1, strict validation, revisioning, and publication snapshot.
3. Strategy Intake and separate confirmation records.
4. Shared Agent Action schemas and internal action interface.
5. MCP adapter and HTTP compatibility adapter.
6. Persistent Agent Run orchestration over the existing Finder workflow.
7. Codex and Kimi integration tests and skill updates.

Do not release MCP as a one-to-one wrapper around existing routes. The stable
action interface must exist before transport adapters are exposed.
