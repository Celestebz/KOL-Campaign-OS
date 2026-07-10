---
name: kol-campaign-os-agent
description: Use when an external agent must create or improve a KOL Campaign OS strategy, publish it when requested, and run one-platform video-evidence creator discovery end to end.
---

# KOL Campaign OS External Agent

## Default Workflow

Use HTTP APIs for the complete business flow:

```text
confirmed campaign brief
-> structured KOL Strategy
-> mark Strategy ready when requested
-> one-platform Video Evidence Finder
-> system-generated Raw Candidates
-> human approval in UI
```

## Mandatory Context Gate

Before any Finder create/import/analyze/generate call, confirm:

- product/project/campaign
- one target platform: `youtube`, `instagram`, or `tiktok`
- strategy, or permission to create/complete one first

Do not infer context from recent records, previous tasks, candidate pools, UI state, or `Default Campaign`. If multiple records fit, present concise choices and ask the user.

## Strategy Flow

If no ready strategy exists:

1. Inspect campaigns with `GET {base_url}/api/campaigns`.
2. Confirm the campaign or create one from an adequate brief.
3. Create or improve a strategy containing product context, creator persona, scoring weights, and Finder handoff.
4. Put discovery keywords and the five evidence-label definitions inside `finder_handoff`.
5. Mark the strategy ready only when the user wants Finder to run.

The five evidence labels are `competitor`, `category`, `use_case`, `feature`, and `community`. They describe what analyzed video content proves.

## Finder Flow

### 1. Check configuration

```http
GET {base_url}/api/settings/health/config
```

If `data.ready` is false, stop and report missing AI or target-platform provider settings.

### 2. Create or confirm one task

Reuse a task only after the user confirms its exact campaign/product, target platform, and strategy.

```http
POST {base_url}/api/finder-tasks
Content-Type: application/json

{
  "strategy_id": 1,
  "target_platform": "instagram",
  "limit": 10
}
```

The system selects the configured discovery provider. The agent does not choose provider orchestration.

### 3. Discover and import videos

The task platform, evidence video platform, and creator profile platform must match.

Accepted videos:

- YouTube videos, Shorts, or `youtu.be` links
- Instagram Reels or Posts
- TikTok video links

Profile pages are identity only. Put them in `author_profile_url`, never `video_url`.

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/video-evidence/import
Content-Type: application/json

{
  "evidence": [
    {
      "video_url": "https://www.instagram.com/reel/xxxx/",
      "author_profile_url": "https://www.instagram.com/creator/",
      "title": "Relevant product demonstration",
      "author_name": "Creator name",
      "source_query": "vocal processor live performance",
      "evidence_reason": "Why this video merits AI analysis"
    }
  ]
}
```

If only a profile is found, keep it in `profile_leads_needing_video_evidence` until a relevant video is found.

### 4. Analyze evidence

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/evidence-analysis
```

AI assigns zero or more evidence signals after seeing each video:

- `competitor`
- `category`
- `use_case`
- `feature`
- `community`

A video may match multiple evidence signals. The labels are independent evidence interpretations, not ordered discovery work.

The analysis also evaluates creator profile quality, platform match, follower/view constraints, market/language, risk, and candidate priority.

### 5. Generate candidates

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/generate-candidates-from-evidence
```

The system aggregates analyzed evidence by author and creates one Raw Candidate per creator. Never create candidates from unprocessed search results. Do not call approval APIs.

## Required Inputs

Defaults:

- `base_url`: `http://localhost:5001`
- persistence: MySQL through app APIs only

Collect or confirm:

- campaign/product/brand
- market and language
- one target platform
- ready strategy
- desired video limit
- creator tier or follower/view constraints when important
- supplied competitors and exclusions

Never expose API tokens.

## Final Report

```json
{
  "campaign_id": 0,
  "strategy_id": 0,
  "finder_task_id": 0,
  "target_platform": "instagram",
  "video_evidence_imported": 0,
  "video_evidence_failed": 0,
  "evidence_scored": 0,
  "raw_candidates_generated": 0,
  "profile_leads_needing_video_evidence": [],
  "blocked_reasons": [],
  "assumptions": []
}
```

## Hard Boundaries

- Do not approve candidates into KOL Master or Campaign KOL.
- Do not write directly to MySQL or use SQLite.
- Do not create candidates from profile search or unprocessed videos.
- Do not mix platforms within one Finder task.
- Do not put a profile page in `video_url`.
- Preserve `author_profile_url` whenever available.
- Do not invent evidence, metrics, identity, contact data, country, price, or engagement.
- If platform/API access is blocked, report the blocker instead of fabricating results.

Every Raw Candidate must originate from analyzed video evidence and remain subject to human review.