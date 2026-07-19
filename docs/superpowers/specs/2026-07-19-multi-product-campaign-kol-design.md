# Multi-Product Campaign and KOL Relationships

## Goal

Separate Campaign, Product, and KOL responsibilities so KOL Campaign OS supports
both operating models already used by the business:

- one Campaign for one product, such as a dedicated MOOER product launch;
- one Campaign for several related products, such as a Vivatrees Christmas tree
  project covering multiple active tree products.

The system must preserve one global KOL identity, one shared KOL cooperation
workflow per Campaign, and independent product-level matching and execution
records. The migration must not delete or overwrite existing user data.

## Confirmed Business Rules

- A Campaign is a project or promotional initiative.
- A Campaign may contain one or more Products.
- A Product is a reusable global asset and may participate in multiple Campaigns.
- Vivatrees products in the current scope share the same US market, promotion
  period, team, and overall project context.
- The two currently known active Vivatrees Products are Everglow and Evercrest.
  Their count does not represent the complete Vivatrees product catalog.
- Each Strategy and Finder Task targets exactly one Product in one Campaign.
- Finder runs one product at a time; it does not scan the existing KOL Master.
- When Finder discovers an existing KOL, the existing identity, cooperation
  history, and risk information may inform the current product evaluation.
- Existing history never replaces current target-platform video evidence.
- The same KOL may cooperate on multiple Products in the same Campaign.
- A KOL has one shared contact, negotiation, and contract workflow per Campaign.
- Matching, selection, samples, deliverables, and content execution remain
  independent for every Campaign Product.
- Budget allocation, ROI, commissions, and product-level financial reporting are
  outside this change.

## Domain Model

### Product

`products` is the global product catalog. A Product stores stable product facts:

- `id`
- `brand`
- `name`
- `sku`
- `category`
- `product_url`
- `price`
- `currency`
- `description`
- `selling_points`
- `status`

Product records are reusable across Campaigns. Once referenced by historical
business data, a Product is archived instead of physically deleted.

### Campaign Product

`campaign_products` associates a Product with a Campaign and stores project-
specific context:

- `id`
- `campaign_id`
- `product_id`
- `role`: `hero`, `secondary`, or `test`
- `priority`
- `campaign_brief`
- `status`: `planned`, `active`, `paused`, `completed`, or `archived`
- timestamps

`campaign_id + product_id` is unique. The UI reports both total associated
Products and active Products. It must not present the associated count as the
brand's total product count.

`campaign_product_id` identifies a Product in a specific Campaign. Strategy,
Finder, candidate matching, and cooperation records use this identifier because
the same global Product may have different briefs, status, and outcomes in
different Campaigns.

### Strategy Product Binding

Each `kol_strategies` row receives one nullable `campaign_product_id` for
backward compatibility. New Strategies require it. The referenced Campaign
Product must belong to the Strategy's Campaign.

A multi-product Strategy and a `strategy_products` join table are intentionally
excluded. Product search remains one product at a time.

### Finder Product Binding

Each `finder_tasks` row receives one nullable `campaign_product_id`. New Finder
Tasks inherit it from the published Strategy; callers cannot override the
Product for a run. New Finder Tasks are allowed only when the Campaign Product
status is `active`.

Legacy Finder Tasks without a binding remain readable but cannot be restarted
through the new product-scoped workflow.

### Raw Candidate Product Fit

`raw_candidate_product_fits` stores product-specific assessment before human
approval:

- `id`
- `latest_raw_candidate_id`
- `campaign_product_id`
- `existing_customer_id`
- `platform`
- `identity_key_hash`
- `strategy_id`
- `finder_task_id`
- `identity_status`
- `fit_score`
- `matched_persona`
- `evidence_summary`
- `decision_status`
- `analysis_version`
- timestamps

`campaign_product_id + identity_key_hash` is unique. The identity key is derived
from the normalized platform profile/account identity, with an explicit fallback
for evidence that has not resolved to a profile yet. `latest_raw_candidate_id`
records the most recent candidate source, while the evidence summary keeps the
full contributing history. Repeated discovery appends evidence and creates a
new analysis version or history record without replacing an existing human
decision.

Supported identity statuses are:

- `new_kol`
- `known_kol_new_product_fit`
- `existing_product_fit_updated`

Identity resolution uses the normalized platform profile/account first, then
existing safe fallbacks. An existing KOL is not rejected merely as a duplicate
when the current Campaign Product is new for that KOL.

### Campaign KOL Product

`campaign_kol_products` stores the product-level cooperation record after human
approval:

- `id`
- `campaign_kol_id`
- `campaign_product_id`
- `source_raw_candidate_product_fit_id`
- `fit_score`
- `fit_status`
- `evidence_summary`
- `assignment_status`
- `quoted_fee`
- `sample_status`
- `deliverables`
- `content_status`
- `result_summary`
- timestamps

`campaign_kol_id + campaign_product_id` is unique. The referenced Campaign KOL
and Campaign Product must belong to the same Campaign.

The existing `campaign_kols` row remains the shared project-level workflow for
contact, negotiation, contract, risk, and overall cooperation. A single
Campaign KOL may own any number of Campaign KOL Product records.

## Relationship Summary

```text
Product --< Campaign Product >-- Campaign
                              |
                              +-- Strategy --< Finder Task
                              |                  |
                              |                  +-- Raw Candidate Product Fit
                              |
KOL Master --< Campaign KOL --+-- Campaign KOL Product
```

The three deduplication boundaries are:

