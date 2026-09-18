# External Agent discovery console

Use this flow when the user hands off a request created at `/discovery`.
The user has authorized discovery for the saved project, product, platform,
target count, and requirements. Approval of candidates and email sending
remain human actions. Read the request; never infer it from the latest row.

## Connection

Use the OS origin explicitly supplied in the handoff, otherwise the base URL
in SKILL.md. Send the user's configured `Authorization: Bearer <token>` on
all `/api/agent/` calls. The token must belong to the user who created the
request. A request owned by another user returns 404. Never put the token
in copied instructions, artifacts, browser storage, screenshots, or chat.

Install/update this directory as `kol-campaign-os-agent` in the external
Agent's skill directory. The repository installer accepts an explicit target:
`npm run install-skills -- --target <external-agent-skills-directory>`.
Review existing local customizations before replacing an installed skill.
The console never launches an external Agent automatically. The user pastes
the generated instruction into their Agent session.

## Claim and execute

1. `GET /api/health`, then `GET /api/agent/discovery-requests/{id}`.
   Confirm the saved requirements, status, product and platform. If cancelled
   or completed, stop. If queued, generate one stable `execution_id` (UUID)
   for this execution and retain it across network retries.
2. `POST /api/agent/discovery-requests/{id}/claim`
   with `{ "execution_id": "<uuid>" }`. This atomically creates or reuses an
   empty Finder evidence task. It does **not** start an OS provider search.
   Repeating a successful claim with the same execution ID is safe.
   A 409 means another execution owns it or it has stopped. Do not invent a
   new execution ID to bypass that response. Ask the user to stop/requeue
   only if their previous Agent execution is no longer available.
3. Read `GET /api/agent/brief/{strategy_id}` for product and scoring context.
   The console currently requires a published strategy. Saved additional
   requirements are Agent-side qualification conditions, not a replacement
   strategy. If they conflict materially with the strategy, report blocked
   and explain the conflict; do not silently loosen a condition or publish a
   new strategy.
4. Search using available public-data tools. Check identity, geography and
   requested metric windows before importing. Do not fabricate unavailable
   metrics. Skip or report blocked when required verification is unavailable.
   The brief's existing-profile sample is not an exhaustive deduplication
   index; the OS performs authoritative identity deduplication at intake.
5. In small batches, `POST /api/agent/discovery-requests/{id}/evidence/import`
   with `{ "evidence": [{ "video_url": "...", "author_profile_url": "...",
   "title": "...", "source_query": "...", "evidence_reason": "verified fit and metrics, with source/date" }] }`.
   Use videos from the saved target platform. A profile URL alone is not evidence.
6. `POST /api/agent/discovery-requests/{id}/analyze`, then
   `POST /api/agent/discovery-requests/{id}/generate` with `{}`. These reuse
   the existing OS analysis and Raw-candidate generation. Inspect per-item
   failures even on HTTP 200; retry only failed work, never force reanalysis
   of successful evidence by default. Read
   `GET /api/agent/discovery-requests/{id}/evidence` to inspect previous work.
7. Read the request again for the actual `candidate_count`. Continue only
   within the requested count (maximum 50 per round) and any user-specified
   search/cost limits. Stop after two consecutive search batches yield no new
   eligible creators; report the shortfall. Never run an unbounded search.

For the three write operations in steps 5–6 send
`X-Discovery-Execution-Id: <uuid>` in addition to the Bearer token. Use these
request-scoped endpoints rather than creating a second Finder task or using
legacy direct Raw-candidate import. Do not approve Raw candidates.

## Progress, interruption, completion

At each stage and between batches, read the request status and call
`POST /api/agent/discovery-requests/{id}/progress`:

```json
{
  "execution_id": "<uuid>",
  "status": "running",
  "stage": "verifying",
  "note": "核验本批达人地区与最近 10 条视频，已排除 3 个商家账号"
}
```

Stages: `searching`, `verifying`, `analyzing`, `writing`; terminal completion
uses `status: completed, stage: done`. Completion means this search round
ended, not that the target count was met or candidates were approved. Explain
any shortfall in `note`. Do not report invented result counts; the console
counts actual stored candidates. For a blocker use `status: blocked`, a
nonterminal stage, and a concrete explanation. Notes are at most 2,000 chars
and must contain no credentials or raw provider dumps.

Stop immediately on cancelled status or a 409 from a request-scoped write.
Already in-flight HTTP work may finish after cancellation. The user can
requeue blocked/cancelled requests; a new claim reuses the same evidence task
and retained results. Do not poll a stopped request indefinitely. For a lost
HTTP response, read state before retrying; terminal progress retries with
the same execution ID and content are idempotent.

Finish by linking `/finder?finder_task_id=<returned finder_task_id>` so the
user reviews this round's results in the existing Raw candidate page.
