const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { randomBytes } = require('crypto');
const config = require('../config/database');
const { dbOperations: db } = require('../database');
const triage = require('./emailTriage');
const ai = require('./aiClient');
const live = require('./emailLiveSync');
const threader = require('./emailThreader');
const migration = require('../migrations/20261102000001-email-triage-todos');
const { runWithUser } = require('../utils/requestContext');
const mailer = require('./mailer');

test('MySQL isolated-table lifecycle: migration, unread intake, completion, duplicate, new reply, restore, retry',
  { skip: process.env.RUN_EMAIL_TRIAGE_DB_TESTS !== '1' }, async t => {
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.host), 'Integration test only permits a local database');
    // All mutations are rewritten to fresh prefixed fixture tables. Existing rows are never read or written.
    const sql = new Sequelize.Sequelize(config.database, config.username, config.password,
      { ...config, logging: false, pool: { max: 1, min: 1, idle: 60000 } });
    const tables = ['email_replies', 'email_records', 'customers', 'campaigns', 'campaign_kols', 'email_filter_rules', 'email_settings', 'email_drafts', 'email_draft_versions', 'approval_items'];
    const prefix = `mail_triage_test_${randomBytes(6).toString('hex')}_`;
    const created = [];
    const rewrite = query => query.replace(/\b(email_replies|email_records|customers|campaigns|campaign_kols|email_filter_rules|email_settings|email_drafts|email_draft_versions|approval_items)\b/g, name => prefix + name);
    const original = { ...db, ai: ai.callActiveAi, assign: threader.assignReplyThread, assignRecord: threader.assignRecordThread, send: mailer.sendMail };
    t.after(async () => {
      Object.assign(db, { query: original.query, get: original.get, run: original.run });
      ai.callActiveAi = original.ai; threader.assignReplyThread = original.assign;
      threader.assignRecordThread = original.assignRecord; mailer.sendMail = original.send;
      try {
        for (const table of created.reverse()) {
          assert.ok(table.startsWith(prefix));
          await sql.query(`DROP TABLE IF EXISTS ${table}`);
        }
      } finally { await sql.close(); }
    });
    for (const table of tables) {
      await sql.query(`CREATE TABLE ${prefix}${table} LIKE ${table}`);
      created.push(prefix + table);
    }
    const realQ = sql.getQueryInterface();
    const q = Object.fromEntries(['describeTable', 'addColumn', 'showIndex', 'addIndex', 'removeIndex', 'changeColumn'].map(method =>
      [method, (table, ...args) => realQ[method](prefix + table, ...args)]));
    await migration.up(q, Sequelize);
    await migration.up(q, Sequelize);
    await require('../migrations/20261106000001-unified-inbound-email').up(q, Sequelize);
    await require('../migrations/20261109000001-email-completion-reason').up(q, Sequelize);
    db.query = (query, params = []) => sql.query(rewrite(query), { replacements: params, type: Sequelize.QueryTypes.SELECT });
    db.get = async (query, params = []) => (await db.query(query, params))[0] || null;
    db.run = async (query, params = []) => {
      const [result, metadata] = await sql.query(rewrite(query), { replacements: params, type: Sequelize.QueryTypes.RAW });
      return { id: /^\s*INSERT/i.test(query) ? Number(result) : 0,
        changes: Number(typeof metadata === 'number' ? metadata : metadata?.affectedRows ?? result?.affectedRows) || 0 };
    };
    threader.assignReplyThread = async () => ({ threadId: null });
    let modelCalls = 0;
    ai.callActiveAi = async () => {
      modelCalls++;
      return { parsed: { summary: '红人提交视频等待审核', category: 'content_review', priority: 'urgent',
        reason: '明确提交视频并请求反馈', action: '打开视频审核', intent: 'question' } };
    };
    const makeMail = (uid, seen = false, messageId = `<test-${uid}@triage>`) => ({
      uid, flags: new Set(seen ? ['\\Seen'] : []),
      envelope: { messageId, from: [{ address: 'creator@triage.test' }], subject: 'Video for review', date: new Date() },
      bodyParts: new Map([['text', Buffer.from('Please review my video https://example.com/video')]])
    });
    const first = await live.processFetchedMessage(makeMail(1), 10, 20, 'validity1');
    const id = first.replyId;
    assert.ok(id);
    let row = await db.get('SELECT * FROM email_replies WHERE id = ?', [id]);
    assert.equal(row.todo_status, 'pending');
    assert.equal(row.mail_seen, 0);
    await triage.drain();
    row = await db.get('SELECT * FROM email_replies WHERE id = ?', [id]);
    assert.equal(row.triage_status, 'success');
    assert.equal(row.business_category, 'content_review');
    await triage.setDone(id, true, 20);
    await live.processFetchedMessage(makeMail(1), 10, 20, 'validity1');
    await triage.drain();
    row = await db.get('SELECT * FROM email_replies WHERE id = ?', [id]);
    assert.equal(row.todo_status, 'done');
    assert.equal(modelCalls, 1, 'repeated unread sync does not reanalyze completed mail');
    await triage.setDone(id, false, 20);
    await triage.drain();
    assert.equal(modelCalls, 1, 'restoring a successful analysis reuses its result');
    const read = await live.processFetchedMessage(makeMail(2, true), 10, 20, 'validity1');
    assert.equal((await db.get('SELECT todo_status FROM email_replies WHERE id = ?', [read.replyId])).todo_status, 'excluded');
    await live.processFetchedMessage(makeMail(2), 10, 20, 'validity1');
    assert.equal((await db.get('SELECT todo_status FROM email_replies WHERE id = ?', [read.replyId])).todo_status, 'pending');
    const fresh = await live.processFetchedMessage(makeMail(3), 10, 20, 'validity1');
    assert.ok(fresh.replyId !== id, 'new reply becomes an independent todo');
    // A shared Message-ID in a different mailbox belongs to that mailbox, too.
    const other = await live.processFetchedMessage(makeMail(1), 11, 21, 'validity1');
    assert.ok(other.replyId !== id);
    await triage.setDone(id, true, 999);
    assert.equal((await db.get('SELECT todo_status FROM email_replies WHERE id = ?', [id])).todo_status, 'pending');
    ai.callActiveAi = async () => { throw new Error('test temporary outage'); };
    await triage.analyze(fresh.replyId);
    row = await db.get('SELECT * FROM email_replies WHERE id = ?', [fresh.replyId]);
    assert.equal(row.triage_status, 'failed');
    assert.equal(row.todo_status, 'pending');
    assert.ok(row.triage_retry_at);
    await triage.retry(fresh.replyId);
    assert.equal((await db.get('SELECT triage_attempts FROM email_replies WHERE id = ?', [fresh.replyId])).triage_attempts, 0);
    // Verify the real list/report SQL, including counts beyond the first page and owner isolation.
    for (let index = 0; index < 35; index++) {
      await db.run(`INSERT INTO email_replies (owner_user_id, mailbox_id, message_id, subject, from_address,
        todo_status, triage_status, business_category, business_priority, classification, received_at)
        VALUES (20, 10, ?, 'More videos', 'creator@triage.test', 'pending', 'success', 'content_review', 'urgent', 'needs_review', NOW())`,
      [`<bulk-${index}@triage>`]);
    }
    const router = require('../routes/emails');
    const handler = router.stack.find(layer => layer.route?.path === '/triage').route.stack[0].handle;
    async function getPage(query) {
      let payload;
      const res = { status() { return this; }, json(value) { payload = value; } };
      await handler({ user: { id: 20 }, query }, res);
      assert.equal(payload.success, true, payload.error);
      return payload.data;
    }
    const page1 = await getPage({ page: 1 });
    const page2 = await getPage({ page: 2 });
    assert.equal(page1.rows.length, 30);
    assert.equal(page2.rows.length, 8);
    assert.equal(page1.total, 38);
    assert.equal(page1.report.reduce((sum, group) => sum + Number(group.total), 0), 38);
    assert.ok([...page1.rows, ...page2.rows].every(r => r.owner_user_id === 20));
    assert.equal((await getPage({ category: 'content_review' })).total, 36);
    // Recover a crash, including a final attempt that must visibly fail rather than stay running.
    await db.run(`UPDATE email_replies SET triage_status = 'running', triage_attempts = 3,
      triage_lease = 'abandoned', triage_lease_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?`, [fresh.replyId]);
    await triage.drain();
    assert.equal((await db.get('SELECT triage_status FROM email_replies WHERE id = ?', [fresh.replyId])).triage_status, 'failed');
    // First-contact lifecycle with real SQL; SMTP and AI are stubbed, never sent externally.
    assert.equal((await getPage({ sender: 'unknown' })).total, 38);
    assert.equal((await getPage({ sender: 'known' })).total, 0);
    await db.run(`INSERT INTO email_settings (id, owner_user_id, username, enabled, is_default)
      VALUES (10, 20, 'brand@example.test', 1, 1)`);
    const drafter = require('./inboundReplyDrafter');
    ai.callActiveAi = async () => ({ parsed: { subject: 'Re: Video for review', body_text: 'Thank you. We will review the video.' }, model: 'test' });
    const newDraft = await runWithUser({ id: 20 }, () => drafter.draftInboundReply({ sourceReplyId: fresh.replyId }));
    assert.equal(newDraft.ok, true, newDraft.error);
    const again = await runWithUser({ id: 20 }, () => drafter.draftInboundReply({ sourceReplyId: fresh.replyId }));
    assert.equal(again.draftId, newDraft.draftId);
    assert.equal(again.skipped, true);
    const forbidden = await runWithUser({ id: 21 }, () => drafter.draftInboundReply({ sourceReplyId: fresh.replyId }));
    assert.equal(forbidden.ok, false);
    const draft = await db.get('SELECT * FROM email_drafts WHERE id = ?', [newDraft.draftId]);
    assert.equal(draft.customer_id, null);
    assert.equal(draft.campaign_id, null);
    await db.run("UPDATE email_drafts SET status = 'approved' WHERE id = ?", [draft.id]);
    threader.assignRecordThread = async () => ({});
    let deliveries = 0;
    mailer.sendMail = async options => {
      deliveries++;
      assert.equal(options.to, 'creator@triage.test');
      assert.equal(options.settings.id, 10);
      assert.equal(options.inReplyTo, '<test-3@triage>');
      return { messageId: '<sent@triage.test>' };
    };
    await require('./emailDraftSender').sendApprovedDraft(draft.id);
    assert.equal(deliveries, 1);
    assert.equal((await db.get('SELECT todo_status FROM email_replies WHERE id = ?', [fresh.replyId])).todo_status, 'done');
    assert.equal((await db.get('SELECT completion_reason FROM email_replies WHERE id = ?', [fresh.replyId])).completion_reason, 'sent');
    for (const reason of ['replied_external', 'resolved', 'no_reply_needed']) {
      await triage.setDone(fresh.replyId, false, 20);
      assert.equal((await db.get('SELECT completion_reason FROM email_replies WHERE id = ?', [fresh.replyId])).completion_reason, null);
      await triage.setDone(fresh.replyId, true, 20, reason);
      await triage.setDone(fresh.replyId, true, 20, 'sent');
      assert.equal((await db.get('SELECT completion_reason FROM email_replies WHERE id = ?', [fresh.replyId])).completion_reason, reason,
        'a repeated completion cannot overwrite the recorded reason');
    }
    assert.equal((await db.get('SELECT COUNT(*) n FROM customers')).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) n FROM campaigns')).n, 0);

    // Recovery never removes a human block or another owner's rule, never calls AI,
    // and does not reopen a completed todo.
    await db.run(`INSERT INTO email_filter_rules (owner_user_id,rule_type,rule_value,active,created_by)
      VALUES (20,'domain','blocked.test',1,'boss')`);
    const blocked = {};
    for (const [name, owner, address, source, markedBy, todo] of [
      ['ai', 20, 'video@gmail.com', 'ai', null, 'excluded'],
      ['human', 20, 'human@gmail.com', 'human', 'boss', 'excluded'],
      ['rule', 20, 'rule@blocked.test', 'rule', null, 'excluded'],
      ['ai_rule_overlap', 20, 'overlap@blocked.test', 'ai', null, 'excluded'],
      ['other_owner', 21, 'other@blocked.test', 'ai', null, 'excluded'],
      ['done', 20, 'done@gmail.com', 'ai', null, 'done']
    ]) {
      const inserted = await db.run(`INSERT INTO email_replies (owner_user_id,mailbox_id,message_id,from_address,
        subject,classification,classification_source,classification_reason,spam_marked_by,confirm_status,todo_status,received_at)
        VALUES (?,10,?,?,'Video for review','spam',?,'AI认为个人邮箱不可信',?,'spam',?,NOW())`,
      [owner, `<blocked-${name}@fixture>`, address, source, markedBy, todo]);
      blocked[name] = inserted.id;
    }
    let accidentalCalls = 0;
    ai.callActiveAi = async () => { accidentalCalls++; throw new Error('Recovery must not call AI'); };
    const recovery = require('../migrations/20261109000002-manual-only-email-blocking');
    const recoveryQ = { sequelize: {
      transaction: callback => sql.transaction(callback),
      query: (statement, options) => sql.query(rewrite(statement), options)
    } };
    await recovery.up(recoveryQ);
    await recovery.up(recoveryQ);
    const recovered = await db.get('SELECT * FROM email_replies WHERE id = ?', [blocked.ai]);
    assert.equal(recovered.classification, 'needs_review');
    assert.equal(recovered.todo_status, 'pending');
    assert.equal(recovered.triage_status, 'manual_review');
    assert.equal((await db.get('SELECT classification FROM email_replies WHERE id = ?', [blocked.human])).classification, 'spam');
    assert.equal((await db.get('SELECT classification FROM email_replies WHERE id = ?', [blocked.rule])).classification, 'spam');
    assert.equal((await db.get('SELECT classification_source FROM email_replies WHERE id = ?', [blocked.ai_rule_overlap])).classification_source, 'rule');
    assert.equal((await db.get('SELECT classification FROM email_replies WHERE id = ?', [blocked.other_owner])).classification, 'needs_review');
    assert.equal((await db.get('SELECT todo_status FROM email_replies WHERE id = ?', [blocked.done])).todo_status, 'done');
    assert.equal(accidentalCalls, 0);
    // A human block made while the model is in flight wins over its late response.
    ai.callActiveAi = async () => {
      await db.run("UPDATE email_replies SET classification='spam',classification_source='human',spam_marked_by='boss' WHERE id=?", [blocked.ai]);
      return { parsed: { classification: 'suspected_kol' } };
    };
    await runWithUser({ id: 20 }, () => require('./emailFilterService').classifyStoredReply(blocked.ai));
    assert.equal((await db.get('SELECT classification_source FROM email_replies WHERE id = ?', [blocked.ai])).classification_source, 'human');
    await require('./emailFilterService').restoreReply(blocked.ai);
    assert.equal((await db.get('SELECT todo_status FROM email_replies WHERE id = ?', [blocked.ai])).todo_status, 'pending');
  });
