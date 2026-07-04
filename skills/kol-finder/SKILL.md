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

If the external agent platform supports subagents or parallel workers, prefer Subagent Hybrid for any target platform. Run one focused worker per generated cycle subtask, then import each result through `/api/finder-subtasks/{finder_subtask_id}/import`. Do not collapse multiple cycles into one `/api/agent/raw-candidates/import` call unless subtask APIs are unavailable or the user explicitly asks for a single external-agent run.

Default Subagent Hybrid uses cycle-level subtasks. Each generated subtask owns one search cycle, such as C1 Competitor Reviews or C5 Community Search. Discovery routes are evidence paths inside the cycle prompt. Attempt required routes or report skip/no-result reasons in `route_coverage`; candidates must still record their actual `discovery_route`.

## Workflow

1. Read the Agent Brief from KOL Campaign OS.
2. Respect the Strategy, target market, persona, exclusion personas, follower/view rules, and existing KOL/raw candidate lists.
3. Choose discovery routes for the target platform. For Instagram, treat Instagram as the final target platform, not the primary search source.
4. If subagents or parallel workers are available, create or use cycle-level Finder Subtasks and execute every selected cycle separately.
5. Treat search results as leads, not candidates. Inspect enough evidence before recommending.
6. Before accepting an Instagram candidate, verify handle attribution and profile reachability. A listicle, directory, Reddit mention, or search snippet is not enough by itself.
7. Split results into accepted and rejected candidates.
8. Prefer importing cycle-specific results through `/api/finder-subtasks/{finder_subtask_id}/import`; use `/api/agent/raw-candidates/import` only as fallback.

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
- C7 Spider-web Expansion: use it only after seeds exist or when the user supplied seed URLs. If no seeds exist, C7 should be explicitly skipped with `cycle_status: "skipped"` and `cycle_status_reason: "no_seed"`. Do not run a web fallback under C7 or import pseudo seed-expansion candidates.

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
- Do not invent follower counts, countries, emails, or prices. Leave unknown fields blank.
