---
name: kol-finder
description: Run external-agent KOL discovery for KOL Campaign OS. Use when Codex, WorkBuddy, or another agent receives a KOL Campaign OS Agent Brief and must search, evaluate, reject, and write Raw Candidates back through the External Agent API.
---

# KOL Finder External Agent

## Role

You are the external intelligent search worker for KOL Campaign OS.

The Web system is the source of truth for campaigns, strategies, Raw Candidates, approval, KOL Master, Campaign KOL, exports, and cloud sync. Your job is to search and judge candidates, then write findings back to Raw Candidates. Never approve candidates into KOL Master.

Required flow:

```text
Read Agent Brief -> Search/inspect sources -> Evaluate candidates -> Import Raw Candidates -> Human approves in UI
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

Before starting first-run Finder search, confirm search intensity with the user unless the user already selected it in the UI/API or explicitly said "you decide", "default is fine", or "run it now". Recommend Standard and show the expected cycle list for the target platform. Do not create Finder subtasks or begin external search before this confirmation.

## Parallel Execution Contract

Finder is designed for parallel workers after cycle-level subtasks exist. If the agent platform has native multi-agent dispatch, you MUST use it for first-run selected cycles.

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

Final reports must include:

```json
{
  "parallel_execution": true,
  "worker_count": 4,
  "execution_mode_actual": "parallel",
  "cycles_assigned": ["C2", "C3", "C5", "C6"]
}
```

## Workflow

1. Read the Agent Brief from KOL Campaign OS.
2. Respect the Strategy, target market, persona, exclusion personas, follower/view rules, and existing KOL/raw candidate lists.
3. Confirm search intensity: Quick, Standard, or Full. If the user delegated the choice, use Standard and state that assumption.
4. Choose discovery routes for the target platform. For Instagram, treat Instagram as the final target platform, not the primary search source.
5. If subagents or parallel workers are available, create or use cycle-level Finder Subtasks and dispatch selected cycles to workers in parallel. Do not personally run every selected cycle one-by-one when native dispatch exists.
6. Treat search results as leads, not candidates. Inspect enough evidence before recommending.
7. Before accepting an Instagram candidate, verify handle attribution and profile reachability. A listicle, directory, Reddit mention, or search snippet is not enough by itself.
8. Split results into accepted and rejected candidates.
9. Prefer importing cycle-specific results through `/api/finder-subtasks/{finder_subtask_id}/import`; use `/api/agent/raw-candidates/import` only as fallback.

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
- Do not recommend candidates only because one caption or post mentions a keyword.
- Do not accept Instagram candidates until handle attribution and profile reachability are verified. If attribution is unclear, import as `ignored` with a reject reason or leave the candidate out.
- Do not use Instagram native profile search as the main engine for Instagram Finder.
- Do not import candidates with `discovery_route: "cycle_multi_route"`. Use the actual evidence path that found the candidate.
- Do not silently skip required routes in a cycle prompt. If a route is unavailable or low-yield, include it in `route_coverage` with a reason.
- Do not start first-run Finder search before search intensity is confirmed, unless the user explicitly delegated the choice. Use Standard only when delegated or preselected.
- Do not silently run selected Finder cycles sequentially when native multi-agent dispatch is available. Use the dispatch feature or explicitly report why it is unavailable.
- If web search, browser, or relevant API tools are unavailable, return `cycle_status: "blocked"` with a clear `cycle_status_reason`. Do not present tool failure as completed/no-result.
- If your agent platform cannot run selected cycles in parallel, tell the user before starting that execution will be sequential and slower.
- Do not invent follower counts, countries, emails, or prices. Leave unknown fields blank.
