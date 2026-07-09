# Video Evidence Signal Model

## Goal

Replace the legacy C1-C7 Cycle workflow completely with one target-platform-first
Video Evidence Finder workflow. The system must not retain compatibility paths
that encourage agents, users, or backend code to execute searches as sequential
cycles.

## Core Model

Finder runs one discovery workflow for one explicitly selected target platform:

1. Confirm campaign, product, strategy, and target platform.
2. Search for relevant videos on that target platform.
3. Import target-platform video evidence.
4. Crawl and analyze the evidence.
5. Let AI assign zero or more evidence signals to each video.
6. Aggregate analyzed evidence by author.
7. Generate Raw Candidates supported by video evidence.
8. Leave approval to a human.

The five evidence signals are:

- `competitor`: evidence about competitors, alternatives, or comparisons.
- `category`: evidence demonstrating category relevance or expertise.
- `use_case`: evidence showing a relevant user need, scenario, or workflow.
- `feature`: evidence demonstrating a relevant function, capability, or proof point.
- `community`: evidence showing audience, niche, or community relevance.

Signals are multi-label evidence classifications. One video may receive multiple
signals. Signals are not tasks, phases, routes, priorities, or execution rounds.
They do not cause Finder to run five searches.

## Strategy Contract

Strategy stores product context, creator persona, scoring rules, Finder handoff,
and optional discovery guidance. It no longer stores `search_strategy` or any
Cycle object.

Discovery guidance may contain concrete phrases and exclusions that help find
relevant videos, but it must not be represented as five required buckets or
execution steps. Evidence signals are assigned after evidence is found and
analyzed.

The strategy API and AI output schema must reject legacy Cycle fields rather
than silently convert or normalize them.

## Finder Contract

Creating a Finder task requires:

- `strategy_id`
- exactly one `target_platform`
- `execution_mode: "video_evidence_finder"` during transition; the field may
  later be removed when no alternative mode exists
- an optional evidence limit

Finder always enforces:

- target-platform-first discovery
- evidence platform equals target platform
- no profile URL accepted as a video URL
- no direct Raw Candidate creation from profile search
- no Cycle, search-intensity, cross-platform, subagent-hybrid, or route matrix
  settings

Legacy request fields must return a clear validation error. They must not be
ignored because silent acceptance would let old agents appear to work.

## Evidence Analysis

AI analysis returns an `evidence_signals` array containing zero or more of the
five allowed values, plus a short reason for each assigned signal.

`source_signal` supplied by a discovery tool is provenance only and must not be
treated as the final AI classification. The final evidence classification is
stored with the analysis result and displayed in the evidence UI.

Evidence with no valid signal may remain available for audit, but it must not
support candidate generation unless it independently passes the configured
relevance threshold.

## User Interface

Remove all controls, labels, progress indicators, filters, and detail fields for:

- C1-C7
- Cycle
- Quick / Standard / Full search intensity
- current or completed cycles
- C7 seed expansion
- route matrices and cross-platform evidence
- Subagent Hybrid and other legacy execution modes

The task form selects one published strategy, one target platform, and an
optional result limit. Evidence views display multi-label AI evidence signals.

## Skills and Agent APIs

Update `kol-strategy`, `kol-finder`, and `kol-campaign-os-agent` together.
Installed copies must be refreshed after repository changes.

Remove every instruction, example, schema, prompt, and endpoint capability that
mentions or accepts Cycle execution. Agent discovery documentation exposes only
the target-platform video-evidence workflow.

Remove or disable direct Raw Candidate import and legacy Finder task creation
from the agent API.

## Database Replacement

Create a forward migration that:

1. Clears all business data.
2. Removes legacy Cycle columns.
3. Replaces strategy Cycle storage with the new strategy contract.
4. Adds structured multi-label evidence signal storage.
5. Preserves runtime configuration.

Clear these tables in foreign-key-safe order:

- `analysis_job_items`
- `analysis_jobs`
- `campaign_kols`
- `campaign_videos`
- `raw_candidates`
- `finder_video_evidence`
- `video_ai_analysis_results`
- `video_comments`
- `video_snapshots`
- `video_sources`
- `finder_tasks`
- `kol_platform_accounts`
- `customers`
- `kol_strategies`
- `campaigns`

Preserve:

- `api_settings`
- `prompt_templates`
- `customer_groups`
- `sequelize_meta`

Reset auto-increment counters for cleared business tables. Seed a clean default
campaign only if the application requires one to render; otherwise start with
no business records.

Remove these legacy columns from the schema and models:

- `kol_strategies.search_strategy`
- `finder_tasks.search_cycles`
- `finder_tasks.current_cycle`
- `finder_tasks.total_cycles`
- `finder_tasks.completed_cycles`
- `raw_candidates.search_cycle`

No migration or startup code may recreate compatibility columns.

## Error Handling

- Reject legacy Cycle payloads with HTTP 400 and a migration-focused message.
- Reject missing or multiple target platforms.
- Reject evidence whose platform differs from the task target platform.
- Reject profile URLs submitted as video evidence.
- Preserve individual evidence failures without losing successful evidence.
- Prevent candidate generation when no analyzed, relevant video evidence exists.

## Verification

Automated tests must prove:

- one Finder task never expands into Cycle subtasks
- task creation accepts exactly one target platform
- legacy Cycle and search-intensity fields are rejected
- imported evidence must match the target platform
- one video can receive multiple evidence signals
- only the five allowed signals are stored
- candidate generation uses analyzed video evidence
- direct profile-to-candidate paths are unavailable
- runtime configuration survives the business-data reset
- all business tables are empty after migration
- repository code, UI text, schemas, and active skills contain no C1-C7 workflow
  references

## Rollout

Apply the change as one coordinated replacement. Do not deploy a state where
skills describe the new model while the UI or API still accepts the old model.
After migration and verification, reinstall the three KOL skills so agents
cannot read stale local copies.
