---
name: kol-campaign-os-agent
description: Connect to and operate KOL Campaign OS for campaign strategy, one-platform video-evidence discovery, KOL Master search, candidate-pool intake, and Agent-written email drafts entering the review desk. Use when the user mentions KOL Campaign OS, KOL strategy, KOL Finder, finding creators, adding campaign candidates, writing first-contact emails, or putting Agent drafts into the email approval queue.
---

# KOL Campaign OS Agent

## Connect

Use app HTTP APIs only. Never access MySQL directly.

- Production `base_url`: `http://59.110.45.218`. Use the client's `--base-url` only when the user explicitly selects another environment.
- Treat production as the source of truth. Use localhost only for code development and tests.
- Check `GET {base_url}/api/health` first.
- Use bundled `scripts/os-client.cjs` (Node.js 18+) for authenticated HTTP requests. Resolve its path relative to this installed skill, not a repository checkout. No npm dependencies or manual Token/environment setup is required.
- On first use run `node "<skill-dir>/scripts/os-client.cjs" login`. It opens the OS browser login and displays a connection code and verification URL. Show the URL/code to the user if the browser does not open. The user logs in and explicitly allows the matching connection; passwords stay in the OS browser. Keep the bounded login command running while the user authorizes (at most ten minutes).
- On later uses run `status` or make the requested API call directly. The client saves authorization in the current user's private home directory (Windows DPAPI; Unix private file permissions), automatically supplies credentials, and renews access. Do not read/decrypt that cache, copy browser cookies, print credentials, or ask users to paste them into chat.
- If login is expired, revoked, or explicitly denied, report it and guide the user through browser login again. Never use SSH or SQL to bypass authentication. `logout` revokes this connection; the OS Settings → Skill connections page can revoke any of the user's connections.

Use the HTTP API for all campaign, creator, candidate, Finder, and draft reads or writes. Examples below describe API payloads; the bundled client supplies authentication automatically:

```sh
node "<skill-dir>/scripts/os-client.cjs" request GET "/api/emails/settings/sync-status"
node "<skill-dir>/scripts/os-client.cjs" request GET "/api/emails/threads?customer_id=123"
node "<skill-dir>/scripts/os-client.cjs" request POST "/api/agent/campaigns/1/email-drafts/batch-upsert" --body-file "validated-drafts.json"
```

Use a JSON file for write bodies, retaining the previews and human approvals required below. Never log request authentication. A 401/403 after the client's automatic renewal is an authentication/permission blocker; 404 on the browser-login endpoints means the server needs the matching release.

## Read-only email and creator access

These existing HTTP endpoints accept the bundled client's browser-authorized
identity or an ordinary OS browser session:

- `GET /api/emails/settings/sync-status`
- `GET /api/emails/threads?customer_id=<id>&campaign_id=<id>&page=1&pageSize=20`
- `GET /api/emails/threads/<id>`
- `GET /api/customers` (existing search and pagination parameters)
- `GET /api/customers/<id>`
- `GET /api/customers/<id>/project-history`

Authorization must belong to an active user. Mailbox status and email threads are
restricted to that owner; another owner's thread returns 404. Customer records
remain the shared KOL Master, as in the existing authenticated web application.
This permission does not include mailbox configuration, sync-now, snapshots,
draft generation, approval, sending, or any mutation. A configured mailbox does
not authenticate the Agent, and a browser login does not authenticate separate
HTTP requests. Use the bundled login flow; never copy browser cookies. Legacy
manual Agent Tokens remain compatible for existing integrations and are not
required for new Skill connections.

Use sync status to report freshness, then inspect thread timelines for actual
sent messages and inbound replies. Project history or Feishu status alone is
not evidence of contact or a reply. No matching visible thread means no evidence
was found in this account, not proof that the creator was never contacted.

## SSH Diagnostics

Use SSH only for production service status, logs, release inspection, performance diagnosis, and an explicitly approved deployment. Never use SSH to bypass the Agent API for business data.

- Host: `codexdiag@59.110.45.218`
- Windows key: `C:\Users\Administrator\.ssh\codexdiag_kol_59_110_45_218`
- Connect non-interactively with `ssh -i <key> -o BatchMode=yes codexdiag@59.110.45.218 <command>`.
- Main release link: `/opt/kol-campaign-os/current`
- Releases: `/opt/kol-campaign-os/releases/`
- Main service: `kol-campaign-os.service`

