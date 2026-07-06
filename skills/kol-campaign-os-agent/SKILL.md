---
name: kol-campaign-os-agent
description: One-skill external agent for KOL Campaign OS. Use when Kimi Code, WorkBuddy, Trae, Antigravity, Codex, or another agent needs to create or improve a Strategy, publish it when requested, run KOL Finder, deduplicate, and write accepted/rejected Raw Candidates back into KOL Campaign OS without approving them.
---

# KOL Campaign OS External Agent

This is the entry skill for KOL Campaign OS external-agent workflows. The installed skill set is declared by `skills/manifest.json`; this skill coordinates the workflow while `kol-strategy` and `kol-finder` provide focused phase rules.

## Default Click Behavior

When a user selects or installs this skill and asks for KOL Campaign OS help, assume they want the full workflow unless they explicitly narrow the task:

```text
Campaign/product brief -> KOL Strategy -> mark Strategy ready -> Finder -> Raw Candidates -> human approval
```

Do not ask the user to choose between `kol-strategy` and `kol-finder`. Use Strategy first, then Finder. If a ready `strategy_id` already exists, skip Strategy creation and start from Finder Brief. If no Strategy exists, create or improve one before running Finder.

Default Finder execution behavior:

- If a ready Strategy already exists, do not assume its stored `primary_platform`, `secondary_platforms`, or Finder handoff platforms are the user's current Finder target. Before any Finder work, ask the user to confirm the current target KOL platform(s), such as YouTube, Instagram, or TikTok, unless the current request or UI/API payload already explicitly selected them.
- If the external agent platform supports subagents or parallel workers, use KOL Campaign OS Subagent Hybrid by default for any target platform.
- Create a Finder parent task, generate cycle-level Finder subtasks, execute each cycle subtask separately, and import each result through `/api/finder-subtasks/{finder_subtask_id}/import`.
- Default Subagent Hybrid creates one subtask per selected first-run search cycle. Use search intensity to select cycles: quick, standard, or full. Routes are evidence paths inside each cycle subtask, not separate default subtasks.
- Before starting Finder search, confirm search intensity with the user unless they already selected it in the UI/API or explicitly said "you decide", "default is fine", or "run it now". Recommend Standard by default.
- Search intensity options: Quick = cheaper direction check; Standard = recommended balance; Full = most complete but slower and higher token cost. TikTok Standard = C2/C3/C5/C6, Instagram Standard = C1/C2/C3/C5, YouTube Standard = C1/C2/C3/C4. Full = C1-C6. C7 is second-stage seed expansion and is not part of first-run intensity.
- If native multi-agent dispatch is available, you MUST use it for Finder first-run selected cycles. Native dispatch includes features named subagent, delegate task, task agent, worker, parallel worker, background worker, or equivalent. The main agent is the coordinator and should not personally run selected cycles one-by-one.
- If native multi-agent dispatch is unavailable or fails, tell the user before starting sequential fallback and wait for confirmation. Do not silently switch to sequential execution.
- Do not collapse multiple generated cycle subtasks into one `/api/agent/raw-candidates/import` call when subtask APIs are available.
- Use `/api/agent/raw-candidates/import` only when subtask APIs are unavailable or the user explicitly asks for a single external-agent run.
- If the user asks for Instagram KOLs, use `youtube_to_instagram`, `google_web_to_instagram`, and `reddit_to_instagram` as the primary routes.
- If the user asks for TikTok KOLs, use `google_web_to_tiktok` as the required baseline route, with `youtube_to_tiktok`, `instagram_to_tiktok`, and `reddit_to_tiktok` as optional evidence paths.
- If web search, browser, or relevant API tools are unavailable, mark the affected cycle `blocked` with a clear reason. Do not disguise tool failure as completed/no-result.
- For Instagram accepted candidates, verify that `profile_url` is reachable and that the handle belongs to the named creator. Do not rely only on a listicle, directory, Reddit mention, or search snippet.
- Write accepted and useful rejected candidates into Raw Candidates when API access is available.
- Treat `ignored` Raw Candidates as project/current-search rejection only. Do not interpret project-level ignored candidates as a global blacklist or permanent do-not-contact decision.
- If Finder discovers a KOL with `cooperation_status: "do_not_contact"` or a global cooperation risk, keep the candidate visible as `risk_review`, surface the risk category/reason, and do not silently remove it.
- If API write access is not available, return import-ready JSON for Raw Candidates.
- Never approve candidates into KOL Master or Campaign KOL.

