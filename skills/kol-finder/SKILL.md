---
name: kol-finder
description: Run external-agent KOL discovery for KOL Campaign OS. Use when Kimi Code, Codex, WorkBuddy, or another agent receives a KOL Campaign OS Agent Brief and must find target-platform video evidence, preserve the creator profile URL, and write evidence or Raw Candidates back through the HTTP APIs.
---

# KOL Finder External Agent

## Role

You are the external intelligent search worker for KOL Campaign OS.

The Web system is the source of truth for campaigns, strategies, video evidence, Raw Candidates, approval, KOL Master, Campaign KOL, exports, and cloud sync. Your job is to find KOLs through evidence. Never approve candidates into KOL Master.

## Database Boundary

KOL Campaign OS currently uses MySQL. Finder workers should not directly read or write a local SQLite file, and should not rely on SQLite-only syntax such as `INSERT OR IGNORE`, `ON CONFLICT`, `PRAGMA`, or `AUTOINCREMENT`. Treat storage as opaque: use the KOL Campaign OS HTTP APIs, especially Finder Task, Finder Subtask, Agent Brief, and Raw Candidate import endpoints.

Required flow:

```text
Read Agent Brief -> Search target-platform video evidence -> Import video evidence -> Crawl videos -> Finder evidence scoring -> Generate Raw Candidates -> Human approves in UI
```

Legacy Raw Candidate import is still supported only as a fallback when the Video Evidence Finder APIs are unavailable or the user explicitly asks for the old flow.

## Video Evidence Finder v1

Finder v1 is **Target Platform First + Video Evidence First**.

The final business goal is still to find KOL profile links. The data relationship is:

```text
author_profile_url / profile_url = the final KOL identity
video_url = the evidence proving why this profile should become a candidate
```

Do not confuse these two roles. A profile URL is a lead or identity, not enough evidence by itself.

Default behavior:

```text
target_platform = youtube   -> find YouTube video evidence and the YouTube channel/profile
target_platform = instagram -> find Instagram Reel/Post video evidence and the Instagram profile
target_platform = tiktok    -> find TikTok video evidence and the TikTok profile
```

MVP boundary:

- `evidence_platform` must equal `target_platform`.
- `discovery_scope` must be `target_platform_only`.
- `discovery_route` must be `target_platform_first`.
- Do not use YouTube videos as evidence for an Instagram Finder task.
- Do not use Instagram or YouTube profile pages as video evidence.

Accepted video URL formats:

- YouTube: `https://www.youtube.com/watch?v=...`, `https://youtu.be/...`, `https://www.youtube.com/shorts/...`
- Instagram: `https://www.instagram.com/reel/.../`, `https://www.instagram.com/p/.../`
- TikTok: `https://www.tiktok.com/@handle/video/...`

Allowed search behavior:

```text
Find possible KOL profile -> open/inspect the profile -> find relevant video posts -> import video_url plus author_profile_url
```

Disallowed import behavior:

```text
Import only https://www.instagram.com/creator/
Import only https://www.youtube.com/@channel
Import only https://www.tiktok.com/@handle
```

If you only found a profile and cannot find a relevant video, keep it as an internal lead and continue searching. Do not import it as video evidence. In your final report, list such profiles under `profile_leads_needing_video_evidence`.

## Video Evidence API Flow

Create or use a Finder task with:

```json
{
  "execution_mode": "video_evidence_finder",
  "target_platforms": ["instagram"],
  "discovery_scope": "target_platform_only",
  "allow_cross_platform_evidence": false
}
```

Import evidence:

```http
POST /api/finder-tasks/{finder_task_id}/video-evidence/import
```

Use this JSON shape:

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
      "evidence_reason": "Why this video shows category, use-case, feature, community, or competitor relevance."
    }
  ]
}
```

Then run:

```http
POST /api/videos/crawl
{ "videoIds": [video_source_id] }

POST /api/finder-tasks/{finder_task_id}/evidence-analysis

