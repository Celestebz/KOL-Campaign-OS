const { REPLY_SCOPE_JOIN } = require('./taskReplyScope');
const fail = (message, statusCode = 400) => { const error = new Error(message); error.statusCode = statusCode; throw error; };
const plain = (row) => row?.get ? row.get({ plain: true }) : row;
const id = (value) => {
  if (!/^[1-9]\d*$/.test(String(value))) fail('ID必须是正整数');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > 2147483647) fail('ID超出范围');
  return result;
};
const ids = (values) => {
  if (!Array.isArray(values) || !values.length || values.length > 100) fail('请选择1至100项');
  return [...new Set(values.map(id))];
};
const choices = {
  task_type: ['recruitment', 'delivery_follow_up'], status: ['active', 'paused', 'completed', 'archived'],
  review_status: ['pending', 'approved', 'rejected'],
  cooperation_status: ['candidate', 'negotiating', 'confirmed', 'shipped', 'producing', 'published', 'completed', 'cancelled'],
  intent: ['unknown', 'interested', 'question', 'rejected']
};
const taskFields = ['name', 'task_type', 'status', 'priority', 'owner', 'approval_due_at', 'publish_from', 'publish_due_at', 'sample_min', 'sample_max', 'candidate_target', 'requirements'];
const memberFields = ['review_status', 'cooperation_status', 'intent', 'next_follow_up_at', 'agreed_publish_at', 'received_at', 'draft_due_at', 'published_at', 'video_url', 'quoted_fee', 'notes'];
function validate(input, fields, current = {}) {
  const result = {};
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    let value = input[key];
    if (choices[key]) {
      if (!choices[key].includes(value)) fail(`无效的${key}`);
    } else if (['priority', 'sample_min', 'sample_max', 'candidate_target'].includes(key)) {
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1000000)) fail(`${key}必须是非负整数`);
      if (key === 'priority' && value === null) fail('优先级不可为空');
    } else if (key.endsWith('_at') || ['publish_from'].includes(key)) {
      if (value !== null) {
        const dateOnly = key !== 'next_follow_up_at';
        if (typeof value !== 'string' || (dateOnly && !/^\d{4}-\d{2}-\d{2}$/.test(value))
          || !Number.isFinite(Date.parse(value)) || (dateOnly && new Date(value).toISOString().slice(0, 10) !== value)) fail(`${key}日期无效`);
        value = dateOnly ? value : new Date(value);
      }
    } else {
      if (value !== null && typeof value !== 'string') fail(`${key}必须是文本`);
      value = value?.trim() || null;
      const limit = ['notes', 'requirements'].includes(key) ? 20000 : key === 'video_url' ? 2048 : 255;
      if (value && value.length > limit) fail(`${key}内容过长`);
      if (key === 'name' && !value) fail('请填写任务名称');
      if (key === 'video_url' && value && !/^https?:\/\//i.test(value)) fail('作品链接必须为http或https地址');
    }
    result[key] = value;
  }
  const merged = { ...current, ...result };
  if (merged.publish_from && merged.publish_due_at && merged.publish_from > merged.publish_due_at) fail('发布开始日期不能晚于截止日期');
  if (merged.sample_min != null && merged.sample_max != null && merged.sample_min > merged.sample_max) fail('送测数量下限不能大于上限');
  if (merged.cooperation_status && !['candidate', 'cancelled'].includes(merged.cooperation_status) && merged.review_status !== 'approved') fail('请先审核通过该任务，再推进合作');
  if (['published', 'completed'].includes(merged.cooperation_status) && (!merged.video_url || !merged.published_at)) fail('完成交付需要作品链接及实际发布日期');
  return result;
}