- global identity: platform account/profile across the whole system;
- Campaign cooperation: Campaign plus KOL/platform account;
- product cooperation: Campaign KOL plus Campaign Product.

## Finder Data Flow

```text
Select active Campaign Product
-> select or create its published Strategy
-> run one product-scoped Finder Task
-> discover target-platform video evidence
-> analyze evidence against Product and Campaign Brief
-> resolve the creator against KOL Master and current Campaign
-> add relevant history and risk context when identity exists
-> create or update Raw Candidate Product Fit
-> human approval
-> create or reuse KOL Master
-> create or reuse Campaign KOL
-> create or update Campaign KOL Product
```

Finder never automatically scans the entire KOL Master. Existing KOL context is
loaded only after normal evidence discovery identifies that creator.

The AI evaluation input contains:

- Campaign context;
- global Product facts;
- Campaign Product brief and role;
- the published Strategy;
- current target-platform video evidence;
- existing cooperation and risk summary when identity resolution succeeds.

AI output ranks and recommends candidates. It cannot approve a Raw Candidate,
overwrite a human decision, or bypass the video-evidence pipeline.

## User Experience

### Campaign

Campaign becomes the project container. Its detail view shows:

- market and project status;
- total associated Product count;
- active Product count;
- Product role, priority, brief, and status;
- Campaign KOL count.

Users can add an existing Product, create and add a Product, edit the Campaign
Product context, or archive the association.

### Product

A global Product page supports create, edit, archive, and Campaign history. It
does not include the deferred budget and ROI features.

### Strategy

New Strategy creation requires this sequence:

```text
Campaign -> active Campaign Product -> product-scoped Strategy
```

### Finder

The run confirmation always displays Campaign, Product, Strategy, and target
platform. The caller cannot substitute a different Product after selecting a
Strategy.

### Raw Candidates

The list and detail views show:

- Campaign and Product;
- identity status;
- current Product fit score and evidence;
- whether the KOL already exists globally or in the current Campaign;
- other Products already associated with the same Campaign KOL.

Approval reuses existing identities and Campaign workflows when possible, then
creates or updates the product cooperation record.

### Campaign KOL

The Campaign KOL detail view keeps shared cooperation fields once and displays
one independent Product assignment section per Campaign Product.

## API Responsibilities

The server adds or extends these resource groups:

- `/api/products`: list, create, update, and archive global Products;
- `/api/campaigns/:id/products`: list, attach, update, and archive Campaign
  Products;
- `/api/kol-strategies`: validate and persist `campaign_product_id`;
- `/api/finder-tasks`: inherit and enforce the Strategy Product binding;
- `/api/raw-candidates`: return Product fits and create the product cooperation
  record during approval;
- `/api/campaigns/:id/kols`: return Product assignments for each Campaign KOL.

Resource ownership and cross-Campaign constraints are validated server-side,
not only in the client.

## Migration and Backward Compatibility

The migration is additive:

1. Create `products`, `campaign_products`, `raw_candidate_product_fits`, and
   `campaign_kol_products`.
2. Add nullable `campaign_product_id` columns to `kol_strategies` and
   `finder_tasks`.
3. For a Campaign with a meaningful legacy `campaigns.product`, create or reuse
   one compatibility Product and attach it to that Campaign.
4. Bind a legacy Strategy only when the Campaign and product name identify one
   Campaign Product unambiguously.
5. Leave ambiguous records unbound and expose `legacy_unassigned` in normalized
   API responses.

The migration does not delete, rename, or overwrite existing Campaign,
Strategy, Finder Task, Raw Candidate, KOL, evidence, or cooperation records.
Legacy `campaigns.product` and `kol_strategies.product` remain readable during
the compatibility period.

Archive behavior protects historical data:

- referenced Products and Campaign Products are archived instead of deleted;
- archived relationships remain visible in historical views;
- paused, completed, and archived Campaign Products cannot start a new Finder;
- completed Finder and evidence records remain unchanged.

## Error Handling and Integrity

The API rejects:

- duplicate Product attachment to the same Campaign;
- a Strategy bound to a Campaign Product from another Campaign;
- a Finder Task whose Product differs from its Strategy;
- a new Finder Task for a non-active Campaign Product;
- a Campaign KOL Product whose two parent records belong to different
  Campaigns;
- physical deletion of referenced Products or Campaign Products.

Repeated discovery of an existing KOL is handled as identity reuse, not an
error. Repeated discovery for the same Campaign Product merges evidence while
preserving human decisions and execution status.

## Testing

Backend contract and route tests cover:

- Product reuse across Campaigns;
- uniqueness of Campaign plus Product;
- Strategy and Campaign Product ownership validation;
- Finder inheritance and non-active Product rejection;
- new-KOL approval creating all required relationships;
- existing-KOL approval reusing global and Campaign identities;
- one KOL associating with multiple Campaign Products;
- uniqueness of Campaign KOL plus Campaign Product;
- repeated evidence updating product fit without overwriting human status;
- legacy reads and unambiguous migration backfill;
- migration preservation of existing data.

Frontend tests and production build cover Campaign Product selection, dynamic
Product counts, Product-scoped Strategy/Finder context, identity labels, and
multiple Product assignments on Campaign KOL details.

Final verification requires focused red-green tests, the full server test suite,
the client production build, and `git diff --check`.

## Out of Scope

- Campaign and Product budget planning;
- expense allocation, commissions, sales attribution, and ROI;
- automatic scanning or rescoring of the full KOL Master;
- multi-product Finder Tasks or Strategies;
- automatic candidate approval;
- removal of legacy compatibility columns;
- unrelated Finder provider or discovery-route changes.
