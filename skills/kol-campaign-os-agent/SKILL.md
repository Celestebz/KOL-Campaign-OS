---
name: kol-campaign-os-agent
description: Connect an external AI agent to KOL Campaign OS through the External Agent API. Use when an agent needs to read a campaign/strategy brief, run its own KOL discovery or analysis workflow, deduplicate against system records, and write Raw Candidates back into KOL Campaign OS without approving them.
---

# KOL Campaign OS External Agent

## Role

Act as an external intelligent worker for KOL Campaign OS.

The system is the source of truth for campaigns, strategies, Raw Candidates, approval, KOL Master, Campaign KOL, exports, and cloud sync. Your job is to read the task brief, perform your own search or analysis, and write reviewable results back to Raw Candidates.

Do not approve candidates. Approval is always a human action in the UI.

## Required Inputs

You need:

- `base_url`: KOL Campaign OS server URL, usually `http://localhost:5001`
- `strategy_id`: the published Strategy to run against
- `agent_api_token`: External Agent API token

If running on the same machine as KOL Campaign OS, you may read the token from the local system settings/database if available. Never print, log, or expose the token.

## API Contract

Use the token in either header:

```http
Authorization: Bearer <agent_api_token>
```

Read the brief:

```http
GET {base_url}/api/agent/brief/{strategy_id}
```

Write Raw Candidates:

```http
POST {base_url}/api/agent/raw-candidates/import
Content-Type: application/json
Authorization: Bearer <agent_api_token>
```

## Workflow

1. Read the Agent Brief.
2. Understand campaign, product, market, strategy, target platforms, finder rules, and existing records.
3. Decide your own discovery or analysis method.
4. Check candidates against existing KOL Master and Raw Candidates from the brief.
5. Split output into `accepted_candidates` and `rejected_candidates`.
6. Write both accepted and useful rejected records back through the import API.
7. Report `finder_task_id`, accepted count, rejected count, and any failures.

## Hard Boundaries

- Do not call approve APIs.
- Do not write directly to KOL Master or Campaign KOL.
- Do not invent follower counts, views, email, country, price, or engagement.
- Do not hide important rejected results if they explain why a search route was bad.
- Do not treat the brief as optional. Always read it first.
- Do not recommend existing KOL Master or existing Raw Candidates as new people.
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
    "brand_fit": 0,
    "product_fit": 0,
    "traffic_quality": 0,
    "evidence_quality": 0,
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

```text
Use KOL Campaign OS External Agent API.
Base URL: http://localhost:5001
Strategy ID: 3
Read the brief first.
Run your own Finder workflow for the target platform in the brief.
Write accepted and rejected Raw Candidates back to the system.
Do not approve anyone.
Do not print the token.
```
