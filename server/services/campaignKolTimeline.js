const { dbOperations } = require('../database');

const INTENT_TO_OUTREACH = Object.freeze({
  interested: 'interested',
  question: 'negotiating',
  unclear: 'negotiating',
  rejected: 'terminated'
});

const CONFIRMED_INTENTS = new Set(Object.keys(INTENT_TO_OUTREACH));

function normalizeConfirmedIntent(value, fallback = 'unclear') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'other') return 'unclear';
  return CONFIRMED_INTENTS.has(normalized) ? normalized : fallback;
}

function outreachForIntent(intent) {
  return INTENT_TO_OUTREACH[normalizeConfirmedIntent(intent)] || 'negotiating';
}

async function appendEvent({ campaignKol, eventType, occurredAt, summary, sourceType, sourceId,
  aiIntent, confirmedIntent, outreachStatus, actor = 'boss' }) {
  const result = await dbOperations.run(
    `INSERT INTO campaign_kol_events
       (campaign_kol_id, campaign_id, customer_id, event_type, occurred_at, summary,
        source_type, source_id, ai_intent, confirmed_intent, outreach_status,
        previous_outreach_status, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [campaignKol.id, campaignKol.campaign_id, campaignKol.customer_id, eventType,
      occurredAt || new Date(), summary || null, sourceType || null, sourceId || null,
      aiIntent || null, confirmedIntent || null, outreachStatus || null,
      campaignKol.outreach_status || null, actor]
  );
  return result.id;
}

async function applyLatestStatus(campaignKolId) {
  const current = await dbOperations.get(
    'SELECT pipeline_stage, outreach_status FROM campaign_kols WHERE id = ?',
    [campaignKolId]
  );
  // Once cooperation has been explicitly confirmed, an inbound email may add
  // context to the timeline but must not move the relationship back to a
  // candidate outreach phase.
  if (current?.pipeline_stage === 'confirmed' || current?.outreach_status === 'confirmed') {
    return current.outreach_status || 'confirmed';
  }
  const latest = await dbOperations.get(
    `SELECT outreach_status, summary
     FROM campaign_kol_events
     WHERE campaign_kol_id = ? AND outreach_status IS NOT NULL
     ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [campaignKolId]
  );
  if (!latest) return null;
  await dbOperations.run(
    `UPDATE campaign_kols SET outreach_status = ?, last_reply_summary = ?,
       sync_status = 'sync_pending', updated_at = NOW() WHERE id = ?`,
    [latest.outreach_status, latest.summary || null, campaignKolId]
  );
  return latest.outreach_status;
}

module.exports = {
  INTENT_TO_OUTREACH,
  CONFIRMED_INTENTS,
  normalizeConfirmedIntent,
  outreachForIntent,
  appendEvent,
  applyLatestStatus
};