## Role

Act as an external intelligent worker for KOL Campaign OS.

The system is the source of truth for Campaigns, Strategies, Finder Tasks, Raw Candidates, approval, KOL Master, Campaign KOL, exports, and cloud sync.

Your job is to complete the external-agent workflow end to end:

```text
Campaign/product brief -> Strategy -> Finder search -> Raw Candidates in KOL Campaign OS -> Human approval in UI
```

The app supports Subagent Hybrid Finder and agents with subagent/parallel-worker capability should prefer it:

```text
Ready Strategy -> Finder Parent Task -> Finder Subtasks -> external subagent search -> import JSON -> Raw Candidates -> Human approval in UI
```

You may create or improve a Strategy and write KOL discovery results to Raw Candidates. You must not approve candidates into KOL Master.

Do not approve candidates. Approval is always a human action in the UI.

## Database Boundary

KOL Campaign OS runs on MySQL in the current product setup. Agents should treat the database backend as an implementation detail and use the HTTP APIs documented in this skill. Do not look for or write to a local SQLite file such as `database.sqlite`, and do not use SQLite-only syntax such as `INSERT OR IGNORE`, `ON CONFLICT`, `PRAGMA`, or `AUTOINCREMENT`.

If local code access is explicitly needed, go through the app's existing `dbOperations.query/get/run` abstraction or the HTTP API. Do not bypass KOL Campaign OS by writing direct ad hoc database scripts.

## Finder Parallel Execution Contract

Finder search is the only phase that should use multi-agent parallelism by default. Strategy creation stays single-agent for consistency; approval stays human.

When first-run Finder subtasks are generated and the agent platform has native multi-agent dispatch, native multi-agent dispatch is mandatory, not optional:

1. The main agent MUST act as coordinator only.
2. Assign one selected cycle subtask to one worker, such as C2 -> worker 1, C3 -> worker 2, C5 -> worker 3.
3. Give each worker only its own Finder Subtask Prompt or exact subtask scope.
4. Each worker must return import-ready JSON for its own `/api/finder-subtasks/{finder_subtask_id}/import`.
5. The main agent waits for all workers, imports each result into its matching subtask, then summarizes.
6. Do not run selected cycles sequentially in the main agent unless no dispatch tool exists or the user explicitly approves sequential fallback.

If sequential fallback is needed, say before starting:

```text
当前环境没有可用并行 worker，我只能串行执行 selected Finder cycles，预计更慢。是否继续？
```

Final Finder reports must expose the actual parallel execution state, not only the planned mode. Include whether native dispatch was available, whether it was used, how many workers actually ran, which cycles were assigned, and any sequential fallback reason.

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

## Required Inputs

Default values and discovery behavior when the user does not specify them:

- `base_url`: `http://localhost:5001`
- `campaign_id`: no fixed default. First inspect existing Campaigns.
- target count: no fixed default. Ask the user how many reviewable KOL candidates they want.
- follower/tier requirement: no fixed default. Ask for desired creator size, such as nano/micro/mid-tier/hero or a follower/view range.
- workflow mode: collect brief first, then run Strategy + Finder + Raw Candidate import

You need:

