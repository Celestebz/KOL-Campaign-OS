const test = require('node:test');
const assert = require('node:assert/strict');

// Explicit opt-in only. Never imports server/index or database.initDatabase.
test('isolated MySQL: combinations, partial cooperation, email snapshots and retry safety', {
  skip: process.env.KOL_TASKS_TEST_MYSQL !== '1', timeout: 60000
}, async () => {
  const { Sequelize, DataTypes: D } = require('sequelize');
  const config = require('../config/database');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.host), 'test refuses non-loopback database hosts');
  const databaseName = `kol_task_test_${process.pid}_${Date.now()}`;
  assert.match(databaseName, /^kol_task_test_\d+_\d+$/);
  const admin = new Sequelize('', config.username, config.password, { ...config, database: undefined, logging: false });
  let s;
  let schemaCreated = false;
  try {
    await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`);
    schemaCreated = true;
    s = new Sequelize(databaseName, config.username, config.password, { ...config, database: databaseName, logging: false });
    const M = {};
    for (const name of ['Campaign', 'Customer', 'Product', 'CampaignProduct', 'CampaignKol', 'CampaignTask', 'CampaignTaskProduct', 'CampaignKolTask', 'CampaignTaskEvent', 'EmailTaskLink']) {
      M[name] = require(`../models/${name}`)(s, D);
    }
    // No associations are registered for the fixture: only the actual business
    // columns plus the new migration constraints are needed here.
    for (const name of ['Campaign', 'Customer', 'Product', 'CampaignProduct', 'CampaignKol']) await M[name].sync();
    const q = s.getQueryInterface();
    const integer = { type: D.INTEGER, primaryKey: true, autoIncrement: true };
    await q.createTable('email_drafts', { id: integer, campaign_id: D.INTEGER, customer_id: D.INTEGER, kind: D.STRING(20),
      subject: D.STRING(500), body_text: D.TEXT, status: D.STRING(30), risk_level: D.STRING(20), risk_reasons: D.TEXT,
      evidence: D.TEXT, template_id: D.INTEGER, prompt_version: D.STRING(50), dedupe_key: { type: D.STRING(255), unique: true },
      mailbox_id: D.INTEGER, owner_user_id: D.INTEGER, generated_at: D.DATE, created_at: D.DATE, updated_at: D.DATE });
    await q.createTable('email_templates', { id: integer, name: D.STRING(100), kind: D.STRING(30), subject: D.STRING(500), body_html: D.TEXT });
    await q.createTable('email_settings', { id: integer, owner_user_id: D.INTEGER, enabled: D.BOOLEAN, sender_name: D.STRING(100) });
    await q.createTable('email_bounces', { id: integer, customer_id: D.INTEGER, email_record_id: D.INTEGER, recipient: D.STRING(255), bounce_type: D.STRING(20), reason: D.TEXT, received_at: D.DATE, created_at: D.DATE });
    await q.createTable('email_records', { id: integer, draft_id: D.INTEGER, campaign_id: D.INTEGER, customer_id: D.INTEGER,
      subject: D.STRING(500), body_text: D.TEXT, to_address: D.STRING(255), status: D.STRING(30), owner_user_id: D.INTEGER, thread_id: D.INTEGER, smtp_message_id: D.STRING(255), created_at: D.DATE });
    await q.createTable('email_replies', { id: integer, email_record_id: D.INTEGER, thread_id: D.INTEGER, reply_to_message_id: D.STRING(255), classification: D.STRING(30), confirm_status: D.STRING(30), subject: D.STRING(500), body_text: D.TEXT, owner_user_id: D.INTEGER, received_at: D.DATE });
    const migration = require('../migrations/20261119000001-product-tasks');
    await migration.up(q, Sequelize);
    await migration.up(q, Sequelize); // safe to retry a completed additive migration
    const { createProductTaskService } = require('./productTaskService');
    const { createProductTaskMail, validateTaskDraftForSend, inheritReplyTaskLinks } = require('./productTaskMail');
    const dependencies = { models: M, sequelize: s };
    const service = createProductTaskService(dependencies);
    const mail = createProductTaskMail(dependencies);
    const campaign = await M.Campaign.create({ name: '冬季推广' });
    const other = await M.Campaign.create({ name: '其他项目' });
    const products = [];
    for (const [index, sku] of ['A', 'B'].entries()) {
      const p = await M.Product.create({ name: sku, sku, category: '工具', catalog_key_hash: `${index}`.padStart(64, '0') });
      products.push(await M.CampaignProduct.create({ campaign_id: campaign.id, product_id: p.id }));
    }
    const customer = await M.Customer.create({ name: 'Alice', email: 'alice@example.com' });
    const b = await service.saveTask(campaign.id, null, { name: '组合', campaign_product_ids: products.map((p) => p.id), publish_due_at: '2027-01-15' });
    const a = await service.saveTask(campaign.id, null, { name: 'A第二轮', campaign_product_ids: [products[0].id], publish_due_at: '2027-02-15' });
    const importRow = { name: '清单导入A', campaign_product_ids: [products[0].id], publish_due_at: '2027-03-01' };
    const imported = await service.importTasks(campaign.id, { rows: [importRow] });
    const repeatedImport = await service.importTasks(campaign.id, { rows: [importRow] });
    assert.equal(imported[0].id, repeatedImport[0].id);
    assert.equal(repeatedImport[0].created, false);
    const beforeBadImport = await M.CampaignTask.count();
    await assert.rejects(service.importTasks(campaign.id, { rows: [
      { name: '应回滚的任务', campaign_product_ids: [products[0].id] },
      { name: '坏行', campaign_product_ids: [999999] }
    ] }), /属于当前项目/);
    assert.equal(await M.CampaignTask.count(), beforeBadImport, 'batch import is atomic');
    await assert.rejects(service.saveTask(other.id, null, { name: '跨项目', campaign_product_ids: [products[0].id] }), /属于当前项目/);
    const pairs = [{ customer_id: customer.id, task_id: a.id }, { customer_id: customer.id, task_id: b.id }];
    const added = await service.addMembers(campaign.id, { assignments: pairs }, 1);
    assert.equal(await M.CampaignKol.count(), 1);
    assert.equal(await M.CampaignKolTask.count(), 2);
    await service.updateMember(campaign.id, a.id, added[0].id, { review_status: 'approved', cooperation_status: 'confirmed' }, 1);
    await service.addMembers(campaign.id, { assignments: pairs }, 1);
    assert.equal((await M.CampaignKolTask.findByPk(added[0].id)).cooperation_status, 'confirmed');
    assert.equal((await M.CampaignKolTask.findByPk(added[1].id)).cooperation_status, 'candidate');
    await assert.rejects(service.saveTask(campaign.id, b.id, { campaign_product_ids: [products[0].id] }), /不能更换产品/);
    const outsider = await M.Customer.create({ name: 'Bob' });
    await assert.rejects(service.addMembers(campaign.id, { assignments: [{ customer_id: outsider.id, task_id: a.id }, { customer_id: outsider.id, task_id: 99999 }] }, 1), /未找到/);
    assert.equal(await M.CampaignKol.count(), 1, 'failed batch rolls back even its earlier valid pair');
    await service.updateMember(campaign.id, b.id, added[1].id, { review_status: 'approved' }, 1);
    await s.query("INSERT INTO email_templates (name,kind,subject,body_html) VALUES ('邀请','fixed','Hi {{kol_name}}','<p>{{product_names}}</p><p>{{task_schedule}}</p>')");
    await s.query("INSERT INTO email_settings (owner_user_id,enabled,sender_name) VALUES (1,1,'Team')");
    const input = { member_ids: added.map((m) => m.id), mailbox_id: 1, template_id: 1 };
    await assert.rejects(mail.preview(campaign.id, input, 2), /不属于当前用户/);
    const preview = await mail.preview(campaign.id, input, 1);
    assert.equal(preview.recipients.length, 1);
    assert.equal(preview.recipients[0].snapshots.length, 2);
    assert.deepEqual(preview.recipients[0].blocked_reasons, []);
    const body = { ...input, request_key: 'test_batch_123456789', preview_hash: preview.preview_hash };
    const created = await mail.createDrafts(campaign.id, body, 1);
    assert.equal(created.drafts.length, 1);
    assert.equal(await M.EmailTaskLink.count(), 2);
    const replay = await mail.createDrafts(campaign.id, body, 1);
    assert.equal(replay.reused, true);
    assert.equal(replay.drafts[0].id, created.drafts[0].id);
    await s.query("INSERT INTO email_settings (owner_user_id,enabled,sender_name) VALUES (2,1,'Other Team Member')");
    const teammatePreview = await mail.preview(campaign.id, { ...input, mailbox_id: 2 }, 2);
    assert.ok(teammatePreview.recipients[0].blocked_reasons.includes('团队已有待处理的联系邮件，请先协调负责人'));
    await service.saveTask(campaign.id, a.id, { publish_due_at: '2027-03-15' });
    const links = await M.EmailTaskLink.findAll();
    assert.ok(links.some((l) => JSON.parse(l.snapshot).publish_due_at === '2027-02-15'), 'old mail keeps original deadline');
    const [drafts] = await s.query('SELECT * FROM email_drafts');
    const db = { query: (sql, params) => s.query(sql, { replacements: params, type: 'SELECT' }),
      get: async (sql, params) => (await s.query(sql, { replacements: params, type: 'SELECT' }))[0],
      run: async (sql, params) => { await s.query(sql, { replacements: params }); return { changes: 1 }; } };
    await validateTaskDraftForSend(drafts[0], db);
    const initial = await service.members(campaign.id);
    assert.ok(initial.every((m) => m.outreach_status === 'not_contacted'), 'draft creation is not contact');
    await s.query("INSERT INTO email_records (draft_id,campaign_id,customer_id,status,owner_user_id,thread_id,created_at) VALUES (?,?,?,'success',1,1,NOW())", { replacements: [drafts[0].id, campaign.id, customer.id] });
    await s.query("INSERT INTO email_replies (email_record_id,thread_id,confirm_status,owner_user_id,received_at) VALUES (1,1,'pending',1,DATE_ADD(NOW(),INTERVAL 1 SECOND))");
    const after = await service.members(campaign.id);
    assert.ok(after.every((m) => m.outreach_status === 'replied'));
    assert.ok(after.every((m) => m.intent === 'unknown'), 'reply does not mark every product interested');
    const summary = await service.list(campaign.id);
    assert.equal(summary.find((t) => t.id === a.id).counts.cooperating, 1);
    assert.equal(summary.find((t) => t.id === b.id).counts.cooperating, 0);
    const history = await service.timeline(campaign.id, a.id, added[0].id, 1);
    assert.equal(history.replies.length, 1);
    await s.query("INSERT INTO email_replies (email_record_id,thread_id,confirm_status,owner_user_id,received_at) VALUES (1,2,'pending',1,'2040-01-01')");
    assert.equal((await service.timeline(campaign.id, a.id, added[0].id, 1)).replies.length, 1, 'an address-based guess in another thread is not task evidence');
    assert.equal((await service.timeline(campaign.id, a.id, added[0].id, 2)).replies.length, 0, 'mail content stays private to its owner');
    await s.query("INSERT INTO email_drafts (campaign_id,customer_id,kind,evidence,owner_user_id) VALUES (?,?,'reply','{}',1)", { replacements: [campaign.id, customer.id] });
    const replyDraft = (await s.query("SELECT * FROM email_drafts WHERE kind='reply'", { type: 'SELECT' }))[0];
    await inheritReplyTaskLinks(replyDraft, { id: 1, thread_id: 1 }, db);
    assert.equal((await M.EmailTaskLink.findAll({ where: { draft_id: replyDraft.id } })).length, 2, 'a reply inherits just the source conversation task scope');
    await validateTaskDraftForSend(replyDraft, db);
    await s.query("INSERT INTO email_replies (thread_id,confirm_status,classification,owner_user_id,received_at) VALUES (1,'system','system',1,'2040-01-01')");
    assert.equal((await service.timeline(campaign.id, a.id, added[0].id, 1)).replies.length, 1, 'automatic replies are not creator replies');
    await s.query("UPDATE email_replies SET confirm_status='ignored' WHERE id=1");
    assert.ok((await service.members(campaign.id)).every((m) => m.outreach_status === 'waiting_reply'));
    await s.query("INSERT INTO email_bounces (customer_id,email_record_id,bounce_type,received_at) VALUES (?,1,'soft','2040-01-02')", { replacements: [customer.id] });
    assert.ok((await service.members(campaign.id)).every((m) => m.outreach_status === 'contact_failed'));
    assert.equal((await service.timeline(campaign.id, a.id, added[0].id, 1)).bounces.length, 1);
    await customer.update({ email: 'changed@example.com' });
    await assert.rejects(validateTaskDraftForSend(drafts[0], db), /邮箱与预览不一致/);
  } finally {
    if (s) await s.close();
    // Only the generated, validated disposable schema can be removed.
    if (schemaCreated) await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.close();
  }
});
