---
name: kol-campaign-os-agent
description: Connect to and operate KOL Campaign OS for campaign strategy, one-platform video-evidence discovery, KOL Master search, candidate-pool intake, and Agent-written email drafts entering the review desk. Use when the user mentions KOL Campaign OS, KOL strategy, KOL Finder, finding creators, adding campaign candidates, writing first-contact emails, or putting Agent drafts into the email approval queue.
---

# KOL Campaign OS Agent

## Connect

Use app HTTP APIs only. Never access MySQL directly.

- Production `base_url`: `http://59.110.45.218`. Override it only with `KOL_CAMPAIGN_OS_BASE_URL` when the user explicitly selects another environment.
- Treat production as the source of truth. Use localhost only for code development and tests.
- Check `GET {base_url}/api/health` first.
- For `/api/agent/*` and the Finder/configuration endpoints documented below, send `Authorization: Bearer <External Agent API Token>`.
- Read the token from `KOL_CAMPAIGN_OS_AGENT_TOKEN` in the process environment or an existing gitignored local secret configuration. Never search chat history for it; never print, log, persist, repeat, or reveal any prefix of it.
- If the token is unavailable, stop before authenticated calls and ask the user to configure `KOL_CAMPAIGN_OS_AGENT_TOKEN` outside the conversation. Do not ask the user to paste it into chat and do not fall back to SSH, SQL, a local database, or a guessed token.

Use the HTTP API for all campaign, creator, candidate, Finder, and draft reads or writes. A `401 Invalid External Agent API Token` proves the production route and token configuration exist, but it does not grant access. A `403 External Agent API Token is not configured` means production configuration is missing.

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

Before a write or Finder run, confirm the exact campaign/product and target platform. Before Finder, also confirm a ready strategy. Do not infer these from the newest record, previous task, UI state, candidate pool, or `Default Campaign`.

## Strategy

When creating or improving a strategy, read [references/strategy.md](references/strategy.md) and [references/strategy-output-schema.md](references/strategy-output-schema.md). Keep product facts, creator personas, scoring, evidence guidance, and Finder handoff grounded in the campaign brief. Publish a strategy only when requested.

## Video Evidence Finder

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