function createProductTaskService({ models: M, sequelize }) {
  const query = (sql, replacements = [], transaction) => sequelize.query(sql, { replacements, transaction, type: 'SELECT', logging: false });
  async function campaign(campaignId, transaction, writing = false) {
    const row = await M.Campaign.findByPk(id(campaignId), { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) fail('项目不存在', 404);
    if (writing && (row.status !== 'active' || row.campaign_type !== 'active_project')) fail('只能修改进行中的当前项目任务', 409);
    return row;
  }
  async function task(campaignId, taskId, transaction, writing = false) {
    await campaign(campaignId, transaction, writing);
    const row = await M.CampaignTask.findOne({ where: { id: id(taskId), campaign_id: id(campaignId) }, transaction });
    if (!row) fail('项目下未找到该任务', 404);
    return row;
  }
  async function products(campaignId, productIds, transaction) {
    const values = ids(productIds);
    for (const value of values) {
      const cp = await M.CampaignProduct.findOne({ where: { id: value, campaign_id: id(campaignId) }, transaction });
      if (!cp || cp.status !== 'active') fail('任务产品必须属于当前项目且处于启用状态');
      const product = await M.Product.findByPk(cp.product_id, { transaction });
      if (!product || product.status !== 'active') fail('任务包含不可用的产品');
    }
    return values;
  }
  async function saveTask(campaignId, taskId, input, existingTransaction = null) {
    const persist = async (transaction) => {
      const current = taskId ? await task(campaignId, taskId, transaction, true) : (await campaign(campaignId, transaction, true), null);
      const data = validate(input, taskFields, plain(current));
      if (!current && !data.name) fail('请填写任务名称');
      const productIds = input.campaign_product_ids === undefined && current ? null : await products(campaignId, input.campaign_product_ids, transaction);
      if (current && productIds) {
        const old = await M.CampaignTaskProduct.findAll({ where: { task_id: current.id }, transaction });
        const changed = JSON.stringify(old.map((p) => p.campaign_product_id).sort()) !== JSON.stringify([...productIds].sort());
        if (changed && await M.CampaignKolTask.count({ where: { task_id: current.id }, transaction })) fail('已有达人参与的任务不能更换产品，请新建任务', 409);
      }
      const saved = current ? await current.update(data, { transaction }) : await M.CampaignTask.create({ ...data, campaign_id: id(campaignId) }, { transaction });
      if (productIds) {
        await M.CampaignTaskProduct.destroy({ where: { task_id: saved.id }, transaction });
        await M.CampaignTaskProduct.bulkCreate(productIds.map((value) => ({ task_id: saved.id, campaign_product_id: value })), { transaction });
      }
      return plain(saved);
    };
    return existingTransaction ? persist(existingTransaction) : sequelize.transaction(persist);
  }
  async function addMembers(campaignId, input, actorId) {
    // Explicit pairs prevent blindly assigning every selected product to every creator.
    if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 200) fail('请选择1至200组达人与任务');
    const assignments = input.assignments.map((item) => ({ customer_id: id(item.customer_id), task_id: id(item.task_id) }));
    return sequelize.transaction(async (transaction) => {
      await campaign(campaignId, transaction, true);
      const results = [];
      for (const assignment of assignments) {
        const target = await task(campaignId, assignment.task_id, transaction);
        if (target.status !== 'active') fail('只能加入启用中的任务', 409);
        const customer = await M.Customer.findByPk(assignment.customer_id, { transaction });
        if (!customer) fail('达人不存在', 404);
        if (customer.cooperation_status === 'do_not_contact') fail('该达人已被全局标记为不建议合作', 409);
        let ck = await M.CampaignKol.findOne({ where: { campaign_id: id(campaignId), customer_id: customer.id }, order: [['id', 'ASC']], transaction });
        if (!ck) ck = await M.CampaignKol.create({ campaign_id: id(campaignId), customer_id: customer.id,
          source: 'kol_master_task', pipeline_stage: 'candidate', outreach_status: 'not_contacted',
          kol_name_snapshot: customer.name, email_snapshot: customer.email, youtube_url_snapshot: customer.youtube_url,
          instagram_url_snapshot: customer.instagram_url, tiktok_url_snapshot: customer.tiktok_url,
          country_region_snapshot: customer.country_region }, { transaction });
        const [member, created] = await M.CampaignKolTask.findOrCreate({
          where: { task_id: target.id, campaign_kol_id: ck.id }, transaction,
          defaults: { review_status: 'pending', cooperation_status: 'candidate', intent: 'unknown' }
        });
        if (created) await M.CampaignTaskEvent.create({ kol_task_id: member.id, actor_id: actorId || null,
          event_type: 'added', summary: '从资源库加入任务，待审核', occurred_at: new Date() }, { transaction });
        results.push({ ...assignment, id: member.id, created });
      }
      return results;
    });
  }
  async function updateMember(campaignId, taskId, memberId, input, actorId) {
    return sequelize.transaction(async (transaction) => {
      await task(campaignId, taskId, transaction, true);
      const member = await M.CampaignKolTask.findOne({ where: { id: id(memberId), task_id: id(taskId) }, transaction });
      if (!member) fail('任务下未找到该达人', 404);
      const ck = await M.CampaignKol.findByPk(member.campaign_kol_id, { transaction });
      if (!ck || Number(ck.campaign_id) !== id(campaignId)) fail('达人与任务不属于同一项目', 409);
      const before = plain(member);
      const data = validate(input, memberFields, before);
      if (!Object.keys(data).length) fail('没有可修改的字段');
      await member.update(data, { transaction });
      await M.CampaignTaskEvent.create({ kol_task_id: member.id, actor_id: actorId || null, event_type: 'updated',
        summary: JSON.stringify({ before: Object.fromEntries(Object.keys(data).map((key) => [key, before[key] ?? null])), after: data }),
        occurred_at: new Date() }, { transaction });
      return plain(member);
    });
  }
  async function list(campaignId) {
    await campaign(campaignId);
    const tasks = (await M.CampaignTask.findAll({ where: { campaign_id: id(campaignId) }, order: [['priority', 'DESC'], ['publish_due_at', 'ASC'], ['id', 'ASC']] })).map(plain);
    const productRows = await query(`SELECT tp.task_id, cp.id campaign_product_id, p.id product_id, p.sku, p.name, p.category
      FROM campaign_task_products tp JOIN campaign_tasks t ON t.id=tp.task_id
      JOIN campaign_products cp ON cp.id=tp.campaign_product_id JOIN products p ON p.id=cp.product_id
      WHERE t.campaign_id=? ORDER BY tp.id`, [id(campaignId)]);
    const members = await membersForCampaign(campaignId);
    return tasks.map((item) => {
      const rows = members.filter((m) => m.task_id === item.id);
      const count = (predicate) => new Set(rows.filter(predicate).map((m) => m.customer_id)).size;
      return { ...item, products: productRows.filter((p) => p.task_id === item.id),
        counts: { candidates: count(() => true), approved: count((m) => m.review_status === 'approved'),
          contacted: count((m) => m.outreach_status !== 'contact_failed' && (m.last_sent_at || m.manual_contact_at)),
          cooperating: count((m) => ['confirmed', 'shipped', 'producing', 'published', 'completed'].includes(m.cooperation_status)),
          delivered: count((m) => ['published', 'completed'].includes(m.cooperation_status)) } };
    });
  }
  async function membersForCampaign(campaignId) {
    const rows = await query(`SELECT kt.*, t.name task_name, t.publish_due_at, ck.customer_id, c.name kol_name, c.email,
      (SELECT MAX(er.created_at) FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id
        WHERE l.kol_task_id=kt.id AND er.status='success') last_sent_at,
      (SELECT MAX(er.created_at) FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id
        WHERE l.kol_task_id=kt.id AND er.status='failed') last_failed_at,
      (SELECT MAX(r.received_at) FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id
        JOIN email_replies r ON ${REPLY_SCOPE_JOIN}
        WHERE l.kol_task_id=kt.id AND er.status='success' AND r.confirm_status NOT IN ('ignored','spam','system')
          AND COALESCE(r.classification,'kol_reply') NOT IN ('spam','system')) last_reply_at,
      (SELECT MAX(COALESCE(b.received_at,b.created_at)) FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id
        JOIN email_bounces b ON b.email_record_id=er.id WHERE l.kol_task_id=kt.id) last_bounce_at,
      (SELECT MAX(e.occurred_at) FROM campaign_task_events e WHERE e.kol_task_id=kt.id AND e.event_type='manual_contact') manual_contact_at
      FROM campaign_kol_tasks kt JOIN campaign_tasks t ON t.id=kt.task_id
      JOIN campaign_kols ck ON ck.id=kt.campaign_kol_id JOIN customers c ON c.id=ck.customer_id
      WHERE t.campaign_id=? AND ck.campaign_id=t.campaign_id ORDER BY kt.id`, [id(campaignId)]);
    return rows.map((row) => {
      const sent = Math.max(new Date(row.last_sent_at || 0).getTime(), new Date(row.manual_contact_at || 0).getTime());
      const failureTime = Math.max(new Date(row.last_bounce_at || 0).getTime(), new Date(row.last_failed_at || 0).getTime());
      const failed = failureTime > 0 && failureTime >= sent;
      return { ...row, outreach_status: row.last_reply_at && new Date(row.last_reply_at).getTime() >= Math.max(sent, failureTime) ? 'replied' : failed ? 'contact_failed' : sent ? 'waiting_reply' : 'not_contacted',
        follow_up_due: !!row.next_follow_up_at && new Date(row.next_follow_up_at) <= new Date() };
    });
  }
  async function members(campaignId) { await campaign(campaignId); return membersForCampaign(campaignId); }
  async function timeline(campaignId, taskId, memberId, actorId) {
    await task(campaignId, taskId);
    const member = await M.CampaignKolTask.findOne({ where: { id: id(memberId), task_id: id(taskId) } });
    if (!member) fail('任务达人不存在', 404);
    const events = (await M.CampaignTaskEvent.findAll({ where: { kol_task_id: member.id }, order: [['occurred_at', 'DESC']] })).map(plain);
    const mail = await query(`SELECT er.id, er.subject, er.body_text, er.to_address, er.status, er.created_at, l.snapshot
      FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id WHERE l.kol_task_id=? AND er.owner_user_id=? ORDER BY er.created_at DESC`, [member.id, id(actorId)]);
    const replies = await query(`SELECT DISTINCT r.id, r.subject, r.body_text, r.received_at
      FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id
      JOIN email_replies r ON ${REPLY_SCOPE_JOIN} WHERE l.kol_task_id=?
      AND er.owner_user_id=? AND r.owner_user_id=? AND r.confirm_status NOT IN ('ignored','spam','system')
      AND COALESCE(r.classification,'kol_reply') NOT IN ('spam','system') ORDER BY r.received_at DESC`, [member.id, id(actorId), id(actorId)]);
    const bounces = await query(`SELECT b.id,b.reason,b.bounce_type,COALESCE(b.received_at,b.created_at) received_at
      FROM email_task_links l JOIN email_records er ON er.draft_id=l.draft_id JOIN email_bounces b ON b.email_record_id=er.id
      WHERE l.kol_task_id=? AND er.owner_user_id=? ORDER BY b.received_at DESC`, [member.id, id(actorId)]);
    return { events, mail, replies, bounces };
  }
  async function manualContact(campaignId, taskId, memberId, input, actorId) {
    return sequelize.transaction(async (transaction) => {
      await task(campaignId, taskId, transaction, true);
      const member = await M.CampaignKolTask.findOne({ where: { id: id(memberId), task_id: id(taskId) }, transaction });
      if (!member) fail('任务达人不存在', 404);
      if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 5000) fail('请填写有效的联系摘要');
      return plain(await M.CampaignTaskEvent.create({ kol_task_id: member.id, actor_id: actorId || null,
        event_type: 'manual_contact', summary: input.summary.trim(), occurred_at: new Date() }, { transaction }));
    });
  }
  async function customerHistory(customerId) {
    if (!await M.Customer.findByPk(id(customerId))) fail('达人不存在', 404);
    return query(`SELECT kt.*, t.name task_name, t.publish_due_at, t.campaign_id, c.name campaign_name
      FROM campaign_kol_tasks kt JOIN campaign_tasks t ON t.id=kt.task_id
      JOIN campaign_kols ck ON ck.id=kt.campaign_kol_id JOIN campaigns c ON c.id=t.campaign_id
      WHERE ck.customer_id=? AND ck.campaign_id=t.campaign_id ORDER BY kt.updated_at DESC, kt.id DESC`, [id(customerId)]);
  }
  async function importTasks(campaignId, input) {
    if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 100) fail('每批请选择1至100条任务');
    return sequelize.transaction(async (transaction) => {
      await campaign(campaignId, transaction, true);
      const output = [];
      for (const row of input.rows) {
        const normalized = validate(row, taskFields);
        const productIds = ids(row.campaign_product_ids).sort((a, b) => a - b);
        const key = require('crypto').createHash('sha256').update(JSON.stringify({ ...normalized, campaign_product_ids: productIds })).digest('hex');
        const existing = await M.CampaignTask.findOne({ where: { campaign_id: id(campaignId), import_key: key }, transaction });
        if (existing) { output.push({ id: existing.id, created: false }); continue; }
        const saved = await saveTask(campaignId, null, { ...normalized, campaign_product_ids: productIds }, transaction);
        await M.CampaignTask.update({ import_key: key }, { where: { id: saved.id }, transaction });
        output.push({ id: saved.id, created: true });
      }
      return output;
    });
  }
  return { saveTask, addMembers, updateMember, list, members, timeline, manualContact, customerHistory, importTasks };
}
module.exports = { createProductTaskService, validate, id, ids, taskFields, memberFields };
