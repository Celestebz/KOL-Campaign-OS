---
name: kol-strategy
description: Generate a structured KOL campaign strategy before KOL Finder. Use when planning creator search for a product, campaign, brand, market, platform, or KOL persona; when creating AI strategy drafts in KOL Campaign OS; or before approving Finder raw candidates into the KOL library.
---

# KOL Strategy

## Role

Use this skill before KOL Finder. Convert a campaign brief into a structured strategy that can guide search, scoring, approval, and reporting.

The required flow is:

```text
Campaign -> KOL Strategy -> KOL Finder -> Raw Candidates -> Approved KOL -> Campaign KOL
```

Do not move to Finder until the product, target user, platform priority, KOL persona, search path, scoring logic, and Finder handoff are clear enough.

## Workflow

1. Extract campaign facts from the user's brief or system data.
2. Ask only for missing high-impact inputs: target market, main platform, campaign goal, product/category, price position, target buyer, competitors, budget or KOL tier constraints, and desired follower/view range.
3. Generate five structured sections:
   - Product Breakdown
   - KOL Persona
   - Search Strategy
   - Scoring Weights
   - Finder Handoff
4. Keep the strategy brand-agnostic and reusable across industries. Do not hard-code MOOER or any previous employer/product.
5. Return structured output only when used by the Web app. For exact JSON keys and examples, read `references/strategy-output-schema.md`.

## Strategy Rules

- Make the product breakdown useful for creator search, not generic marketing copy.
- Describe who can credibly demonstrate, review, compare, or make content about the product.
- Include exclusion personas to prevent irrelevant high-follower creators from entering the shortlist.
- Build the 7 search cycles in this order: competitor reviews, category search, use-case search, feature search, community search, platform native search, spider-web expansion.
- Keep scoring weights stable unless the campaign goal strongly suggests adjustment.
- Treat risk as a deduction, not a positive score.
- Finder handoff must be actionable: platforms, keywords, exclusion terms, minimum evidence, thresholds, and tier rules.
- If the user has not provided creator size requirements, ask for desired KOL tier or follower/view range before finalizing the Strategy. If the user says "you decide", state the chosen tier rules explicitly in `finder_handoff`.

## Goal Bias

- Awareness: favor reach, content clarity, audience scale, and platform fit.
- Review: favor testing credibility, depth, comparison history, and proof quality.
- Affiliate / Conversion: favor buyer intent, trust, CTA behavior, and conversion potential.
- UGC / Ads Asset: favor visual style, hook repeatability, licensing fit, and short-form quality.
- Expert Credibility: favor expertise, professional trust, proof depth, and low brand-safety risk.

## Output Contract

When KOL Campaign OS asks for a strategy draft, return valid JSON only. Do not include Markdown, comments, or chain-of-thought.

Read `references/strategy-output-schema.md` for the required schema.
