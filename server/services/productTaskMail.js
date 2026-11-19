const crypto = require('crypto');
const { id, ids } = require('./productTaskService');
const { htmlToText } = require('./emailBodyParser');
const VERSION = 'product-task-template-v1';
const { REPLY_SCOPE_JOIN } = require('./taskReplyScope');
const fail = (message, code = 400) => { const error = new Error(message); error.statusCode = code; throw error; };
function render(text, variables) {
  return String(text || '').replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key) || !variables[key]) fail(`模板变量 ${key} 缺少值`);
    return variables[key];
  });
}
function createProductTaskMail({ sequelize, models: M }) {
  const select = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: 'SELECT', logging: false });
  async function compose(campaignId, input, actorId, transaction) {
    if (input.allow_repeat !== undefined && typeof input.allow_repeat !== 'boolean') fail('重复触达选项必须是布尔值');
    const memberIds = ids(input.member_ids);
    const campaign = await M.Campaign.findByPk(id(campaignId), { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!campaign || campaign.status !== 'active' || campaign.campaign_type !== 'active_project') fail('项目不存在或未处于进行中');
    const [template] = await select("SELECT id, name, kind, subject, body_html FROM email_templates WHERE id=? AND kind='fixed'", [id(input.template_id)], transaction);
    if (!template) fail('请选择固定内容模板；写作规范不作为开发信直接发送');
    const [mailbox] = await select('SELECT id, sender_name FROM email_settings WHERE id=? AND owner_user_id=? AND enabled=1', [id(input.mailbox_id), id(actorId)], transaction);
    if (!mailbox) fail('发件邮箱不存在、已停用或不属于当前用户', 403);
    const rows = await select(`SELECT kt.id, kt.task_id, kt.review_status, kt.cooperation_status, t.name task_name, t.task_type,
      t.status task_status, t.publish_from, t.publish_due_at, ck.customer_id, c.name kol_name, c.contact_name,
      c.email, c.cooperation_status global_status FROM campaign_kol_tasks kt JOIN campaign_tasks t ON t.id=kt.task_id
      JOIN campaign_kols ck ON ck.id=kt.campaign_kol_id JOIN customers c ON c.id=ck.customer_id
      WHERE kt.id IN (${memberIds.map(() => '?').join(',')}) AND t.campaign_id=? AND ck.campaign_id=t.campaign_id ORDER BY kt.id`, [...memberIds, id(campaignId)], transaction);
    if (rows.length !== memberIds.length) fail('所选达人任务不全部属于当前项目');
    const products = await select(`SELECT tp.task_id, p.id product_id, p.sku, p.name, p.product_url
      FROM campaign_task_products tp JOIN campaign_tasks t ON t.id=tp.task_id
      JOIN campaign_products cp ON cp.id=tp.campaign_product_id JOIN products p ON p.id=cp.product_id
      WHERE t.campaign_id=? ORDER BY tp.id`, [id(campaignId)], transaction);
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.customer_id)) groups.set(row.customer_id, []);
      groups.get(row.customer_id).push(row);
    }
    const recipients = [];
    for (const group of groups.values()) {
      const customer = group[0];
      const reasons = [];
      if (!customer.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) reasons.push('缺少有效邮箱');
      if (customer.global_status === 'do_not_contact') reasons.push('全局不建议合作');
      if (group.some((m) => m.review_status !== 'approved' || m.task_status !== 'active' || m.cooperation_status === 'cancelled')) reasons.push('任务未审核通过、已暂停或合作已取消');
      if (group.some((m) => m.task_type === 'delivery_follow_up')) reasons.push('历史催交付任务请沿用原合作会话，不发送首次开发信');
      const [bounce] = await select("SELECT id FROM email_bounces WHERE bounce_type='hard' AND (customer_id=? OR LOWER(recipient)=LOWER(?)) LIMIT 1", [customer.customer_id, customer.email || ''], transaction);
      if (bounce) reasons.push('该达人或邮箱有硬退信记录');
      const [pending] = await select(`SELECT d.id,d.owner_user_id FROM email_drafts d WHERE d.campaign_id=? AND d.customer_id=?
        AND d.status IN ('pending_review','approved','sending','send_unknown') LIMIT 1`, [id(campaignId), customer.customer_id], transaction);
      if (pending) reasons.push(Number(pending.owner_user_id) === id(actorId)
        ? `已有待处理邮件 #${pending.id}，请先到邮件中心处理`
        : '团队已有待处理的联系邮件，请先协调负责人');
      const [recent] = await select(`SELECT er.id FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id
        JOIN campaign_kol_tasks kt ON kt.id=l.kol_task_id WHERE kt.id IN (${group.map(() => '?').join(',')})
        AND er.status='success' AND er.created_at>=DATE_SUB(NOW(), INTERVAL 14 DAY) LIMIT 1`, group.map((m) => m.id), transaction);
      if (recent && !input.allow_repeat) reasons.push('14天内已触达所选任务，默认排除');
      const snapshots = group.map((m) => ({ member_id: m.id, task_id: m.task_id, name: m.task_name,
        publish_from: m.publish_from, publish_due_at: m.publish_due_at,
        products: products.filter((p) => p.task_id === m.task_id) }));
      const allProducts = [...new Map(snapshots.flatMap((s) => s.products).map((p) => [p.product_id, p])).values()];
      const variables = { kol_name: customer.kol_name, contact_name: customer.contact_name || customer.kol_name,
        campaign_name: campaign.name, brand: campaign.brand, sender_name: mailbox.sender_name,
        product_names: allProducts.map((p) => p.name).join(', '), skus: allProducts.map((p) => p.sku).filter(Boolean).join(', '),
        product_links: allProducts.map((p) => p.product_url).filter(Boolean).join('\n'),
        task_schedule: snapshots.map((s) => `${s.name}: ${s.publish_from || '?'} - ${s.publish_due_at || '?'}`).join('\n'),
        cooperation_type: 'Product collaboration' };
      let subject = ''; let body = '';
      try {
        subject = render(template.subject, variables);
        body = render(htmlToText(template.body_html), variables);
        if (!subject.trim() || subject.length > 500 || !body.trim() || body.length > 30000) fail('模板主题或正文为空或超长');
      } catch (error) { reasons.push(error.message); }
      recipients.push({ customer_id: customer.customer_id, name: customer.kol_name, email: customer.email,
        member_ids: group.map((m) => m.id), snapshots, subject, body_text: body, blocked_reasons: reasons,
        repeat_warning: !!recent, product_context: snapshots.map((s) => `${s.name}\n${s.products.map((p) => `${p.sku || ''} ${p.name}`).join('\n')}\nPublish: ${s.publish_from || '?'} - ${s.publish_due_at || '?'}`).join('\n\n') });
    }
    const previewHash = crypto.createHash('sha256').update(JSON.stringify(recipients.map((r) => ({
      customer_id: r.customer_id, email: r.email, subject: r.subject, body_text: r.body_text, snapshots: r.snapshots
    })))).digest('hex');
    return { recipients, template_id: template.id, template_name: template.name, mailbox_id: mailbox.id, preview_hash: previewHash };
  }
  async function createDrafts(campaignId, input, actorId) {
    if (typeof input.request_key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(input.request_key)) fail('缺少有效的批次标识');
    if (typeof input.preview_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.preview_hash)) fail('请先预览邮件');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ member_ids: ids(input.member_ids).sort((a, b) => a - b),
      template_id: id(input.template_id), mailbox_id: id(input.mailbox_id), allow_repeat: input.allow_repeat === true, preview_hash: input.preview_hash })).digest('hex');
    return sequelize.transaction(async (transaction) => {
      // Serializes competing batches in this project, including idempotent retries.
      const campaign = await M.Campaign.findByPk(id(campaignId), { transaction, lock: transaction.LOCK.UPDATE });
      if (!campaign) fail('项目不存在', 404);
      const prefix = `task:${id(actorId)}:${id(campaignId)}:${input.request_key}:`;
      const existing = await select('SELECT id, evidence, status FROM email_drafts WHERE owner_user_id=? AND campaign_id=? AND LEFT(dedupe_key,?)=?', [id(actorId), id(campaignId), prefix.length, prefix], transaction);
      if (existing.length) {
        if (existing.some((d) => JSON.parse(d.evidence || '{}').request_hash !== fingerprint)) fail('同一批次的请求内容发生变化，请重新预览', 409);
        return { drafts: existing.map((d) => ({ id: d.id, status: d.status })), reused: true };
      }
      const preview = await compose(campaignId, input, actorId, transaction);
      if (preview.preview_hash !== input.preview_hash) fail('模板、达人资料或任务排期已变化，请重新预览', 409);
      const drafts = [];
      const skipped = preview.recipients.filter((r) => r.blocked_reasons.length).map((r) => ({ customer_id: r.customer_id, name: r.name, reasons: r.blocked_reasons }));
      for (const recipient of preview.recipients.filter((r) => !r.blocked_reasons.length)) {
        const dedupeKey = `${prefix}${recipient.customer_id}`;
        const evidence = JSON.stringify({ request_hash: fingerprint, product_context: recipient.product_context,
          recipient_email: recipient.email,
          product_task_ids: recipient.member_ids, template_name: preview.template_name, task_snapshots: recipient.snapshots });
        await sequelize.query(`INSERT INTO email_drafts (campaign_id, customer_id, kind, subject, body_text, status,
          risk_level, risk_reasons, evidence, template_id, prompt_version, dedupe_key, mailbox_id, owner_user_id,
          generated_at, created_at, updated_at) VALUES (?,?,'first_touch',?,?,'pending_review','low',?,?,?,?,?,?,?,NOW(),NOW(),NOW())`,
        { transaction, logging: false, replacements: [id(campaignId), recipient.customer_id, recipient.subject, recipient.body_text,
          JSON.stringify([{ code: 'TASK_TEMPLATE', message: '固定模板开发信，请核对各产品与独立排期' }]), evidence, preview.template_id,
          VERSION, dedupeKey, preview.mailbox_id, id(actorId)] });
        const [draft] = await select('SELECT id, status FROM email_drafts WHERE dedupe_key=?', [dedupeKey], transaction);
        await M.EmailTaskLink.bulkCreate(recipient.snapshots.map((snapshot) => ({ draft_id: draft.id, kol_task_id: snapshot.member_id, snapshot: JSON.stringify(snapshot) })), { transaction });
        drafts.push({ ...draft, name: recipient.name });
      }
      return { drafts, skipped, reused: false };
    });
  }
  return { preview: compose, createDrafts };
}