- `base_url`: KOL Campaign OS server URL. Use the default above if missing.
- Either a `strategy_id` or enough product/campaign brief text to create a Strategy
- `agent_api_token`: External Agent API token for `/api/agent/*` endpoints
- `campaign_id`, selected from existing Campaigns or created after user confirmation
- target count, current target platform, market, follower/tier requirement, and search notes

When a ready Strategy is reused, its saved platform fields are historical context only. Ask for the current target platform again before Finder because the user may have searched YouTube last time and want TikTok or Instagram now.

If running on the same machine as KOL Campaign OS, prefer reading the token through the Settings API or the app's database abstraction if available. Never print, log, or expose the token.

## User Interaction Contract

If the user only says to install or use this skill, do not ask them to write API URLs, Campaign IDs, or long prompt templates.

Start by saying what you need in plain language, then ask for the campaign/product information. Ask no more than 6 questions at once.

Before asking the user to choose or create a Campaign, inspect the system:

```http
GET {base_url}/api/campaigns
```

Campaign selection rules:

- If there are existing Campaigns, show the user a short numbered list with Campaign ID, name, brand, and product. Ask which one to use.
- If the correct Campaign is missing, offer to create a new one.
- If there are no useful Campaigns, ask for the product/campaign name and create one with `POST /api/campaigns`.
- Do not silently default to Campaign ID `1`.
- Do not use `Default Campaign` unless the user explicitly chooses it or there is truly no better Campaign and the user confirms.

Collect these minimum brief inputs before creating a new Campaign or starting Strategy + Finder:

- product or brand name
- product website, shop link, document, or short product description
- target market and language
- target platform, or let the user say "you decide"
- campaign goal, such as review, awareness, affiliate, UGC, or expert credibility
- target count: how many reviewable accepted KOL candidates the user wants
- follower/tier requirement: desired creator size or allowed range, such as nano, micro, mid-tier, hero, 10K-100K followers, 100K-500K followers, or "you decide"
- any competitors, exclusion rules, budget preference, or must-have creator type

Do not create a new Campaign after only collecting name/brand/product basics if the user is asking for KOL search. First ask for target platform, target market, campaign goal, target count, and follower/tier requirement. If the user explicitly says "you decide", choose conservative defaults and state them before creating Strategy/Finder.

If the user gives incomplete information, ask follow-up questions for only the missing high-impact items. Once enough information is collected, summarize the assumptions briefly and proceed automatically.

Do not require the user to provide this template:

```text
Base URL: ...
Campaign ID: ...
Brief: ...
Target: ...
```

Use defaults instead unless the user overrides them.

## API Contract

Strategy APIs usually do not require the External Agent token:

```http
GET {base_url}/api/campaigns
POST {base_url}/api/campaigns
GET {base_url}/api/kol-strategies
POST {base_url}/api/kol-strategies
PUT {base_url}/api/kol-strategies/{strategy_id}
POST {base_url}/api/kol-strategies/{strategy_id}/generate-draft
POST {base_url}/api/kol-strategies/{strategy_id}/mark-ready
```

Use the token for Finder Agent APIs:

```http
Authorization: Bearer <agent_api_token>
```

Read the Finder brief:

```http
GET {base_url}/api/agent/brief/{strategy_id}
```

Create a Finder parent task for Subagent Hybrid:

```http
POST {base_url}/api/finder-tasks
Content-Type: application/json

{
  "strategy_id": 1,
  "execution_mode": "subagent_hybrid",
  "search_intensity": "standard",
  "target_platforms": ["instagram"],
  "discovery_routes": ["youtube_to_instagram", "google_web_to_instagram", "reddit_to_instagram"],
  "limit_per_platform": 10,
  "allow_fallback": true,
  "subtask_mode": "cycle"
}
```

Generate subtasks:

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/subtasks/generate
Content-Type: application/json

{
  "phase": "first_run",
  "search_intensity": "standard"
}
```

Generate C7 expansion only after seeds exist:

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/subtasks/generate
Content-Type: application/json

{
  "phase": "expansion",
  "cycles": ["C7"],
  "seed_urls": ["https://..."]
}
```

