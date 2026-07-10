# KOL Strategy Output Schema

Return one JSON object with these top-level keys:

```json
{
  "product_context": {},
  "persona_config": {},
  "scoring_weights": {},
  "finder_handoff": {}
}
```

For material analysis, also include `source_material_summary`.

## product_context

```json
{
  "product_line": "Product, product line, or offer",
  "key_selling_points": ["Specific buyer value"],
  "must_show_functions": ["Functions or proof points a video can demonstrate"],
  "target_users": ["Buyer or user segments"],
  "buying_triggers": ["Needs or moments that cause action"],
  "objections": ["Likely doubts or blockers"],
  "price_positioning": "budget | mid-range | premium | professional | unknown",
  "competitors": ["Direct competitors"],
  "alternatives": ["Adjacent substitutes or workarounds"],
  "scenarios": ["Grounded use situations"]
}
```

## persona_config

```json
{
  "primary_persona": "Best-fit creator persona",
  "secondary_personas": ["Useful adjacent personas"],
  "exclusion_personas": ["Creator types to avoid"],
  "positive_audience_signals": ["Observable audience-fit indicators"],
  "negative_signals": ["Observable mismatch indicators"],
  "best_content_formats": ["Review, tutorial, comparison, demo, livestream"]
}
```

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
  "goal_specific_notes": "How the campaign goal changes interpretation"
}
```

## finder_handoff

```json
{
  "required_platforms": ["youtube", "instagram", "tiktok"],
  "discovery_keywords": ["product, category, problem, scenario, feature, competitor, audience terms"],
  "competitor_keywords": ["competitors and alternatives"],
  "exclusion_keywords": ["irrelevant or unsafe terms"],
  "evidence_signals": {
    "competitor": {
      "keywords": ["competitor and comparison terms"],
      "proof": ["Observable comparison, replacement, or competitor-use evidence"]
    },
    "category": {
      "keywords": ["category terms"],
      "proof": ["Credible category content history or demonstration"]
    },
    "use_case": {
      "keywords": ["target problems, workflows, and situations"],
      "proof": ["A relevant use situation shown in the video"]
    },
    "feature": {
      "keywords": ["functions and technical proof points"],
      "proof": ["A required function or differentiator demonstrated"]
    },
    "community": {
      "keywords": ["audience, profession, niche, and community terms"],
      "proof": ["Content clearly serving a relevant community"]
    }
  },
  "minimum_followers": "minimum rule or empty string",
  "maximum_followers": "maximum rule or empty string",
  "minimum_avg_views": "minimum rule or empty string",
  "required_evidence": ["Evidence required before human approval"],
  "approve_threshold": 75,
  "tier_rules": {
    "hero": "final_score >= 85 and strong strategic fit",
    "mid_tier": "final_score 75-84 or strong niche fit",
    "micro": "final_score 65-74 with clear relevance"
  }
}
```

AI assigns zero or more evidence signals after each target-platform video is analyzed. A video may match multiple evidence signals; the labels do not prescribe discovery order.

## Quality Bar

- Use concrete keywords that can find real videos on YouTube, Instagram, or TikTok.
- Prefer phrases revealing buyer intent, content history, and observable product proof.
- Avoid unobservable filler such as "high quality creator".
- Do not invent exact follower or view thresholds when the brief gives no tier or budget.