If the key is unavailable or rejected, report the access blocker; never request or handle the root password. Default to read-only SSH commands. Modify code only in the local Git workspace, then test, commit, push GitHub, and deploy as a new release after explicit user confirmation. `sudo` is temporary for deployments only and must be revoked and verified afterward.

`/opt/webhook-service` and PM2 process `feishu-webhook` are independent. Do not modify, move, overwrite, restart, or deploy them during main-system work. After a main release, only verify that the process and its health endpoint remain online.

Prefer the restricted `/api/agent` endpoints for KOL Master, candidate-pool, and email-draft operations. Use browser interaction only when an equivalent API is unavailable.

## Confirm Context

**Default creator discovery is strategy-free.** Read
[references/discovery-console.md](references/discovery-console.md) for every
new creator-search request, including requests made directly in chat.
Use the discovery-request HTTP APIs. Never import server modules, run
`createFinderTask` in scripts, query the business database, modify Strategy
gates, or fall back to the legacy Finder when the new API is unavailable.
Report an API/version/authentication blocker instead. Existing Strategy
records are historical context, not authorization or filters for new work.

When given a **discovery request ID from the OS console**, first read
[references/discovery-console.md](references/discovery-console.md). The saved
request supplies the user's explicit project/product/platform and search
requirements. Execute its claimed workflow and report progress; do not ask
the user to manually advance evidence analysis or candidate generation.
The console is a handoff surface, not an Agent runtime.

Before a write, identify the exact campaign/product and target platform from the user's instruction or saved request. Do not infer them from the newest record or `Default Campaign`. Only an explicitly requested legacy Finder run requires a ready strategy.

## Strategy

When creating or improving a strategy, read [references/strategy.md](references/strategy.md) and [references/strategy-output-schema.md](references/strategy-output-schema.md). Keep product facts, creator personas, scoring, evidence guidance, and Finder handoff grounded in the campaign brief. Publish a strategy only when requested.

## Legacy Video Evidence Finder (explicit legacy requests only)

Do not use this section for new creator discovery. Use the discovery-request
flow above; it has no Strategy prerequisite.

Use exactly one target platform per Finder task:

```text
confirmed campaign and strategy
-> configuration check
-> one-platform Finder task
-> import target-platform videos with creator identity
-> analyze video evidence
-> generate Raw Candidates
-> human review
```

Check configuration:

```http
GET {base_url}/api/settings/health/config
Authorization: Bearer <token>
```

Create a task:

```http
POST {base_url}/api/finder-tasks
Authorization: Bearer <token>
Content-Type: application/json

{
  "strategy_id": 1,
  "target_platform": "instagram",
  "limit": 10
}
```

For high-throughput discovery, shard distinct keyword families across one Ready Strategy instead of duplicating Strategies. Each shard accepts up to 8 keywords; one batch accepts up to 12 shards and runs 1-4 discovery workers. Finder still enforces one target platform and a maximum of 50 qualified creators per shard:

```http
POST {base_url}/api/finder-tasks/batch
Authorization: Bearer <token>
Content-Type: application/json

{
  "strategy_id": 1,
  "target_platform": "instagram",
  "limit_per_shard": 50,
  "concurrency": 3,
  "instagram_pages_per_query": 5,
  "instagram_date_posted": "last-year",
  "keyword_shards": [
    ["budget christmas tree review", "pre lit tree review"],
    ["christmas living room makeover", "holiday home transformation"]
  ]
}
```

Use mutually distinct keyword families to reduce cache overlap. The shared Strategy applies follower and average-view minimum/maximum gates before evidence import and AI analysis. Analyze and generate candidates for successful child task IDs through the normal evidence endpoints; never approve generated Raw Candidates.

Instagram Reel search supports manual pages 1-11 and optional `instagram_date_posted` values `last-hour`, `last-day`, `last-week`, `last-month`, or `last-year`. For long-tail discovery, use 3-5 pages first and increase to 11 only when needed. Each page is cached independently and hard metric gates run while paging so ineligible page-one results do not consume the task's qualified-creator limit.

Import evidence:

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/video-evidence/import
Authorization: Bearer <token>
Content-Type: application/json

{
  "evidence": [{
    "video_url": "https://www.instagram.com/reel/xxxx/",
    "author_profile_url": "https://www.instagram.com/creator/",
    "title": "Relevant product demonstration",
    "author_name": "Creator name",
    "source_query": "discovery query",
    "evidence_reason": "Why this video merits analysis"
  }]
}
```

`video_url` must be a YouTube video/Short, Instagram Reel/Post, or TikTok video matching the task platform. A profile page identifies the creator but is never video evidence; preserve it only as `author_profile_url`.

Analyze and generate:

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/evidence-analysis
Authorization: Bearer <token>

POST {base_url}/api/finder-tasks/{finder_task_id}/generate-candidates-from-evidence
Authorization: Bearer <token>
```