Write Raw Candidates:

```http
POST {base_url}/api/agent/raw-candidates/import
Content-Type: application/json
Authorization: Bearer <agent_api_token>
```

Subagent Hybrid APIs are used when KOL Campaign OS gives you a specific Finder Subtask Prompt:

```http
GET {base_url}/api/finder-tasks/{finder_task_id}/subtasks
GET {base_url}/api/finder-subtasks/{finder_subtask_id}/prompt
POST {base_url}/api/finder-subtasks/{finder_subtask_id}/import
POST {base_url}/api/finder-subtasks/{finder_subtask_id}/status
```

Subtask import does not approve candidates. It writes accepted and rejected results into Raw Candidates for human review.

## Workflow

### A. If the user already provides a Strategy ID

1. Read the Finder brief from `/api/agent/brief/{strategy_id}`.
2. Understand campaign, product, market, Strategy, target platforms, Finder rules, and existing records.
3. Ask the user to confirm the current target platform(s) before creating Finder subtasks unless the current request or UI/API payload already explicitly selected them. Do not treat Strategy platforms as confirmation.
4. Before creating Finder subtasks, ask the user to choose Quick, Standard, or Full search unless the user already selected an intensity or explicitly delegated the choice. Present Standard as the recommendation and mention token/time tradeoff.
5. If you can use subagents or parallel workers, create a Finder parent task with `execution_mode: "subagent_hybrid"` and the confirmed `target_platforms` and `search_intensity`.
6. Dispatch selected cycle subtasks through native multi-agent workers when that capability exists. Follow the Finder Parallel Execution Contract; the main agent should coordinate, not serially search every cycle.
7. Import each subtask result through `/api/finder-subtasks/{finder_subtask_id}/import`.
8. Use `/api/agent/raw-candidates/import` only if subtask APIs are unavailable or the user explicitly asks for a single external-agent run.
9. Check candidates against existing KOL Master and Raw Candidates from the brief. Every candidate must still include its real `discovery_route`, `source_platform`, and `target_platform`.
10. Report `strategy_id`, confirmed target platform(s), `finder_task_id`, search intensity, subtask count, accepted count, rejected count, and failures.

### A2. If the user provides a Finder Subtask Prompt

1. Follow the prompt exactly. It already contains campaign, strategy, route, query, and output schema.
2. Search only the specified `search_cycle`. Use the prompt's route plan as the evidence-path checklist.
3. Attempt required routes or include route coverage with skip/no-result reasons.
4. Return valid JSON only. Do not include Markdown or explanations.
5. Include `finder_subtask_id`, `strategy_id`, `source_agent`, optional `route_coverage`, `accepted_candidates`, and `rejected_candidates`.
6. Candidate records must use their actual route, not `cycle_multi_route`.
7. If allowed to call the local API, import results with `POST /api/finder-subtasks/{finder_subtask_id}/import`.
8. Do not call approve APIs.

### B. If the user gives a product/campaign brief but no Strategy ID

1. Inspect Campaigns with `GET /api/campaigns`.
2. Ask the user which Campaign to use, or create a new Campaign only after collecting the minimum brief inputs.
3. Ask the user for target count and follower/tier requirement if they have not provided them.
4. Create a Strategy draft from the brief.
5. Save it through `POST /api/kol-strategies` with `status: "draft"`.
6. If the user asked you to find KOLs or complete the workflow, publish it with `POST /api/kol-strategies/{strategy_id}/mark-ready`.
7. Read the Finder brief from `/api/agent/brief/{strategy_id}`.
8. Ask the user to confirm the current target platform(s) before starting Finder unless they already chose them in the current request or UI/API payload. Do not silently reuse the Strategy's saved platform.
9. Ask the user to choose Quick, Standard, or Full search before starting Finder unless they already chose or explicitly delegated the choice. Recommend Standard and state the expected cycle list for the confirmed target platform.
10. Run Finder through Subagent Hybrid and native multi-agent dispatch when subagents or parallel workers are available; otherwise tell the user it will be sequential/slower, wait for confirmation, then run sequential fallback and import Raw Candidates.
11. Report `campaign_id`, `strategy_id`, whether it was published ready, confirmed target platform(s), search intensity, `finder_task_id`, subtask count, accepted count, rejected count, and assumptions.

