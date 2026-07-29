---
name: kol-campaign-os-agent
description: Connect to and operate KOL Campaign OS for campaign strategy, one-platform video-evidence discovery, KOL Master search, candidate-pool intake, and Agent-written email drafts entering the review desk. Use when the user mentions KOL Campaign OS, KOL strategy, KOL Finder, finding creators, adding campaign candidates, writing first-contact emails, or putting Agent drafts into the email approval queue.
---

# KOL Campaign OS Agent

## Connect

Use app HTTP APIs only. Never access MySQL directly.

- Default `base_url`: `http://localhost:5001`
- Check `GET {base_url}/api/health` first.
- For `/api/agent/*` and the Finder/configuration endpoints documented below, send `Authorization: Bearer <External Agent API Token>`.
- Obtain a missing base URL or token from the user's secure configuration. Never print, persist, or repeat the token.

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

## Add Existing KOLs to Candidate Pool

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
- Email automation stops at `pending_review`; approval and sending remain human actions.
- If access or configuration is blocked, report the blocker instead of inventing results.

## Final Report

Summarize campaign and task IDs, searches performed, evidence imported and analyzed, candidates generated or added, drafts validated or written, review-queue verification, skipped items, blockers, and assumptions. Never include credentials.
