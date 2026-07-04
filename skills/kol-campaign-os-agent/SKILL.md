---
name: kol-campaign-os-agent
description: One-skill external agent for KOL Campaign OS. Use when Kimi Code, WorkBuddy, Trae, Antigravity, Codex, or another agent needs to create or improve a Strategy, publish it when requested, run KOL Finder, deduplicate, and write accepted/rejected Raw Candidates back into KOL Campaign OS without approving them.
---

# KOL Campaign OS External Agent

## Default Click Behavior

When a user selects or installs this skill and asks for KOL Campaign OS help, assume they want the full workflow unless they explicitly narrow the task:

```text
Campaign/product brief -> KOL Strategy -> mark Strategy ready -> Finder -> Raw Candidates -> human approval
```

Do not ask the user to choose between `kol-strategy` and `kol-finder`. Use Strategy first, then Finder. If a ready `strategy_id` already exists, skip Strategy creation and start from Finder Brief. If no Strategy exists, create or improve one before running Finder.

Default Finder execution behavior:

- If the external agent platform supports subagents or parallel workers, use KOL Campaign OS Subagent Hybrid by default for any target platform.
- Create a Finder parent task, generate cycle-level Finder subtasks, execute each cycle subtask separately, and import each result through `/api/finder-subtasks/{finder_subtask_id}/import`.
- Default Subagent Hybrid creates one subtask per selected search cycle, usually C1-C7. Routes are evidence paths inside each cycle subtask, not separate default subtasks.
- Do not collapse multiple generated cycle subtasks into one `/api/agent/raw-candidates/import` call when subtask APIs are available.
- Use `/api/agent/raw-candidates/import` only when subtask APIs are unavailable or the user explicitly asks for a single external-agent run.
- If the user asks for Instagram KOLs, use `youtube_to_instagram`, `google_web_to_instagram`, and `reddit_to_instagram` as the primary routes.
- For Instagram accepted candidates, verify that `profile_url` is reachable and that the handle belongs to the named creator. Do not rely only on a listicle, directory, Reddit mention, or search snippet.
- Write accepted and useful rejected candidates into Raw Candidates when API access is available.
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
- target count, target platform, market, follower/tier requirement, and search notes

If running on the same machine as KOL Campaign OS, you may read the token from the local system settings/database if available. Never print, log, or expose the token.

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
  "target_platforms": ["instagram"],
  "discovery_routes": ["youtube_to_instagram", "google_web_to_instagram", "reddit_to_instagram"],
  "cycles": ["C1", "C2", "C3", "C4", "C5", "C6", "C7"],
  "limit_per_platform": 10,
  "allow_fallback": true,
  "subtask_mode": "cycle"
}
```

Generate subtasks:

```http
POST {base_url}/api/finder-tasks/{finder_task_id}/subtasks/generate
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
3. If you can use subagents or parallel workers, create a Finder parent task with `execution_mode: "subagent_hybrid"` and generate subtasks.
4. Execute each generated cycle subtask separately. Follow its route plan and attempt every required route, or record a skip/no-result reason.
5. Import each subtask result through `/api/finder-subtasks/{finder_subtask_id}/import`.
6. Use `/api/agent/raw-candidates/import` only if subtask APIs are unavailable or the user explicitly asks for a single external-agent run.
7. Check candidates against existing KOL Master and Raw Candidates from the brief. Every candidate must still include its real `discovery_route`, `source_platform`, and `target_platform`.
8. Report `strategy_id`, `finder_task_id`, subtask count, accepted count, rejected count, and failures.

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
8. Run Finder through Subagent Hybrid when subagents or parallel workers are available; otherwise run a single external-agent discovery and import Raw Candidates.
9. Report `campaign_id`, `strategy_id`, whether it was published ready, `finder_task_id`, subtask count, accepted count, rejected count, and assumptions.

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
- Do not treat the Finder brief as optional once a Strategy exists. Always read it before importing candidates.
- Do not recommend existing KOL Master or existing Raw Candidates as new people.
- Do not let all cycle subtasks silently skip the same selected route. Required routes in each prompt must be attempted or reported in `route_coverage` with a reason.
- Do not import cycle-level candidates with `discovery_route: "cycle_multi_route"`. Use the real evidence path such as `youtube_to_instagram`, `google_web_to_instagram`, or `reddit_to_instagram`.
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