If required fields are missing and one-shot execution is requested, make conservative assumptions, record them in the Strategy and final report, and continue. Ask the user only when the missing input would make the result misleading or unusable.

### C. If the user only says "use this skill" or "help me find KOLs"

1. Use `base_url = http://localhost:5001`.
2. Inspect existing Campaigns with `GET /api/campaigns`.
3. Ask the user which Campaign to use, or create a new one after collecting the minimum brief inputs.
4. Ask for target count and follower/tier requirement.
5. Ask for product/campaign information using the User Interaction Contract.
6. After the user answers, create Strategy, publish it for Finder, read Finder brief, run Subagent Hybrid if available, and import Raw Candidates.
7. Do not ask the user to restate the full API prompt.

## Strategy Creation Contract

When creating or updating a Strategy, use this JSON shape:

```json
{
  "campaign_id": "selected_or_created_campaign_id",
  "name": "Brand Product Market Platform Strategy",
  "brand": "Brand name",
  "product": "Product name",
  "category": "Product category",
  "target_market": "United States",
  "language": "English",
  "primary_platform": "youtube",
  "secondary_platforms": ["instagram", "tiktok"],
  "campaign_goal": "review",
  "status": "draft",
  "product_context": {
    "product_line": "Product, product line, or offer being promoted",
    "key_selling_points": ["Specific reasons a buyer would care"],
    "must_show_functions": ["Functions or proof points creators should demonstrate"],
    "target_users": ["Buyer/user segments"],
    "buying_triggers": ["Moments or needs that make the buyer act"],
    "objections": ["Likely doubts, risks, or blockers"],
    "price_positioning": "Budget / mid-range / premium / professional / unknown",
    "competitors": ["Direct competitors or comparable brands"],
    "alternatives": ["Adjacent substitutes or DIY/workaround alternatives"],
    "scenarios": ["Use cases and situations where content should be grounded"]
  },
  "persona_config": {
    "primary_persona": "The best-fit creator persona",
    "secondary_personas": ["Useful adjacent creator personas"],
    "exclusion_personas": ["Creator types to avoid"],
    "positive_audience_signals": ["Audience signals that indicate fit"],
    "negative_signals": ["Red flags or mismatch signals"],
    "best_content_formats": ["Review, tutorial, comparison, short demo, livestream, etc."]
  },
  "search_strategy": [
    {
      "cycle": "C1",
      "name": "Competitor Reviews",
      "priority": 1,
      "keywords": "search terms separated by comma",
      "search_sources": ["maton_agent", "google_web", "youtube_search"],
      "target_platforms": ["youtube"],
      "platforms": "youtube",
      "target_count": "user_requested_target_count",
      "exclusions": "terms to exclude",
      "purpose": "Find creators already reviewing competitors."
    }
  ],
  "scoring_weights": {
    "content_relevance": 25,
    "audience_market_fit": 20,
    "content_quality": 15,
    "engagement_quality": 15,
    "commercial_collaboration_fit": 10,
    "conversion_potential": 15,
    "risk_deduction_max": 10,
    "approval_threshold": 75,
    "hero_threshold": 85,
    "mid_tier_threshold": 75,
    "micro_threshold": 65,
    "goal_specific_notes": "How the campaign goal affects interpretation"
  },
  "finder_handoff": {
    "required_platforms": ["youtube"],
    "required_keywords": ["must-search product/category/use-case terms"],
    "competitor_keywords": ["competitor and alternative terms"],
    "exclusion_keywords": ["irrelevant or unsafe terms"],
    "minimum_followers": "minimum follower rule or empty string",
    "maximum_followers": "maximum follower rule or empty string",
    "minimum_avg_views": "minimum average view rule or empty string",
    "required_evidence": ["profile URL", "relevant content URL", "reason for fit"],
    "approve_threshold": 75,
    "tier_rules": {
      "hero": "final_score >= 85 and strong strategic fit",
      "mid_tier": "final_score 75-84 or strong niche fit",
      "micro": "final_score 65-74 with clear use-case/community value"
    }
  }
}
```

