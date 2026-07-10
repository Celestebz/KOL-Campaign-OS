---
name: kol-strategy
description: Use when planning creator discovery for a product, campaign, brand, market, target platform, or KOL persona, or when KOL Campaign OS needs a structured strategy before Finder runs.
---

# KOL Strategy

## Purpose

Convert a campaign brief into a structured strategy that guides target-platform video discovery, evidence interpretation, creator scoring, and human approval.

```text
Campaign -> KOL Strategy -> Video Evidence Finder -> Raw Candidates -> Human Approval
```

Do not start Finder until the product, target user, target platform, KOL persona, evidence guidance, scoring logic, and Finder handoff are clear.

## Workflow

1. Extract known campaign facts.
2. Ask only for missing high-impact inputs: product, market/language, campaign goal, target platform, audience, competitors, creator tier, and follower/view constraints.
3. Produce four sections:
   - Product Breakdown
   - KOL Persona
   - Scoring Weights
   - Finder Handoff
4. For Web app generation, return valid JSON only using `references/strategy-output-schema.md`.

## Evidence Guidance

Define five semantic labels inside `finder_handoff.evidence_signals`:

- `competitor`: the video reviews, compares, replaces, or discusses a competitor or alternative.
- `category`: the video demonstrates credible history in the product category.
- `use_case`: the video shows a target user problem, workflow, situation, or buying trigger.
- `feature`: the video demonstrates a required function, technical proof point, or differentiating feature.
- `community`: the video demonstrates access to a relevant audience, niche, profession, or interest community.

These labels are independent. AI assigns zero or more evidence signals after a video is found, and one video may support multiple labels. They are not execution steps and do not determine how many searches run.

## Strategy Rules

- Make product facts useful for video discovery and evidence judgment, not generic marketing copy.
- Describe creators who can credibly demonstrate, review, compare, teach, or use the product.
- Include exclusion personas and exclusion keywords.
- Provide discovery keywords broad enough to find relevant videos on the selected target platform.
- Keep scoring weights stable unless the campaign goal clearly justifies adjustment.
- Treat risk as a deduction, never a positive score.
- Make Finder handoff actionable: recommended platforms, discovery keywords, evidence guidance, follower/view constraints, approval threshold, and tier rules.
- If creator size is unspecified, ask for a tier or range. If the user says to decide, record the chosen constraints explicitly.

## Goal Bias

- Awareness: favor reach, content clarity, audience scale, and platform fit.
- Review: favor testing credibility, comparison history, and proof depth.
- Affiliate / Conversion: favor buyer intent, trust, CTA behavior, and conversion potential.
- UGC / Ads Asset: favor visual style, repeatable hooks, licensing fit, and short-form quality.
- Expert Credibility: favor expertise, professional trust, proof depth, and low brand-safety risk.

## Output Contract

When KOL Campaign OS asks for a strategy draft, return valid JSON only. Do not include Markdown, comments, or chain-of-thought.