# Restricted Agent Campaign API

All endpoints require the configured External Agent API token:

```http
Authorization: Bearer <token>
```

Tokens in query strings, request bodies, and `x-agent-token` are intentionally rejected.
The API can search KOL Master, add campaign candidates, and create `pending_review`
email drafts. It does not expose approval, send, delete, or Feishu sync operations.

## Search KOL Master

```http
GET /api/agent/campaigns/:campaignId/kol-master/search
  ?platform=youtube
  &min_avg_views_30d=19191
  &min_median_views_30d=19191
  &metric_mode=any
  &exclude_in_campaign=true
  &page=1
  &page_size=50
```

`metric_mode=any` means either threshold may match. `all` requires both.
The default is to exclude KOLs already in the campaign and KOLs marked
`do_not_contact`.

YouTube searches accept `min_avg_views_30d`, `min_median_views_30d`, and
optional `min_followers`. Instagram and TikTok KOL Master records do not yet
store view metrics, so those platforms require `min_followers` instead:

```http
GET /api/agent/campaigns/:campaignId/kol-master/search
  ?platform=instagram
  &min_followers=10000
```

Passing a view threshold for Instagram or TikTok returns HTTP 400 rather than
silently filtering by YouTube metrics. Search results include the normalized
`platform`, `platform_url`, and the platform-specific `followers` value.

## Preview or add candidates

```http
POST /api/agent/campaigns/:campaignId/candidate-pool/batch
Content-Type: application/json

{
  "idempotency_key": "tmb1401-candidates-20260728-01",
  "dry_run": true,
  "items": [
    {
      "customer_id": 123,
      "cooperation_platforms": ["youtube"],
      "priority": "t2",
      "recommendation_note": "Views and product fit verified"
    }
  ]
}
```

Use `dry_run: true` for a read-only preview. Remove it or set it to `false`
to write. A write request requires an idempotency key. Reusing the same key
and request returns the stored response; reusing the key with changed content
returns HTTP 409. The maximum batch size is 100.

## Validate or upsert first-contact drafts

```http
POST /api/agent/campaigns/:campaignId/email-drafts/batch-upsert
Content-Type: application/json

{
  "idempotency_key": "tmb1401-first-touch-20260728-01",
  "validate_only": true,
  "kind": "first_touch",
  "drafts": [
    {
      "customer_id": 123,
      "subject": "TMB-1401 collaboration",
      "body_text": "..."
    }
  ]
}
```

Only KOLs in the campaign candidate pool are accepted. New drafts are created
as `pending_review`; only existing `pending_review` drafts may be updated.
Approved, rejected, sent, and failed drafts are protected. The API never sends
mail. The maximum batch size is 50.

## Verify drafts

```http
GET /api/agent/campaigns/:campaignId/email-drafts
  ?kind=first_touch
  &status=pending_review
  &customer_id=123
```

The response intentionally omits recipient addresses and message bodies. It
returns state, subject, timestamps, and a content hash for verification.

## Audit and idempotency

Every mutation is recorded in `agent_api_requests` with operation, campaign,
request hash, stored response, and timestamps. Tokens and email bodies are not
stored in this table.