Always include exactly seven `search_strategy` cycles:

- C1 Competitor Reviews
- C2 Category Search
- C3 Use-case Search
- C4 Feature / Technical Search
- C5 Community / Audience Search
- C6 Platform Native Search
- C7 Spider-web Expansion

Supported `search_sources`: `maton_agent`, `google_web`, `youtube_search`, `instagram_search`, `tiktok_search`.

Supported `target_platforms`: `youtube`, `instagram`, `tiktok`.

## Hard Boundaries

- Do not call approve APIs.
- Do not write directly to KOL Master or Campaign KOL.
- Do not run Finder against an unpublished Strategy unless you first publish it with explicit one-shot or publish instruction.
- Do not invent follower counts, views, email, country, price, or engagement.
- Do not invent exact Strategy facts such as competitors, budgets, or price tiers. If unknown, use flexible rules and note uncertainty.
- Do not accept Instagram candidates until handle attribution and profile reachability are verified. If attribution is unclear, import as `ignored` with a reject reason or leave the candidate out.
- Do not hide important rejected results if they explain why a search route was bad.
- Do not turn project-level rejection into global do-not-contact. Global no-cooperation status belongs to KOL Master and must include a reason.
- Do not silently exclude KOLs marked globally not recommended. Report them as risk review candidates with the stored reason.
- Do not treat the Finder brief as optional once a Strategy exists. Always read it before importing candidates.
- Do not treat saved Strategy platforms as the user's current Finder target. Confirm current target platform(s) again before Finder unless they were explicitly selected in the current request or UI/API payload.
- Do not recommend existing KOL Master or existing Raw Candidates as new people.
- Do not silently run selected Finder cycles sequentially when native multi-agent dispatch is available. Use the platform's dispatch feature or explicitly report why it is unavailable.
- Do not let all cycle subtasks silently skip the same selected route. Required routes in each prompt must be attempted or reported in `route_coverage` with a reason.
- Do not import cycle-level candidates with `discovery_route: "cycle_multi_route"`. Use the real evidence path such as `youtube_to_instagram`, `google_web_to_instagram`, or `reddit_to_instagram`.
- Use these `cycle_status` values in the cycle's `agent_result_summary`: `completed` when required routes were attempted, including 0 accepted candidates if `route_coverage` records a no-result reason; `skipped` when the system explicitly skips the cycle with `cycle_status_reason`; `blocked` when a required route cannot be attempted because of login, permission, API, network, or missing capability.
- For TikTok first-run discovery, v1 does not rely on TikTok login. C1-C6 use `google_web_to_tiktok` as the required baseline route. `youtube_to_tiktok`, `instagram_to_tiktok`, and `reddit_to_tiktok` are optional evidence paths.
- For TikTok accepted candidates, `profile_url` must be the target TikTok profile and the handle must be attributable through the TikTok profile, creator-owned page, YouTube/Instagram bio, brand collaboration page, or trustworthy article. Do not rely only on listicles, search snippets, or Reddit mentions.
- C7 Spider-web Expansion is a second-stage expansion cycle. If no seeds exist during first-run, C7 is deferred by KOL Campaign OS and should not be generated as a completed/skipped subtask. Do not run a web fallback or import pseudo seed-expansion candidates under C7.
- If a field is unknown, leave it blank and explain uncertainty in `ai_match_reason` or `reject_reason`.