AI may assign zero or more independent evidence signals to each video: `competitor`, `category`, `use_case`, `feature`, and `community`. Generate Raw Candidates only from analyzed video evidence. Never approve Raw Candidates.

## Search Existing KOLs

Search KOL Master for an active campaign:

```http
GET {base_url}/api/agent/campaigns/{campaign_id}/kol-master/search?platform=youtube&min_avg_views_30d=19191&min_median_views_30d=19191&metric_mode=any&exclude_in_campaign=true
Authorization: Bearer <token>
```

`metric_mode=any` means average or median may pass; `all` requires both. Review returned creator context for product fit instead of treating views alone as sufficient.

YouTube searches may use view thresholds and optional `min_followers`.
Instagram and TikTok KOL Master records currently have follower counts but no
platform-specific 30-day view metrics, so search them with `min_followers`:

```http
GET {base_url}/api/agent/campaigns/{campaign_id}/kol-master/search?platform=instagram&min_followers=10000&exclude_in_campaign=true
```

Do not send `min_avg_views_30d` or `min_median_views_30d` for Instagram or
TikTok; the API rejects that combination instead of applying YouTube metrics.

## Add Existing KOLs to Candidate Pool

For a newly discovered creator not yet in KOL Master, call `POST /api/agent/campaigns/{campaign_id}/kol-master/batch-upsert` with `dry_run: true` and `items` containing `client_ref`, `name`, `platform`, `profile_url`, and only verified optional data such as `email`, `followers`, `country_region`, `creator_type`, `audience_fit`, and `notes`. The API matches profile URL first and email second, returns a `customer_id` for duplicates, and never overwrites an existing KOL. After the user confirms the preview, repeat with `dry_run: false` and a unique `idempotency_key`; use returned `customer_id` values in the candidate-pool request.

Always preview first:

```http
POST {base_url}/api/agent/campaigns/{campaign_id}/candidate-pool/batch
Authorization: Bearer <token>
Content-Type: application/json

{
  "dry_run": true,
  "items": [{
    "customer_id": 123,
    "cooperation_platforms": ["youtube"],
    "priority": "t2",
    "recommendation_note": "Evidence-backed product fit"
  }]
}
```

After the user confirms the preview, set `dry_run` to false and add a unique `idempotency_key`. This permission applies only to existing KOL Master records and does not approve Raw Candidates.

## Write Agent Email Drafts

Use the project brief, verified KOL context, and user-provided commercial terms. Write each message personally. Do not let the system AI rewrite the result.

Validate first:

```http
POST {base_url}/api/agent/campaigns/{campaign_id}/email-drafts/batch-upsert
Authorization: Bearer <token>
Content-Type: application/json

{
  "validate_only": true,
  "kind": "first_touch",
  "drafts": [{
    "customer_id": 123,
    "subject": "Collaboration opportunity",
    "body_text": "Agent-written message"
  }]
}
```

After validation, set `validate_only` to false and add a unique `idempotency_key`. The API may create or update only `pending_review` drafts for KOLs already in the campaign candidate pool.

Verify the review queue:

```http
GET {base_url}/api/agent/campaigns/{campaign_id}/email-drafts?kind=first_touch&status=pending_review
Authorization: Bearer <token>
```

Report created, updated, skipped, and rejected items. Never approve, send, reject, or delete email through Agent automation.

## Hard Boundaries

- Never expose tokens or write directly to the database.
- Never mix platforms inside one Finder task.
- Never fabricate evidence, metrics, identity, contact data, country, price, or engagement.
- Never create or approve Raw Candidates without analyzed video evidence and human review.
- Add existing KOL Master records to a campaign only after preview and user confirmation.
- Newly discovered KOLs may enter production only through the previewed, idempotent Agent API; never use SQL imports.
- Email automation stops at `pending_review`; approval and sending remain human actions.
- If access or configuration is blocked, report the blocker instead of inventing results.

## Final Report

Summarize campaign and task IDs, searches performed, evidence imported and analyzed, candidates generated or added, drafts validated or written, review-queue verification, skipped items, blockers, and assumptions. Never include credentials.
