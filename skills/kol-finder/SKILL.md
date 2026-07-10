---
name: kol-finder
description: Use when an external agent must find KOL profile links in KOL Campaign OS by collecting and analyzing video evidence on one explicitly confirmed target platform.
---

# KOL Finder External Agent

## Core Rule

Finder discovers creators from target-platform videos. A profile link identifies the creator; a video proves why that creator belongs in the candidate pool.

```text
author_profile_url = KOL identity
video_url = evidence
```

A profile URL alone is not evidence.

## Mandatory Confirmation

Before creating, reusing, or continuing a Finder task, confirm:

- product/project/campaign
- one target platform: `youtube`, `instagram`, or `tiktok`
- ready strategy, or permission to create/complete it first

Do not infer these values from the newest database record, UI state, previous task, candidate pool, or `Default Campaign`. If several records fit, show concise options and ask the user to choose.

## Required Flow

```text
confirm context
-> check configuration
-> create or confirm one-platform Finder task
-> find videos on that platform
-> import video_url plus author_profile_url
-> analyze evidence
-> generate Raw Candidates from analyzed evidence
-> human reviews candidates in UI
```

The system selects discovery providers from Settings. The agent does not choose execution modes, routes, or search passes.

## Platform Boundary

The task and every imported video use the same platform:

- YouTube task: YouTube videos, Shorts, and channel/profile identity.
- Instagram task: Instagram Reels/Posts and Instagram profile identity.
- TikTok task: TikTok videos and TikTok profile identity.

Accepted `video_url` forms:

- `https://www.youtube.com/watch?v=...`
- `https://www.youtube.com/shorts/...`
- `https://youtu.be/...`
- `https://www.instagram.com/reel/.../`
- `https://www.instagram.com/p/.../`
- `https://www.tiktok.com/@handle/video/...`

Profile pages belong only in `author_profile_url`. If a profile has no relevant video, keep it in `profile_leads_needing_video_evidence` and do not import it.

## Pre-flight

```http
GET {base_url}/api/settings/health/config
```

If `data.ready` is false, stop and tell the user which AI or platform provider setting is missing.

## Create Or Reuse A Task

Reuse a task only after the user confirms its exact campaign/product, target platform, and strategy. Otherwise create:

```http
POST {base_url}/api/finder-tasks
Content-Type: application/json

{
  "strategy_id": 1,
  "target_platform": "instagram",
  "limit": 10
}
```

The request represents one target platform and one video discovery run.

## Import Video Evidence

Discovery may use the configured provider, web search, or platform search, but imported results must be valid videos from the task platform.

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
      "evidence_reason": "Why this video is relevant enough for AI analysis"
    }
  ]
}
```

Required: `video_url`. Preserve `author_profile_url` whenever available. Never invent creator metrics or contact data.

## Evidence Signals

The agent does not pre-classify imported videos. After analysis, AI assigns zero or more evidence signals:

- `competitor`
- `category`
- `use_case`
- `feature`
- `community`

A video may match multiple evidence signals. These labels describe what the video proves; they are not separate searches.

## Analyze And Generate

Import automatically writes or reuses canonical `video_sources` and snapshots. Then call:

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/evidence-analysis
```

Evidence analysis evaluates video relevance, the five labels, creator profile quality, hard filters, risk, and candidate priority.

Generate candidates only through:

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/generate-candidates-from-evidence
```

The system aggregates analyzed videos by author and creates one Raw Candidate per creator. Score ranks eligible candidates; human review makes the approval decision.

## Final Report

```json
{
  "finder_task_id": 1,
  "target_platform": "instagram",
  "video_evidence_imported": 0,
  "video_evidence_failed": 0,
  "evidence_scored": 0,
  "raw_candidates_generated": 0,
  "profile_leads_needing_video_evidence": [],
  "blocked_reasons": []
}
```

## Hard Boundaries

- Do not call approval APIs or write to KOL Master/Campaign KOL.
- Do not write directly to MySQL or use SQLite.
- Do not create candidates from unprocessed search results.
- Do not use evidence from a different platform.
- Do not put profile pages in `video_url`.
- Do not lose `author_profile_url`.
- Do not fabricate evidence, metrics, identity, contact data, market, or engagement.
- If access is blocked, report the blocker and preserve uncertainty.

Every candidate must originate from analyzed video evidence in the system.