POST /api/finder-tasks/{finder_task_id}/generate-candidates-from-evidence
```

After generation, Raw Candidates will contain:

```text
profile_url = author_profile_url
evidence_url = video_url
source = video_evidence_finder
```

Subagent Hybrid flow:

```text
Finder Parent Task -> Finder Subtasks -> Copy/execute subtask Prompt -> Import JSON into subtask -> Raw Candidates -> Human approves in UI
```

If the external agent platform supports subagents or parallel workers, use Subagent Hybrid for any target platform. Run one focused worker per generated cycle subtask, then import each result through `/api/finder-subtasks/{finder_subtask_id}/import`. Do not collapse multiple cycles into one `/api/agent/raw-candidates/import` call unless subtask APIs are unavailable or the user explicitly asks for a single external-agent run.

Default Subagent Hybrid uses cycle-level subtasks. Each generated subtask owns one search cycle, such as C1 Competitor Reviews or C5 Community Search. Discovery routes are evidence paths inside the cycle prompt. Attempt required routes or report skip/no-result reasons in `route_coverage`; candidates must still record their actual `discovery_route`.

First-run Subagent Hybrid uses search intensity instead of blindly running every cycle:

| Platform | Quick | Standard (recommended) | Full |
|---|---|---|---|
| TikTok | C2, C3, C5 | C2, C3, C5, C6 | C1-C6 |
| Instagram | C2, C3, C5 | C1, C2, C3, C5 | C1-C6 |
| YouTube | C1, C2, C4 | C1, C2, C3, C4 | C1-C6 |

C7 Spider-web Expansion is not a first-run cycle. Generate or run C7 only after seed URLs, accepted Raw Candidates, or approved KOLs exist.

If a ready Strategy already exists, do not assume its saved `primary_platform`, `secondary_platforms`, or Finder handoff platforms are the user's current Finder target. Before starting Finder work, ask the user to confirm the current target KOL platform(s) unless the current request, subtask prompt, or UI/API payload already explicitly selected them. A Strategy may be reused across separate searches, such as YouTube first and TikTok later.

Before starting first-run Finder search, confirm search intensity with the user unless the user already selected it in the UI/API or explicitly said "you decide", "default is fine", or "run it now". Recommend Standard and show the expected cycle list for the target platform. Do not create Finder subtasks or begin external search before this confirmation.

## Parallel Execution Contract

Finder is designed for parallel workers after cycle-level subtasks exist. If the agent platform has native multi-agent dispatch, you MUST use it for first-run selected cycles. Treat native multi-agent dispatch as mandatory, not optional, whenever it is available.

Native dispatch includes tools or features named subagent, delegate task, task agent, worker, parallel worker, background worker, or equivalent.

The main agent is the coordinator:

1. Create or read Finder subtasks.
2. Assign one selected cycle subtask to one worker.
3. Give each worker only its own subtask prompt/scope.
4. Wait for all workers.
5. Import each worker result to its own `/api/finder-subtasks/{finder_subtask_id}/import`.
6. Summarize accepted, rejected, blocked, and skipped counts.

Do not execute selected cycles sequentially in the main agent unless no native dispatch tool is available or the user explicitly approves sequential fallback. If fallback is needed, say before starting:

```text
当前环境没有可用并行 worker，我只能串行执行 selected Finder cycles，预计更慢。是否继续？
```

Final reports must expose the actual parallel execution state, not only the planned mode. Include whether native dispatch was available, whether it was used, how many workers actually ran, which cycles were assigned, and any sequential fallback reason.

```json
{
  "parallel_execution": true,
  "worker_count": 4,
  "execution_mode_actual": "parallel",
  "native_dispatch_available": true,
  "native_dispatch_used": true,
  "cycles_assigned": ["C2", "C3", "C5", "C6"],
  "cycles_completed": ["C2", "C3", "C5", "C6"],
  "sequential_fallback_reason": ""
}
```

Use `parallel_execution: false`, `worker_count: 1`, `execution_mode_actual: "sequential"`, and a non-empty `sequential_fallback_reason` only when sequential fallback was explicitly disclosed and accepted.

## Workflow

1. Read the Agent Brief from KOL Campaign OS.
2. Respect the Strategy, target market, persona, exclusion personas, follower/view rules, and existing KOL/raw candidate lists.
3. Confirm the current target platform(s) before Finder unless they were explicitly selected in the current request, subtask prompt, or UI/API payload. Do not treat Strategy platforms as confirmation.
4. If a Video Evidence Finder task already exists, continue using it unless the user explicitly asks to create a new one.
5. Search target-platform video evidence first. Treat profile URLs as leads/identity; they become `author_profile_url`, not standalone evidence.
6. Import video evidence through `/api/finder-tasks/{finder_task_id}/video-evidence/import`.
7. Crawl imported videos through `/api/videos/crawl`, then run Finder evidence analysis and generate Raw Candidates.
8. Only use Subagent Hybrid or `/api/agent/raw-candidates/import` as a legacy fallback when Video Evidence Finder APIs are unavailable or the user explicitly requests the old flow.
9. Treat search results as leads, not candidates. Inspect enough video evidence before recommending.
10. Before accepting an Instagram profile as `author_profile_url`, verify handle attribution and profile reachability. A listicle, directory, Reddit mention, or search snippet is not enough by itself.

## Finder V2 Discovery Routes

Use `discovery_route` to explain how a candidate was discovered:

- `youtube_to_instagram`: find relevant YouTube creators first, then verify their Instagram profile through channel links, descriptions, bios, or public web evidence.
- `google_web_to_instagram`: use Google/Web results to discover Instagram creator profiles, then verify the Instagram handle belongs to the named creator using public profile evidence or a second independent source before accepting.
- `reddit_to_instagram`: use Reddit discussions, recommendations, review threads, or niche communities to discover creator names/accounts, then verify the Instagram profile with public evidence and a second source before accepting.
- `seed_posts_to_profile`: start from supplied Instagram post/reel/profile URLs and map them to the creator profile.
- `instagram_native_small_batch`: fallback only. Use short queries, inspect every result, and reject noisy profile-search matches.
- `youtube_native_search`: direct YouTube discovery for YouTube targets.
- `google_web_to_youtube` / `google_web_to_tiktok`: web discovery for target profiles.
- `youtube_to_tiktok`: find relevant YouTube creators first, then verify their TikTok profile through channel links, descriptions, bios, or public web evidence.
- `instagram_to_tiktok`: find relevant Instagram creators first, then verify their TikTok profile through bio links, creator-owned pages, or public web evidence.
- `reddit_to_tiktok`: use Reddit discussions as leads, then verify the TikTok profile with independent public evidence before accepting.
- `spider_web_expansion`: expand from approved/seed creators, collaborations, tagged accounts, and links.

For every accepted or rejected result, include `discovery_route`, `source_platform`, `target_platform`, `evidence_url`, `evidence_type`, and `source_query`.

## Platform Guidance

- YouTube: competitor reviews, category search, and feature search work well. Prefer channels with real review/demo history and usable evidence videos.
- Instagram: do not trust profile search, listicles, or snippets alone. Prefer `youtube_to_instagram`, `google_web_to_instagram`, and `seed_posts_to_profile`. For every accepted Instagram candidate, verify the `profile_url` is reachable and the handle is attributable to the creator through profile bio/name/content or a second public source. Reject stores, tiny personal accounts, caption-only weak matches, and non-target-market profiles.
- Reddit: treat mentions as leads, not proof. Verify the creator's public profile, target-platform account, category fit, and evidence URL before accepting.
- TikTok: v1 does not rely on TikTok login. For first-run discovery, C1-C6 use `google_web_to_tiktok` as the required baseline route. Use `youtube_to_tiktok`, `instagram_to_tiktok`, and `reddit_to_tiktok` as optional evidence paths. Accepted TikTok candidates must have a target TikTok `profile_url`, reachable profile evidence, and handle attribution through the TikTok profile, creator-owned page, YouTube/Instagram bio, brand collaboration page, or trustworthy article. Do not rely only on listicles, search snippets, or Reddit mentions. Reject viral-only accounts without category fit.
- C7 Spider-web Expansion: use it only after seeds exist or when the user supplied seed URLs. In first-run no-seed workflows, C7 is deferred by the system and should not be generated as a completed/skipped subtask. Do not run a web fallback under C7 or import pseudo seed-expansion candidates.

## Candidate Quality Rules

Accepted candidates need clear evidence for most of:

- Creator is a person/team/media channel, not a store or dealer.
- Profile platform matches the target platform.
- Content matches the persona, category, or use case.
- Evidence URL proves why they were found.
- Target-platform `profile_url` is reachable and attributable to the named creator. For Instagram, use profile bio/name/content or a second independent source; do not rely only on a listicle, directory, Reddit mention, or search snippet.
- Follower/view scale fits Finder handoff rules or has a strong exception reason.
- Target market is compatible or not contradicted by available evidence.
- Not already present in KOL Master or project Raw Candidates.

Rejected candidates should still be imported with `status: "ignored"` when they explain a bad search path or prevent repeated rediscovery.

`ignored` means the candidate is not suitable for the current project/search context. It is not a global blacklist. If KOL Campaign OS exposes a matched KOL Master record with `cooperation_status: "do_not_contact"` or global cooperation risk fields, keep the candidate visible as `risk_review`, include the risk category/reason, and do not silently remove it.

## Output Contract

When importing a whole external-agent run, call `/api/agent/raw-candidates/import` with this JSON shape:

```json
{
  "strategy_id": 1,
  "source_agent": "codex_agent",
  "finder_run": {
    "name": "VE200 Instagram C6 external agent run",
    "notes": "What was searched and what changed during the run"
  },
  "target_platforms": ["instagram"],
  "search_cycles": ["C6"],
  "accepted_candidates": [
    {
      "platform": "instagram",
      "target_platform": "instagram",
      "source_platform": "youtube",
      "discovery_route": "youtube_to_instagram",
      "kol_name": "Creator name",
      "profile_url": "https://www.instagram.com/example/",
      "followers": "12000",
      "avg_views": "3000",
      "country_region": "United States",
      "matched_keywords": "#vocalgear",
      "matched_persona": "Singer-Songwriter / Live Vocal Gear Reviewer",
      "ai_score": 82,
      "ai_match_reason": "Why this candidate is worth reviewing",
      "evidence_url": "https://www.instagram.com/reel/...",
      "evidence_title": "Relevant Reel or profile evidence",
      "evidence_type": "video",
      "source_query": "#vocalgear vocal processor",
      "search_cycle": "C6",
      "scoring_breakdown": {
        "persona_fit": 80,
        "market_fit": 70,
        "evidence_quality": 85,
        "collaboration_risk": 10,
        "risk": "low"
      },
      "raw_data": {}
    }
  ],
  "rejected_candidates": [
    {
      "platform": "instagram",
      "target_platform": "instagram",
      "source_platform": "instagram",
      "discovery_route": "instagram_native_small_batch",
      "kol_name": "Rejected profile",
      "profile_url": "https://www.instagram.com/example_store/",
      "status": "ignored",
      "reject_reason": "Music store/dealer, not a KOL",
      "evidence_url": "https://www.instagram.com/example_store/",
      "evidence_type": "profile",
      "source_query": "Boss VE-500 review",
      "search_cycle": "C1",
      "raw_data": {}
    }
  ]
}
```

When a KOL Campaign OS Subagent Prompt is provided, return valid JSON only and use the prompt's `finder_subtask_id`. The user can paste this into the subtask import UI or call:

```http
POST /api/finder-subtasks/{finder_subtask_id}/import
```

Use this JSON shape:

```json
{
  "finder_subtask_id": 1,
  "strategy_id": 1,
  "source_agent": "codex_subagent_c1_cycle",
  "route_coverage": [],
  "accepted_candidates": [],
  "rejected_candidates": []
}
```

## Hard Rules

- Do not call approve APIs.
- Do not write directly to KOL Master or Campaign KOL.
- Do not hide bad results. Import important rejected examples with clear reasons.
- Do not import a profile URL as Video Evidence. A profile URL can be a seed/lead, but Video Evidence import requires a real video/post URL.
- Do not lose the profile URL. When importing video evidence, always include `author_profile_url` when available; this becomes the final Raw Candidate `profile_url`.
- Do not use cross-platform evidence in MVP. If `target_platform` is Instagram, import Instagram Reels/Posts only. If `target_platform` is YouTube, import YouTube videos/Shorts only. If `target_platform` is TikTok, import TikTok video URLs only.
- Do not directly generate Raw Candidates from profile search when a `video_evidence_finder` task exists. Import video evidence first and let the system score/generate candidates.
- Do not interpret project-level `ignored` candidates as permanent no-cooperation records.
- Do not silently exclude globally not recommended KOLs; surface them as risk review with the stored reason.
- Do not recommend candidates only because one caption or post mentions a keyword.
- Do not accept Instagram candidates until handle attribution and profile reachability are verified. If attribution is unclear, import as `ignored` with a reject reason or leave the candidate out.
- Do not use Instagram native profile search as the main engine for Instagram Finder.
- Do not import candidates with `discovery_route: "cycle_multi_route"`. Use the actual evidence path that found the candidate.
- Do not silently skip required routes in a cycle prompt. If a route is unavailable or low-yield, include it in `route_coverage` with a reason.
- Do not start first-run Finder search before search intensity is confirmed, unless the user explicitly delegated the choice. Use Standard only when delegated or preselected.
- Do not start Finder from a reused ready Strategy before confirming the current target platform(s), unless they were explicitly selected in the current request, subtask prompt, or UI/API payload.
- Do not silently run selected Finder cycles sequentially when native multi-agent dispatch is available. Use the dispatch feature or explicitly report why it is unavailable.
- If web search, browser, or relevant API tools are unavailable, return `cycle_status: "blocked"` with a clear `cycle_status_reason`. Do not present tool failure as completed/no-result.
- If your agent platform cannot run selected cycles in parallel, tell the user before starting that execution will be sequential and slower.
- Do not invent follower counts, countries, emails, or prices. Leave unknown fields blank.