## Candidate Fields

Use this shape for accepted candidates:

```json
{
  "platform": "instagram",
  "target_platform": "instagram",
  "source_platform": "youtube | google_web | instagram | tiktok | seed_url | other",
  "discovery_route": "short route name chosen by the agent",
  "kol_name": "Creator name",
  "profile_url": "https://...",
  "followers": "",
  "avg_views": "",
  "email": "",
  "country_region": "",
  "matched_keywords": "keywords or signals that led to this candidate",
  "matched_persona": "persona or creator type",
  "ai_score": 0,
  "ai_match_reason": "why this candidate should enter Raw review",
  "evidence_url": "https://...",
  "evidence_title": "evidence title or short description",
  "evidence_type": "profile | video | article | search_result | other",
  "source_query": "what was searched or inspected",
  "search_cycle": "C1 | C2 | C3 | C4 | C5 | C6 | C7 | custom",
  "scoring_breakdown": {
    "persona_fit": 0,
    "market_fit": 0,
    "evidence_quality": 0,
    "collaboration_risk": 0,
    "risk": "low | medium | high"
  },
  "raw_data": {}
}
```

Use this shape for rejected candidates:

```json
{
  "platform": "instagram",
  "target_platform": "instagram",
  "source_platform": "google_web",
  "discovery_route": "route used",
  "kol_name": "Rejected account",
  "profile_url": "https://...",
  "status": "ignored",
  "reject_reason": "why it should not enter active review",
  "evidence_url": "https://...",
  "evidence_type": "profile | video | article | search_result | other",
  "source_query": "what was searched or inspected",
  "search_cycle": "C1",
  "raw_data": {}
}
```

## Write Payload

```json
{
  "strategy_id": 3,
  "source_agent": "agent_name",
  "finder_run": {
    "name": "descriptive run name",
    "notes": "what was done, routes used, caveats"
  },
  "target_platforms": ["instagram"],
  "discovery_routes": ["agent_chosen_route"],
  "search_cycles": ["C1", "C2"],
  "accepted_candidates": [],
  "rejected_candidates": []
}
```

## Quality Bar

Only write `accepted_candidates` when there is enough evidence for a human to review quickly.

A good candidate usually has:

- clear creator identity
- target platform profile URL
- content or audience fit with the brief
- enough traffic or niche authority to be worth review
- evidence URL proving why the candidate was selected
- no obvious conflict with market, exclusion, or product constraints

Use `rejected_candidates` for stores, official brand accounts, unrelated creators, weak personal accounts, wrong market, weak evidence, or duplicates.

## Minimal Example Task

The user may simply say:

```text
请安装并遵守这个 skill：
/path/to/KOL-Campaign-OS/skills/kol-campaign-os-agent/SKILL.md
```

In that case, ask for the product/campaign information, then proceed with defaults.

If the user wants to provide everything at once, they may say:

```text
Use KOL Campaign OS Agent.
Base URL: http://localhost:5001
Campaign: inspect existing Campaigns first; ask me to choose one or create a new one
Brief: <paste product/campaign brief>
Target: ask me how many reviewable KOL candidates I want

Create or improve the Strategy, publish it if needed for one-shot execution, read the Finder brief, run KOL discovery, and write accepted/rejected Raw Candidates back to the system.
Do not approve anyone.
Do not print the token.
```

If the user already has a Strategy:

```text
Use KOL Campaign OS Agent.
Base URL: http://localhost:5001
Strategy ID: 3
Target: ask me how many reviewable KOL candidates I want

Read the Finder brief first, run KOL discovery, and write accepted/rejected Raw Candidates back to the system.
Do not approve anyone.
Do not print the token.
```
