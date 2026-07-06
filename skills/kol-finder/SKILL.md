---
name: kol-finder
description: Run KOL Campaign OS Finder with the new Target Platform First + Video Evidence First workflow. Use when Kimi Code, Codex, WorkBuddy, or another agent must find KOL profile links by first importing target-platform video evidence.
---

# KOL Finder External Agent

## Core Rule

Use **Video Evidence Finder v1** only.

The final business goal is to find KOL profile links, but Finder must first collect video evidence:

```text
author_profile_url = final KOL identity / profile link
video_url = evidence proving why this creator should become a candidate
```

Do not import a profile URL by itself as evidence.

## Required Flow

```text
Read Agent Brief
-> confirm target platform if not already selected
-> use or create video_evidence_finder task
-> search target-platform video evidence
-> import video_url + author_profile_url
-> crawl videos
-> run evidence analysis
-> generate Raw Candidates from evidence
-> human approves in UI
```

Do not directly write Raw Candidates from search results.

## MVP Boundary

Finder v1 is target-platform-only:

```text
target_platform = evidence_platform
discovery_scope = target_platform_only
discovery_route = target_platform_first
allow_cross_platform_evidence = false
```

Platform rules:

- `target_platform = youtube`: find YouTube videos/Shorts and the YouTube channel/profile.
- `target_platform = instagram`: find Instagram Reels/Posts and the Instagram profile.
- `target_platform = tiktok`: find TikTok videos and the TikTok profile.

Do not use YouTube videos as evidence for Instagram Finder.
Do not use Instagram profile pages as video evidence.
Do not use YouTube channel pages as video evidence.
Do not use TikTok profile pages as video evidence.

## Accepted Video URL Formats

Use only these as `video_url`:

- YouTube: `https://www.youtube.com/watch?v=...`
- YouTube Shorts: `https://www.youtube.com/shorts/...`
- YouTube short URL: `https://youtu.be/...`
- Instagram Reel: `https://www.instagram.com/reel/.../`
- Instagram Post: `https://www.instagram.com/p/.../`
- TikTok video: `https://www.tiktok.com/@handle/video/...`

Profile URLs are allowed only as `author_profile_url`.

## Profile Leads

It is okay to discover a possible KOL profile first.

Correct behavior:

```text
Find possible profile
-> open or inspect profile
-> find relevant Reel/Post/video
-> import video_url with author_profile_url
```

If you only found a profile and no relevant video:

```text
Do not import it.
Keep it as profile_leads_needing_video_evidence in your final report.
Continue searching for video evidence.
```

## Create Or Use Finder Task

If a Video Evidence Finder task already exists, continue using it unless the user explicitly asks to create a new task.

Create task:

```http
POST /api/finder-tasks
Content-Type: application/json

{
  "strategy_id": 1,
  "execution_mode": "video_evidence_finder",
  "target_platforms": ["instagram"],
  "discovery_scope": "target_platform_only",
  "allow_cross_platform_evidence": false,
  "limit_per_platform": 10
}
```

Do not ask for Quick / Standard / Full cycle intensity for Video Evidence Finder v1. Those old Cycle settings do not control the new default workflow.

## Import Video Evidence

```http
POST /api/finder-tasks/{finder_task_id}/video-evidence/import
Content-Type: application/json
```

Payload:

```json
{
  "videos": [
    {
      "video_url": "https://www.instagram.com/reel/xxxx/",
      "target_platform": "instagram",
      "evidence_platform": "instagram",
      "source_signal": "use_case",
      "source_query": "vocal processor live performance",
      "title": "optional visible title",
      "author_name": "creator handle or display name",
      "author_profile_url": "https://www.instagram.com/creator/",
      "evidence_reason": "This video shows a relevant vocal setup, product use case, category fit, or creator fit."
    }
  ]
}
```

Required fields:

- `video_url`
- `target_platform`
- `evidence_platform`
- `author_name`
- `author_profile_url` when available
- `source_signal`
- `source_query`
- `evidence_reason`

Recommended `source_signal` values:

- `category`
- `use_case`
- `native_platform`
- `competitor`
- `feature`
- `community`
- `seed_graph`

Default first-pass signals:

```text
category
use_case
native_platform
```

These are signal labels, not mandatory sequential cycles.

## Run System Analysis

After importing video evidence, run:

```http
POST /api/videos/crawl
Content-Type: application/json

{ "videoIds": [123] }
```

Then:

```http
POST /api/finder-tasks/{finder_task_id}/evidence-analysis
```

Then:

```http
POST /api/finder-tasks/{finder_task_id}/generate-candidates-from-evidence
```

`videoIds` are the `video_source_id` values returned by the evidence import result.

## Output Report

At the end, report:

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

## Hard Rules

- Do not call approve APIs.
- Do not write directly to KOL Master or Campaign KOL.
- Do not directly import Raw Candidates from search results.
- Do not ask the user to choose old Cycle / Route / Subagent Hybrid settings for Video Evidence Finder v1.
- Do not use `youtube_to_instagram`, `google_web_to_instagram`, `reddit_to_instagram`, or other cross-platform routes in the default v1 workflow.
- Do not import `discovery_route: "cycle_multi_route"`.
- Do not import a profile URL as `video_url`.
- Do not drop `author_profile_url`; it is the final profile link the user needs.
- Do not invent follower counts, views, emails, country, price, or engagement.
- If web/browser/API access is blocked, report the blocker clearly. Do not fabricate video evidence.
- If a field is unknown, leave it blank and explain uncertainty in `evidence_reason`.
