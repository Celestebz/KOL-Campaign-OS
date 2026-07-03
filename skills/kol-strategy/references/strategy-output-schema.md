# KOL Strategy Output Schema

For normal strategy generation, return one JSON object with these top-level keys:

```json
{
  "product_context": {},
  "persona_config": {},
  "search_strategy": [],
  "scoring_weights": {},
  "finder_handoff": {}
}
```

For material analysis in KOL Campaign OS, also include:

```json
{
  "source_material_summary": "Concise summary of what the AI understood from the provided brief/files"
}
```

## product_context

```json
{
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
}
```

## persona_config

```json
{
  "primary_persona": "The best-fit creator persona",
  "secondary_personas": ["Useful adjacent creator personas"],
  "exclusion_personas": ["Creator types to avoid"],
  "positive_audience_signals": ["Audience signals that indicate fit"],
  "negative_signals": ["Red flags or mismatch signals"],
  "best_content_formats": ["Review, tutorial, comparison, short demo, livestream, etc."]
}
```

## search_strategy

Always include 7 objects, one per cycle:

```json
[
  {
    "cycle": "C1",
    "name": "Competitor Reviews",
    "priority": 1,
    "keywords": "search terms separated by comma",
    "search_sources": ["maton_agent", "google_web", "youtube_search"],
    "target_platforms": ["youtube"],
    "platforms": "youtube, instagram, tiktok",
    "target_count": 20,
    "exclusions": "terms to exclude",
    "purpose": "why this cycle exists"
  }
]
```

Cycle names:

- C1 Competitor Reviews
- C2 Category Search
- C3 Use-case Search
- C4 Feature / Technical Search
- C5 Community / Audience Search
- C6 Platform Native Search
- C7 Spider-web Expansion

`search_sources` means where Finder should search. Supported values:

- `maton_agent`
- `google_web`
- `youtube_search`
- `instagram_search`
- `tiktok_search`

`target_platforms` means what platform the final KOL profile should belong to. Supported values:

- `youtube`
- `instagram`
- `tiktok`

Keep `platforms` for backward compatibility only. If possible, fill `search_sources` and `target_platforms` explicitly.

## scoring_weights

Use this default unless the campaign goal justifies small changes:

```json
{
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
}
```

## finder_handoff

```json
{
  "required_platforms": ["youtube", "instagram", "tiktok"],
  "required_keywords": ["must-search product/category/use-case terms"],
  "competitor_keywords": ["competitor and alternative terms"],
  "exclusion_keywords": ["irrelevant or unsafe terms"],
  "minimum_followers": "minimum follower rule or empty string",
  "maximum_followers": "maximum follower rule or empty string",
  "minimum_avg_views": "minimum average view rule or empty string",
  "required_evidence": ["evidence Finder should collect before approval"],
  "approve_threshold": 75,
  "tier_rules": {
    "hero": "final_score >= 85 and strong strategic fit",
    "mid_tier": "final_score 75-84 or strong niche fit",
    "micro": "final_score 65-74 with clear use-case/community value"
  }
}
```

## Quality Bar

- Make keywords concrete enough to paste into YouTube, Instagram, TikTok, ScrapeCreators, Apify, or Bright Data.
- Prefer search phrases that reveal buyer intent, content history, and product proof.
- Avoid filler phrases such as "high quality creators" unless paired with observable evidence.
- Do not invent exact follower thresholds when the campaign context gives no tier or budget; use flexible rules instead.
- If a project is intended for micro/mid-tier creator discovery, set both minimum and maximum follower rules so Finder avoids irrelevant celebrity-scale accounts.