// Recheck just before SMTP; a draft is not permission to ignore later task/risk changes.
async function validateTaskDraftForSend(draft, db) {
  if (![VERSION, 'product-task-reply-v1'].includes(draft.prompt_version)) return;
  const evidence = JSON.parse(draft.evidence || '{}');
  const customer = await db.get('SELECT email FROM customers WHERE id=?', [draft.customer_id]);
  if (!evidence.recipient_email || customer?.email !== evidence.recipient_email) fail('达人邮箱与预览不一致，请重新起草', 409);
  const rows = await db.query(`SELECT kt.review_status, kt.cooperation_status, t.status task_status,
    t.campaign_id, ck.customer_id, c.status campaign_status, c.campaign_type, k.cooperation_status global_status
    FROM email_task_links l JOIN campaign_kol_tasks kt ON kt.id=l.kol_task_id JOIN campaign_tasks t ON t.id=kt.task_id
    JOIN campaign_kols ck ON ck.id=kt.campaign_kol_id JOIN campaigns c ON c.id=t.campaign_id
    JOIN customers k ON k.id=ck.customer_id WHERE l.draft_id=?`, [draft.id]);
  if (!rows.length || rows.some((r) => Number(r.campaign_id) !== Number(draft.campaign_id) || Number(r.customer_id) !== Number(draft.customer_id)
    || r.review_status !== 'approved' || r.cooperation_status === 'cancelled' || r.task_status !== 'active'
    || r.campaign_status !== 'active' || r.campaign_type !== 'active_project' || r.global_status === 'do_not_contact')) fail('任务范围、审核或合作状态已变化，请重新检查邮件', 409);
  const bounce = await db.get(`SELECT id FROM email_bounces
    WHERE bounce_type='hard' AND (customer_id=? OR LOWER(recipient)=LOWER(?)) LIMIT 1`, [draft.customer_id, customer.email]);
  if (bounce) fail('该邮箱有硬退信记录，不能发送', 409);
}
async function inheritReplyTaskLinks(draft, reply, db) {
  if (!reply?.thread_id) return;
  const links = await db.query(`SELECT l.kol_task_id, l.snapshot, d.evidence FROM email_task_links l
    JOIN email_records er ON er.draft_id=l.draft_id JOIN email_drafts d ON d.id=er.draft_id
    JOIN email_replies r ON ${REPLY_SCOPE_JOIN}
    WHERE r.id=? AND er.owner_user_id=? AND er.campaign_id=? AND er.customer_id=? AND er.status='success'`,
  [reply.id, draft.owner_user_id, draft.campaign_id, draft.customer_id]);
  if (!links.length) return;
  for (const link of links) await db.run(`INSERT IGNORE INTO email_task_links
    (draft_id,kol_task_id,snapshot,created_at,updated_at) VALUES (?,?,?,NOW(),NOW())`, [draft.id, link.kol_task_id, link.snapshot]);
  const original = JSON.parse(links[0].evidence || '{}');
  const evidence = { ...JSON.parse(draft.evidence || '{}'), product_task_ids: links.map((l) => l.kol_task_id),
    recipient_email: original.recipient_email, task_snapshots: links.map((l) => JSON.parse(l.snapshot)) };
  draft.prompt_version = 'product-task-reply-v1'; draft.evidence = JSON.stringify(evidence);
  await db.run('UPDATE email_drafts SET prompt_version=?, evidence=? WHERE id=?', [draft.prompt_version, draft.evidence, draft.id]);
}
module.exports = { createProductTaskMail, validateTaskDraftForSend, inheritReplyTaskLinks, render, VERSION };
