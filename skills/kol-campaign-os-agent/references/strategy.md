# KOL Strategy

Convert a campaign brief into a structured strategy that guides target-platform video discovery, evidence interpretation, creator scoring, and human approval.

## Workflow

1. Extract known campaign facts.
2. Ask only for missing high-impact inputs: product, market/language, campaign goal, target platform, audience, competitors, creator tier, and follower/view constraints.
3. Produce Product Breakdown, KOL Persona, Scoring Weights, and Finder Handoff.
4. For app generation, return valid JSON only using `strategy-output-schema.md`.

## Evidence Guidance

Define these independent semantic labels inside `finder_handoff.evidence_signals`:

- `competitor`: reviews, comparisons, replacements, or alternatives.
- `category`: credible product-category content history.
- `use_case`: a target problem, workflow, situation, or buying trigger.
- `feature`: a required function, proof point, or differentiator.
- `community`: access to a relevant audience, niche, or profession.

AI assigns zero or more evidence signals after a video is found. One video may support multiple labels; labels are not execution steps.

## Rules

- Make product facts useful for discovery and evidence judgment, not generic marketing copy.
- Describe creators who can credibly demonstrate, review, compare, teach, or use the product.
- Include exclusion personas and exclusion keywords.
- Provide concrete discovery keywords for the selected platform.
- Keep scoring weights stable unless the campaign goal justifies adjustment.
- Treat risk as a deduction, never a positive score.
- Include recommended platforms, keywords, evidence guidance, follower/view constraints, approval threshold, and tier rules in Finder handoff.
- If creator size is unspecified, ask for a tier or record an explicitly chosen range.

## Goal Bias

- Awareness: reach, clarity, audience scale, and platform fit.
- Review: testing credibility, comparison history, and proof depth.
- Affiliate / Conversion: buyer intent, trust, CTA behavior, and conversion potential.
- UGC / Ads Asset: visual style, repeatable hooks, licensing fit, and short-form quality.
- Expert Credibility: expertise, professional trust, proof depth, and low brand-safety risk.

Return valid JSON only when KOL Campaign OS requests a strategy draft. Do not include Markdown, comments, or chain-of-thought.
