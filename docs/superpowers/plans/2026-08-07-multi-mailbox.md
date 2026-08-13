# 多邮箱接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把邮箱系统从单邮箱升级为多邮箱：`email_settings` 多行化，按 Campaign 绑定发件邮箱，每个邮箱独立收信（IDLE/轮询），回复/草稿/记录/会话归属到具体邮箱。

**Architecture:** 方案 A（见 `docs/superpowers/specs/2026-08-07-multi-mailbox-design.md`）：`email_settings` 加 `label`/`is_default`/`enabled` 变为"每行一个邮箱"；新增 `server/services/emailMailboxes.js` 作为取邮箱的统一入口；`emailLiveSync` 从全局单例改为按 mailbox_id 的 worker Map；前端邮箱配置 Tab 改为列表+弹窗表单。

**Tech Stack:** Node.js (express, sequelize+mysql2 raw via `dbOperations`, umzug migrations, imapflow, nodemailer), `node --test`（monkey-patch `dbOperations` 风格），React + AntD + axios（`react-scripts test` / Jest）。

## Global Constraints

- 服务端测试命令：`cd server && npm test`；单文件：`cd server && node --test services/<file>.test.js`（或 `routes/<file>.test.js`）。
- 前端测试命令：`cd client && CI=true npx react-scripts test src/pages/Emails.test.js --watchAll=false`。
- 不新增任何 npm 依赖。
- 服务端测试统一用既有风格：monkey-patch `dbOperations.get/query/run`（或服务模块方法），`node:test` + `node:assert/strict`，不用 supertest。
- MySQL `BOOLEAN` 读出为 `0/1`，判断用真值即可（`row.enabled`）。
- `server/routes/campaigns.js`、`server/services/mailer.js` 是 CRLF 行尾，编辑时保持 CRLF；其余涉及文件为 LF。
- 迁移文件名沿用时间戳风格：`server/migrations/20260807000001-multi-mailbox.js`。生产环境 umzug 有拒绝自动跑的守卫（`database.js:100-107`），验证迁移用开发库且先备份。
- **每个 Commit 步骤执行前必须先向用户确认（会话规则：git 变更需显式许可）。**
- 与 spec 的一处偏差说明：spec 提到 `emailReplyPoller.js` 轮询遍历多邮箱；实际代码中 poll 模式由 `emailLiveSync.pollOnceLive` 实现，`emailReplyPoller.startReplyPoller` 是无人调用的遗留死代码。本计划只在 `emailLiveSync` 内实现 per-mailbox poll，`emailReplyPoller.js` 保持不动（其中的 `summarizeReply`/`markWaitingReply`/`findOwnerByAddress` 继续被复用）。

---

### Task 1: 数据库迁移 —— email_settings 多行化 + 各表 mailbox_id

**Files:**
- Create: `server/migrations/20260807000001-multi-mailbox.js`

**Interfaces:**
- Produces: `email_settings(label, is_default, enabled)`；`campaigns.mailbox_id`、`email_drafts.mailbox_id`、`email_records.mailbox_id`、`email_replies.mailbox_id`、`email_threads.mailbox_id`（均 INTEGER NULL + 索引 `idx_<table>_mailbox_id`）。现有唯一一行被置为 `is_default=1, enabled=1, label='默认邮箱'`；四张邮件表历史数据回填默认邮箱 id；`campaigns.mailbox_id` 保持 NULL。

- [ ] **Step 1: 编写迁移文件**

创建 `server/migrations/20260807000001-multi-mailbox.js`（风格参照 `server/migrations/20260727000007-email-live-sync.js`：事务 + describeTable 幂等）：

```js
// 多邮箱：email_settings 从单行配置升级为每行一个邮箱（label/is_default/enabled），
// 邮件业务表加 mailbox_id 归属列。现有单行自动成为默认邮箱，历史邮件数据回填默认邮箱。
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();

    try {
      const settingsColumns = await queryInterface.describeTable('email_settings', { transaction });
      if (!settingsColumns.label) {
        await queryInterface.addColumn('email_settings', 'label', {
          type: Sequelize.STRING(100), allowNull: true, comment: '邮箱别名（列表展示用）'
        }, { transaction });
      }
      if (!settingsColumns.is_default) {
        await queryInterface.addColumn('email_settings', 'is_default', {
          type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
          comment: '是否默认邮箱（全表至多一行，应用层保证）'
        }, { transaction });
      }
      if (!settingsColumns.enabled) {
        await queryInterface.addColumn('email_settings', 'enabled', {
          type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true,
          comment: '停用后不新发、不同步收信，历史数据保留'
        }, { transaction });
      }

      // 现有唯一一行升级为默认邮箱
      await sequelize.query(
        `UPDATE email_settings SET is_default = 1, enabled = 1,
           label = COALESCE(NULLIF(label, ''), '默认邮箱')
         WHERE id = (SELECT t.min_id FROM (SELECT MIN(id) AS min_id FROM email_settings) t)`,
        { transaction }
      );

      const mailboxColumn = {
        type: Sequelize.INTEGER, allowNull: true,
        comment: '归属邮箱 email_settings.id（campaigns 上 NULL=默认邮箱）'
      };
      for (const table of ['campaigns', 'email_drafts', 'email_records', 'email_replies', 'email_threads']) {
        const columns = await queryInterface.describeTable(table, { transaction });
        if (!columns.mailbox_id) {
          await queryInterface.addColumn(table, 'mailbox_id', mailboxColumn, { transaction });
        }
        const [indexes] = await sequelize.query(
          `SHOW INDEX FROM ${table} WHERE Key_name = 'idx_${table}_mailbox_id'`,
          { transaction }
        );
        if (!indexes.length) {
          await queryInterface.addIndex(table, ['mailbox_id'], { name: `idx_${table}_mailbox_id`, transaction });
        }
      }

      // 历史邮件数据回填默认邮箱（此前只有一个邮箱，归属明确）；campaigns 不回填（NULL=默认邮箱）
      const [defaultRows] = await sequelize.query(
        'SELECT id FROM email_settings WHERE is_default = 1 ORDER BY id LIMIT 1',
        { transaction }
      );
      const defaultId = defaultRows[0]?.id;
      if (defaultId) {
        for (const table of ['email_drafts', 'email_records', 'email_replies', 'email_threads']) {
          await sequelize.query(
            `UPDATE ${table} SET mailbox_id = ? WHERE mailbox_id IS NULL`,
            { replacements: [defaultId], transaction }
          );
        }
      }

      await transaction.commit();
      console.log('[migration] multi-mailbox schema ready');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      for (const table of ['campaigns', 'email_drafts', 'email_records', 'email_replies', 'email_threads']) {
        const [indexes] = await sequelize.query(
          `SHOW INDEX FROM ${table} WHERE Key_name = 'idx_${table}_mailbox_id'`,
          { transaction }
        );
        if (indexes.length) {
          await queryInterface.removeIndex(table, `idx_${table}_mailbox_id`, { transaction });
        }
        const columns = await queryInterface.describeTable(table, { transaction });
        if (columns.mailbox_id) {
          await queryInterface.removeColumn(table, 'mailbox_id', { transaction });
        }
      }
      const settingsColumns = await queryInterface.describeTable('email_settings', { transaction });
      for (const name of ['label', 'is_default', 'enabled']) {
        if (settingsColumns[name]) {
          await queryInterface.removeColumn('email_settings', name, { transaction });
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
```

- [ ] **Step 2: 在开发库上跑迁移并验证**

先备份（参考 `deploy/backup-kol-campaign-os.sh` 或现有 `backups/` 目录习惯），然后：

Run: `cd server && npm run db:migrate`
Expected: 输出 `Running 1 pending migration(s)...` 与 `[migration] multi-mailbox schema ready`

验证（用项目 .env 里的库凭据，mysql CLI 或 node 脚本均可）：
- `DESCRIBE email_settings` 含 `label/is_default/enabled`，且原行 `is_default=1, label='默认邮箱'`
- `DESCRIBE email_drafts` 等五张表含 `mailbox_id`
- `SELECT COUNT(*) FROM email_records WHERE mailbox_id IS NULL` 为 0（若表非空）

- [ ] **Step 3: Commit（先向用户确认）**

```bash
git add server/migrations/20260807000001-multi-mailbox.js
git commit -m "feat: multi-mailbox schema migration"
```

---

### Task 2: emailMailboxes 服务 —— 取邮箱的统一入口

**Files:**
- Create: `server/services/emailMailboxes.js`
- Test: `server/services/emailMailboxes.test.js`

**Interfaces:**
- Consumes: `dbOperations.get/query`（`server/database.js:17-47`）。
- Produces（后续所有任务依赖的精确签名）:
  - `getDefaultMailbox() -> Promise<row|null>`：`is_default=1` 的行，兜底 `ORDER BY id LIMIT 1`
  - `getMailboxById(id) -> Promise<row|null>`：id 为空直接返回 null
  - `listMailboxes({ enabledOnly = false } = {}) -> Promise<rows[]>`：按 `is_default DESC, id` 排序
  - `resolveMailboxForDraft({ campaignId = null, sourceReplyId = null } = {}) -> Promise<row|null>`：回复继承来信邮箱 → Campaign 绑定 → 默认邮箱；候选行不存在或 `enabled=0` 时沿链回退

- [ ] **Step 1: 写失败测试**

创建 `server/services/emailMailboxes.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations } = require('../database');
const emailMailboxes = require('./emailMailboxes');

function withPatchedDb(patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = dbOperations[key];
    dbOperations[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) dbOperations[key] = originals[key];
  });
}

test('getDefaultMailbox prefers the is_default row and falls back to the earliest row', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (sql.includes('WHERE is_default = 1')) return { id: 2, username: 'b@x.com', is_default: 1 };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.getDefaultMailbox();
    assert.equal(row.id, 2);
  });

  await withPatchedDb({
    get: async (sql) => {
      if (sql.includes('WHERE is_default = 1')) return null;
      if (sql.includes('FROM email_settings ORDER BY id LIMIT 1')) return { id: 1, username: 'a@x.com' };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.getDefaultMailbox();
    assert.equal(row.id, 1);
  });
});

test('resolveMailboxForDraft inherits the source reply mailbox', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (sql.includes('FROM email_replies WHERE id = ?')) return { mailbox_id: 9 };
      if (sql.includes('FROM email_settings WHERE id = ?')) return { id: 9, enabled: 1, username: 'b@x.com' };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.resolveMailboxForDraft({ campaignId: 5, sourceReplyId: 33 });
    assert.equal(row.id, 9);
  });
});

test('resolveMailboxForDraft falls back to campaign binding when the reply mailbox is disabled', async () => {
  await withPatchedDb({
    get: async (sql, params = []) => {
      if (sql.includes('FROM email_replies WHERE id = ?')) return { mailbox_id: 9 };
      if (sql.includes('FROM email_settings WHERE id = ?')) {
        return params[0] === 9 ? { id: 9, enabled: 0 } : { id: 3, enabled: 1, username: 'c@x.com' };
      }
      if (sql.includes('FROM campaigns WHERE id = ?')) return { mailbox_id: 3 };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.resolveMailboxForDraft({ campaignId: 5, sourceReplyId: 33 });
    assert.equal(row.id, 3);
  });
});

test('resolveMailboxForDraft falls back to the default mailbox', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (sql.includes('FROM campaigns WHERE id = ?')) return { mailbox_id: null };
      if (sql.includes('WHERE is_default = 1')) return { id: 1, enabled: 1, username: 'a@x.com' };
      return null;
    }
  }, async () => {
    const row = await emailMailboxes.resolveMailboxForDraft({ campaignId: 5 });
    assert.equal(row.id, 1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/emailMailboxes.test.js`
Expected: FAIL（`Cannot find module './emailMailboxes'`）

- [ ] **Step 3: 实现 emailMailboxes.js**

创建 `server/services/emailMailboxes.js`：

```js
// 多邮箱解析：所有"取邮箱配置"的统一入口。
// 规则：默认邮箱 = is_default=1 的行（兜底最早一行）；
// 草稿/发送解析链：回复继承来信邮箱 → Campaign 绑定 → 默认邮箱；
// 候选行不存在或已停用（enabled=0）时沿链回退。
const { dbOperations } = require('../database');

async function getDefaultMailbox() {
  const row = await dbOperations.get('SELECT * FROM email_settings WHERE is_default = 1 ORDER BY id LIMIT 1');
  if (row) return row;
  return dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
}

async function getMailboxById(id) {
  if (!id) return null;
  return dbOperations.get('SELECT * FROM email_settings WHERE id = ?', [id]);
}

async function listMailboxes({ enabledOnly = false } = {}) {
  const where = enabledOnly ? 'WHERE enabled = 1' : '';
  return dbOperations.query(`SELECT * FROM email_settings ${where} ORDER BY is_default DESC, id`);
}

async function getEnabledMailboxOrNull(id) {
  const row = await getMailboxById(id);
  return row && row.enabled ? row : null;
}

async function resolveMailboxForDraft({ campaignId = null, sourceReplyId = null } = {}) {
  if (sourceReplyId) {
    const reply = await dbOperations.get('SELECT mailbox_id FROM email_replies WHERE id = ?', [sourceReplyId]);
    const row = await getEnabledMailboxOrNull(reply?.mailbox_id);
    if (row) return row;
  }
  if (campaignId) {
    const campaign = await dbOperations.get('SELECT mailbox_id FROM campaigns WHERE id = ?', [campaignId]);
    const row = await getEnabledMailboxOrNull(campaign?.mailbox_id);
    if (row) return row;
  }
  return getDefaultMailbox();
}

module.exports = { getDefaultMailbox, getMailboxById, listMailboxes, resolveMailboxForDraft };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test services/emailMailboxes.test.js`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add server/services/emailMailboxes.js server/services/emailMailboxes.test.js
git commit -m "feat: add emailMailboxes resolver service"
```

---

### Task 3: 设置 API 多邮箱化（routes/emails.js）

**Files:**
- Modify: `server/routes/emails.js:34-131`（`getEmailSettings` + 全部 settings 端点）
- Test: `server/routes/emails.test.js`（复用文件内已有 helpers：`findHandler(router, method, path)`、`callHandler(handler, { body, params, query })`、`withPatchedDb(patch, fn)`）

**Interfaces:**
- Consumes: Task 2 的 `emailMailboxes.*`；`emailLiveSync.restartEmailSync(id?)`/`syncNow(id?)`/`testImapConnection(id?)`/`getEmailSyncStatus()`（签名在 Task 5 改，本任务先按新签名调用—— Task 5 完成前路由测试里 patch 掉这些函数即可）。
- Produces（前端 Task 8 依赖）:
  - `GET /api/emails/settings` → `{ success, data: [mailbox...] }`（password 掩码）
  - `POST /api/emails/settings`（body 为完整配置）→ 新建；首个邮箱自动设为默认
  - `PUT /api/emails/settings/:id` → 更新指定邮箱并重启其收信 worker
  - `PUT /api/emails/settings`（无 id，兼容）→ 操作默认邮箱
  - `DELETE /api/emails/settings/:id` → 默认邮箱或有历史数据时 409
  - `POST /api/emails/settings/:id/default` → 设为默认
  - `POST /api/emails/settings/test` / `/test-imap` / `/sync-now`：body 可带 `{ id }`，不带则默认邮箱/全部启用邮箱
  - `GET /api/emails/settings/sync-status` → `{ success, data: [status...] }`（数组）

- [ ] **Step 1: 写失败测试（追加到 `server/routes/emails.test.js` 末尾）**

```js
test('GET /settings 返回掩码邮箱列表', async () => {
  await withPatchedDb({
    query: async (sql) => {
      if (String(sql).includes('FROM email_settings')) {
        return [
          { id: 1, username: 'a@x.com', password: 'secret', is_default: 1, enabled: 1, label: '默认邮箱' },
          { id: 2, username: 'b@x.com', password: 'secret2', is_default: 0, enabled: 1, label: 'B 业务' }
        ];
      }
      return [];
    }
  }, async () => {
    const res = await callHandler(findHandler(router, 'get', '/settings'));
    assert.equal(res.payload.data.length, 2);
    assert.equal(res.payload.data[0].password, '••••••••');
    assert.equal(res.payload.data[1].label, 'B 业务');
  });
});

test('PUT /settings/:id 更新指定邮箱并按 id 重启收信监听', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const restarted = [];
  const originalRestart = emailLiveSync.restartEmailSync;
  emailLiveSync.restartEmailSync = async (id) => { restarted.push(id); };
  const writes = [];
  try {
    await withPatchedDb({
      get: async (sql) => {
        if (String(sql).includes('FROM email_settings WHERE id = ?')) return { id: 2, password: 'old', sync_mode: 'idle' };
        return null;
      },
      run: async (sql, params) => { writes.push({ sql: String(sql), params }); return { id: 0, changes: 1 }; }
    }, async () => {
      const res = await callHandler(findHandler(router, 'put', '/settings/:id'), {
        params: { id: '2' },
        body: { smtp_host: 'smtp.b.com', username: 'b@x.com', password: '••••••••', sync_mode: 'idle' }
      });
      assert.equal(res.payload.success, true);
      const update = writes.find(({ sql }) => sql.includes('UPDATE email_settings SET'));
      assert.ok(update, '应执行 UPDATE');
      assert.equal(update.params[7], 'old', '掩码密码保留原值');
      assert.deepEqual(restarted, [2]);
    });
  } finally {
    emailLiveSync.restartEmailSync = originalRestart;
  }
});

test('POST /settings/:id/default 设为默认并清掉其他行', async () => {
  const writes = [];
  await withPatchedDb({
    run: async (sql, params) => { writes.push({ sql: String(sql), params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const res = await callHandler(findHandler(router, 'post', '/settings/:id/default'), { params: { id: '2' } });
    assert.equal(res.payload.success, true);
    assert.ok(writes.some(({ sql }) => sql.includes('SET is_default = 0')));
    assert.ok(writes.some(({ sql, params }) => sql.includes('SET is_default = 1') && params[0] === 2));
  });
});

test('DELETE /settings/:id 拒绝删除默认邮箱', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (String(sql).includes('FROM email_settings WHERE id = ?')) return { id: 1, is_default: 1 };
      return null;
    }
  }, async () => {
    const res = await callHandler(findHandler(router, 'delete', '/settings/:id'), { params: { id: '1' } });
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /默认邮箱/);
  });
});

test('DELETE /settings/:id 有历史邮件数据时拒绝删除', async () => {
  await withPatchedDb({
    get: async (sql) => {
      const text = String(sql);
      if (text.includes('FROM email_settings WHERE id = ?')) return { id: 2, is_default: 0 };
      if (text.includes('FROM email_drafts WHERE mailbox_id')) return { drafts: 3, records: 0, replies: 0 };
      return null;
    }
  }, async () => {
    const res = await callHandler(findHandler(router, 'delete', '/settings/:id'), { params: { id: '2' } });
    assert.equal(res.statusCode, 409);
    assert.match(res.payload.error, /停用/);
  });
});

test('兼容：无 id 的 PUT /settings 操作默认邮箱', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const originalRestart = emailLiveSync.restartEmailSync;
  emailLiveSync.restartEmailSync = async () => {};
  const writes = [];
  try {
    await withPatchedDb({
      get: async (sql) => {
        if (String(sql).includes('WHERE is_default = 1')) return { id: 1, password: 'old', sync_mode: 'idle' };
        return null;
      },
      run: async (sql, params) => { writes.push({ sql: String(sql), params }); return { id: 0, changes: 1 }; }
    }, async () => {
      const res = await callHandler(findHandler(router, 'put', '/settings'), {
        body: { smtp_host: 'smtp.a.com', username: 'a@x.com', sync_mode: 'idle' }
      });
      assert.equal(res.payload.success, true);
      const update = writes.find(({ sql }) => sql.includes('UPDATE email_settings SET'));
      assert.equal(update.params.at(-1), 1, '更新的是默认邮箱行');
    });
  } finally {
    emailLiveSync.restartEmailSync = originalRestart;
  }
});
```

注意：`router` 的获取方式沿用 `emails.test.js` 文件顶部既有写法（`require('./emails')` 或既有变量名）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/emails.test.js`
Expected: 新增用例 FAIL（缺 `/settings/:id` 等 handler；`GET /settings` 返回单行而非数组）

- [ ] **Step 3: 实现 —— 替换 `server/routes/emails.js:34-131`**

在文件顶部 require 区加：

```js
const emailMailboxes = require('../services/emailMailboxes');
```

删除旧的 `getEmailSettings` 函数（:34-36），把 :40-131 的 settings 端点整段替换为：

```js
// ---- 邮箱配置（多邮箱） ----

function maskMailbox(row) {
  return { ...row, password: row.password ? MASKED_SECRET : '' };
}

// 从请求体构建 settings 字段值（与 VALUES 占位顺序一致）；password 为掩码/未提供时保留原值
function buildSettingsValues(body, existing) {
  const password = body.password === MASKED_SECRET || body.password === undefined
    ? (existing?.password || null)
    : body.password;
  const syncMode = ['idle', 'poll', 'off'].includes(body.sync_mode) ? body.sync_mode : (existing?.sync_mode || 'idle');
  return [
    body.smtp_host || null, Number(body.smtp_port) || 465, body.smtp_secure === undefined ? 1 : (body.smtp_secure ? 1 : 0),
    body.imap_host || null, Number(body.imap_port) || 993, body.imap_secure === undefined ? 1 : (body.imap_secure ? 1 : 0),
    body.username || null, password,
    body.sender_name || null, body.default_cc || null,
    Number(body.poll_interval_minutes ?? 5),
    syncMode,
    body.label || null
  ];
}

const SETTINGS_COLUMNS = 'smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure, username, password, sender_name, default_cc, poll_interval_minutes, sync_mode, label';
const SETTINGS_SET_CLAUSE = 'smtp_host=?, smtp_port=?, smtp_secure=?, imap_host=?, imap_port=?, imap_secure=?, username=?, password=?, sender_name=?, default_cc=?, poll_interval_minutes=?, sync_mode=?, label=?';

async function restartMailboxSync(id) {
  // 修改邮箱配置后自动重启对应收信监听，无须重启整个系统
  try {
    await emailLiveSync.restartEmailSync(id || null);
  } catch (error) {
    console.error('[email] 重启收信监听失败:', error.message);
  }
}

router.get('/settings', async (req, res) => {
  try {
    const rows = await emailMailboxes.listMailboxes();
    res.json({ success: true, data: rows.map(maskMailbox) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const values = buildSettingsValues(req.body || {}, null);
    const result = await dbOperations.run(
      `INSERT INTO email_settings (${SETTINGS_COLUMNS}, is_default, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, NOW(), NOW())`,
      values
    );
    // 首个邮箱自动成为默认
    const hasDefault = await dbOperations.get('SELECT id FROM email_settings WHERE is_default = 1 LIMIT 1');
    if (!hasDefault) {
      await dbOperations.run('UPDATE email_settings SET is_default = 1 WHERE id = ?', [result.id]);
    }
    await restartMailboxSync(result.id);
    res.json({ success: true, message: '邮箱已添加', data: { id: result.id } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 兼容旧前端/脚本：无 id 的 PUT 操作默认邮箱
router.put('/settings', async (req, res) => {
  try {
    const existing = await emailMailboxes.getDefaultMailbox();
    if (!existing) {
      const values = buildSettingsValues(req.body || {}, null);
      const result = await dbOperations.run(
        `INSERT INTO email_settings (${SETTINGS_COLUMNS}, is_default, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NOW(), NOW())`,
        values
      );
      await restartMailboxSync(result.id);
      return res.json({ success: true, message: '邮箱设置已保存，收信监听已重启' });
    }
    await dbOperations.run(
      `UPDATE email_settings SET ${SETTINGS_SET_CLAUSE}, updated_at=NOW() WHERE id=?`,
      [...buildSettingsValues(req.body || {}, existing), existing.id]
    );
    await restartMailboxSync(existing.id);
    res.json({ success: true, message: '邮箱设置已保存，收信监听已重启' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/settings/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await emailMailboxes.getMailboxById(id);
    if (!existing) return res.status(404).json({ success: false, error: '邮箱不存在' });
    await dbOperations.run(
      `UPDATE email_settings SET ${SETTINGS_SET_CLAUSE}, updated_at=NOW() WHERE id=?`,
      [...buildSettingsValues(req.body || {}, existing), id]
    );
    await restartMailboxSync(id);
    res.json({ success: true, message: '邮箱设置已保存，收信监听已重启' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/settings/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await emailMailboxes.getMailboxById(id);
    if (!existing) return res.status(404).json({ success: false, error: '邮箱不存在' });
    if (existing.is_default) {
      return res.status(409).json({ success: false, error: '默认邮箱不可删除，请先将其他邮箱设为默认' });
    }
    const refs = await dbOperations.get(
      `SELECT (SELECT COUNT(*) FROM email_drafts WHERE mailbox_id = ?) AS drafts,
              (SELECT COUNT(*) FROM email_records WHERE mailbox_id = ?) AS records,
              (SELECT COUNT(*) FROM email_replies WHERE mailbox_id = ?) AS replies`,
      [id, id, id]
    );
    if ((refs?.drafts || 0) + (refs?.records || 0) + (refs?.replies || 0) > 0) {
      return res.status(409).json({ success: false, error: '该邮箱已有历史邮件数据，请改用停用' });
    }
    await dbOperations.run('UPDATE campaigns SET mailbox_id = NULL WHERE mailbox_id = ?', [id]);
    await dbOperations.run('DELETE FROM email_settings WHERE id = ?', [id]);
    await restartMailboxSync(id);
    res.json({ success: true, message: '邮箱已删除' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/:id/default', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await emailMailboxes.getMailboxById(id);
    if (!existing) return res.status(404).json({ success: false, error: '邮箱不存在' });
    await dbOperations.run('UPDATE email_settings SET is_default = 0 WHERE is_default = 1');
    await dbOperations.run('UPDATE email_settings SET is_default = 1, enabled = 1, updated_at = NOW() WHERE id = ?', [id]);
    res.json({ success: true, message: '已设为默认邮箱' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/settings/sync-status', async (req, res) => {
  try {
    res.json({ success: true, data: await emailLiveSync.getEmailSyncStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/test-imap', async (req, res) => {
  try {
    const info = await emailLiveSync.testImapConnection(req.body?.id ? Number(req.body.id) : null);
    res.json({ success: true, message: `IMAP 连接成功（收件箱 ${info.exists} 封邮件）`, data: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/sync-now', async (req, res) => {
  try {
    const result = await emailLiveSync.syncNow(req.body?.id ? Number(req.body.id) : null);
    res.json({
      success: true,
      message: `同步完成：新收 ${result.fetched}，匹配 ${result.matched}，未识别 ${result.unmatched}`,
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/test', async (req, res) => {
  try {
    const settings = req.body?.id
      ? await emailMailboxes.getMailboxById(Number(req.body.id))
      : await emailMailboxes.getDefaultMailbox();
    if (!settings) return res.status(400).json({ success: false, error: '请先配置邮箱设置' });
    await mailer.verifySettings(settings);
    res.json({ success: true, message: 'SMTP 连接成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

路由匹配说明：未定义 `GET /settings/:id`，`PUT/DELETE /settings/:id` 与静态路径（`sync-status`/`test-imap`/`sync-now`/`test` 均为 GET/POST）方法不同，`POST /settings/:id/default` 是两段路径、不会吞掉单段的 `test-imap` 等——按代码块中的顺序声明即可，无冲突。

- [ ] **Step 4: 跑测试确认新用例通过**

Run: `cd server && node --test routes/emails.test.js`
Expected: 新增 6 个用例 PASS

- [ ] **Step 5: 修复该文件中受影响的旧用例**

旧的 settings 用例 mock 的是 `dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1')` 返回单行、`GET /settings` 断言对象结构。改为 mock `dbOperations.query`（listMailboxes 走 query）返回数组、`GET /settings` 断言数组。逐一跑到全绿。

Run: `cd server && node --test routes/emails.test.js`
Expected: 全部 PASS

- [ ] **Step 6: Commit（先向用户确认）**

```bash
git add server/routes/emails.js server/routes/emails.test.js
git commit -m "feat: multi-mailbox settings API"
```

---

### Task 4: 发件链路 —— 按 Campaign 绑定解析邮箱（emailDrafter + emailDraftSender）

**Files:**
- Modify: `server/services/emailDrafter.js`（:264 附近、:271-288、:346-356）
- Modify: `server/services/emailDraftSender.js`（:118-123、:156-162、:172-180、:219-225）
- Test: `server/services/emailDraftSender.test.js`（追加用例）、`server/services/emailDrafter.test.js`（修复下标断言 + 追加用例）

**Interfaces:**
- Consumes: Task 2 的 `emailMailboxes.resolveMailboxForDraft({ campaignId, sourceReplyId })`、`getMailboxById(id)`、`getDefaultMailbox()`。
- Produces: `email_drafts.mailbox_id`、`email_records.mailbox_id` 落库；`mailer.sendMail({ settings, ... })` 的 settings 为解析出的邮箱行（Task 8 前端不感知）。

- [ ] **Step 1: emailDraftSender 写失败测试（追加到 `server/services/emailDraftSender.test.js`）**

```js
test('sendApprovedDraft sends via the draft-bound mailbox and records mailbox_id', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    return { id: 901, changes: 1 };
  };
  dbOperations.get = async (sql, params = []) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 7, status: 'sending', campaign_id: 2, customer_id: 3, subject: 'Hello', body_text: 'Body', mailbox_id: 9 };
    }
    if (sql.includes('FROM email_settings WHERE id = ?')) {
      assert.equal(params[0], 9);
      return { id: 9, username: 'b@x.com', default_cc: '', enabled: 1 };
    }
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let sentOptions = null;
  mailer.sendMail = async (options) => {
    sentOptions = options;
    return { messageId: 'message-9' };
  };

  await emailDraftSender.sendApprovedDraft(7);

  assert.equal(sentOptions.settings.username, 'b@x.com', '用草稿绑定的邮箱发件');
  const record = writes.find(({ sql }) => sql.includes('INSERT INTO email_records') && sql.includes("'success'"));
  assert.equal(record.params.at(-1), 9, 'email_records 落 mailbox_id');
});

test('sendApprovedDraft falls back to the default mailbox when the bound one is disabled', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => { writes.push({ sql, params }); return { id: 902, changes: 1 }; };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 7, status: 'sending', campaign_id: 2, customer_id: 3, subject: 'Hello', body_text: 'Body', mailbox_id: 9 };
    }
    if (sql.includes('FROM email_settings WHERE id = ?')) return { id: 9, username: 'b@x.com', enabled: 0 };
    if (sql.includes('WHERE is_default = 1')) return { id: 1, username: 'a@x.com', default_cc: '', enabled: 1 };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let sentOptions = null;
  mailer.sendMail = async (options) => { sentOptions = options; return { messageId: 'message-1' }; };

  const result = await emailDraftSender.sendApprovedDraft(7);

  assert.equal(sentOptions.settings.username, 'a@x.com', '绑定邮箱停用时回退默认邮箱');
  assert.match(result.warning || '', /已改用默认邮箱/, '回退时返回 warning 供审批台提示');
  const record = writes.find(({ sql }) => sql.includes('INSERT INTO email_records') && sql.includes("'success'"));
  assert.equal(record.params.at(-1), 1);
});
```

（文件顶部已有的 `originalRun/originalGet/originalSendMail` 保存与 `afterEach` 恢复逻辑会覆盖这两个用例的 patch。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/emailDraftSender.test.js`
Expected: 新用例 FAIL（当前仍 `LIMIT 1` 取单行，mock 的 `WHERE id = ?` 分支不命中）

- [ ] **Step 3: 实现 emailDraftSender 改动**

`server/services/emailDraftSender.js` 顶部 require 区加：

```js
const emailMailboxes = require('./emailMailboxes');
```

把 :118-123 的设置读取替换为：

```js
  const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [draftId]);
  // 多邮箱：草稿绑定的邮箱优先；绑定邮箱不存在或已停用时回退默认邮箱
  const bound = draft.mailbox_id ? await emailMailboxes.getMailboxById(draft.mailbox_id) : null;
  const fallbackToDefault = Boolean(draft.mailbox_id && !(bound && bound.enabled));
  const settings = bound && bound.enabled ? bound : await emailMailboxes.getDefaultMailbox();
  if (!settings) {
    await markFailed(draft.id);
    throw actionError('请先配置邮箱设置', 400);
  }
  const mailboxId = settings.id || null;
  // 回退默认邮箱时给审批人可见的警告（路由层 data 透传 result，前端据此弹提示）
  const sendWarning = fallbackToDefault
    ? `草稿绑定的邮箱已停用或不存在，已改用默认邮箱 ${settings.username} 发送`
    : null;
```

并在 `sendApprovedDraft` 的成功返回对象上附加 `warning: sendWarning`（返回对象字面量处加一个字段即可；`null` 时前端不提示）。

三处 `INSERT INTO email_records` 加 `mailbox_id`（失败分支 :156-162、成功分支 :172-180、人工确认分支 :219-225），统一把 `mailbox_id` 放在列清单末尾、`created_at` 之前，参数数组末尾追加 `mailboxId`：

失败分支：

```js
      `INSERT INTO email_records
       (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, mailbox_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, NOW())`,
      [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
       draft.subject, draft.body_text, sendError.message, mailboxId]
```

成功分支：

```js
      `INSERT INTO email_records
       (draft_id, campaign_id, customer_id, kol_name, to_address, cc, subject, body_text, status, smtp_message_id, in_reply_to, references_json, mailbox_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, ?, NOW())`,
    [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
     cc.join(',') || null, subject, text, messageId,
     replyCtx ? replyCtx.inReplyTo : null,
     replyCtx && replyCtx.references.length ? JSON.stringify(replyCtx.references) : null,
     mailboxId]
```

人工确认分支（`confirmManuallySent` 内）：

```js
    `INSERT INTO email_records
     (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, mailbox_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, NOW())`,
    [draft.id, draft.campaign_id, draft.customer_id, customer?.name || null, customer?.email || null,
     draft.subject, draft.body_text, note, draft.mailbox_id || null]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test services/emailDraftSender.test.js`
Expected: 全部 PASS（含旧用例：旧 mock 的草稿无 `mailbox_id`，走 `getDefaultMailbox` 分支仍命中其 `FROM email_settings` mock）

- [ ] **Step 5: 实现 emailDrafter 改动**

`server/services/emailDrafter.js` 顶部 require 区加：

```js
const emailMailboxes = require('./emailMailboxes');
```

1. 删除 :264 的 `const emailSettings = await dbOperations.get('SELECT sender_name FROM email_settings ORDER BY id LIMIT 1');`
2. 在 sourceReply 加载块（:271-282）之后插入：

```js
    // 多邮箱：回复继承来信邮箱 → Campaign 绑定 → 默认邮箱
    const mailbox = await emailMailboxes.resolveMailboxForDraft({ campaignId, sourceReplyId });
```

3. :288 的 `senderName: emailSettings?.sender_name || '',` 改为 `senderName: mailbox?.sender_name || '',`
4. INSERT INTO email_drafts（:346-356）加 `mailbox_id`（放在 `dedupe_key` 之后）：

```js
        `INSERT INTO email_drafts
         (campaign_id, customer_id, kind, subject, body_text, status, risk_level, risk_reasons, evidence,
          source_reply_id, template_id, prompt_version, ai_model, dedupe_key, mailbox_id,
          thread_id, reply_to_message_id, context_message_ids, context_summary_snapshot,
          generated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [campaignId, customerId, kind, subject, bodyText, riskLevel, JSON.stringify(riskReasons), evidence,
         sourceReplyId, styleGuide?.id || null, PROMPT_VERSION, model || null, dedupeKey, mailbox?.id || null,
         draftThreadId, replyToMessageId, contextMessageIds, contextSummarySnapshot]
```

（params 下标：0-12 与原一致，13=mailbox_id，14=draftThreadId，15=replyToMessageId，16=contextMessageIds，17=contextSummarySnapshot。）

- [ ] **Step 6: 修复 emailDrafter.test.js 并追加邮箱归属用例**

`createFakeDb` 的 mock 已兼容新查询链（`FROM campaigns WHERE id = ?` 返回行无 `mailbox_id` → 回退 `FROM email_settings` mock 返回 `{ sender_name: 'Celeste' }`）。需要：

1. INSERT params 下标从 13 起整体 +1（原 13=draftThreadId → 14，14=replyToMessageId → 15，15=contextMessageIds → 16，16=contextSummarySnapshot → 17；新增 13=mailbox_id）。把该文件中对 `draftInsert(...).params[13..16]` 的断言逐一改为新下标。
2. 追加用例：

```js
test('draft insert stores the resolved mailbox_id from campaign binding', async () => {
  const fake = createFakeDb({});
  const originalGet = fake.get;
  fake.get = async (sql, params) => {
    if (/FROM campaigns WHERE id = \?/.test(sql)) return { id: 5, name: 'Everglow', product: 'Tree collar', mailbox_id: 4 };
    if (/FROM email_settings WHERE id = \?/.test(sql)) return { id: 4, enabled: 1, sender_name: 'B Team' };
    return originalGet(sql, params);
  };
  const result = await runDraft(fake);
  assert.equal(result.ok, true);
  assert.equal(draftInsert(fake.statements).params[13], 4, '草稿落 Campaign 绑定的 mailbox_id');
});
```

注意 `createFakeDb` 里 `get` 是对象属性，`runDraft` 在调用时才读 `fake.get`，上面的替换方式有效；`FROM email_settings WHERE id = ?` 分支要放在 `originalGet` 之前，否则会命中原 mock 的 `/FROM email_settings/` 通用分支返回无 id 的行。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd server && node --test services/emailDrafter.test.js services/emailDraftSender.test.js`
Expected: 全部 PASS

- [ ] **Step 8: Commit（先向用户确认）**

```bash
git add server/services/emailDrafter.js server/services/emailDraftSender.js server/services/emailDrafter.test.js server/services/emailDraftSender.test.js
git commit -m "feat: resolve sending mailbox per draft and record mailbox_id"
```

---

### Task 5: 收信链路 —— emailLiveSync 按邮箱多 worker

**Files:**
- Modify: `server/services/emailLiveSync.js`（全文件多处，见下）
- Test: `server/services/emailLiveSync.test.js`（适配新签名 + 追加多邮箱用例）

**Interfaces:**
- Consumes: Task 2 的 `emailMailboxes.listMailboxes/getMailboxById/getDefaultMailbox`。
- Produces（Task 3 路由已按此调用）:
  - `restartEmailSync(mailboxId = null)`：无 id 重启全部；有 id 只重启该邮箱 worker
  - `syncNow(mailboxId = null)` → `{ fetched, matched, unmatched }`（无 id 时聚合全部启用邮箱）
  - `testImapConnection(mailboxId = null)` → `{ exists, uidNext }`
  - `getEmailSyncStatus()` → **async**，返回数组 `[{ mailbox_id, username, label, mode, status, last_mail_at, last_full_sync_at, last_error, reconnect_attempts, connected_since }]`
  - `fetchNew(worker, activeClient = worker.client)`：**签名变化**，worker 见下
  - `processFetchedMessage(message, mailboxId)`：**签名变化**，多一个 mailboxId 参数
  - `startEmailSync()`、`stopEmailSync` 导出不变

worker 结构：`{ mailboxId, settings, client, idleTask, pollTimer, stopping, fetching, state }`，`state = { mode, status, lastMailAt, lastFullSyncAt, lastError, reconnectAttempts, connectedSince }`。模块级 `workers = new Map()`（mailboxId → worker）+ 单个全局 `fullScanTimer`。

- [ ] **Step 1: 适配现有测试到新签名（先改测试）**

`server/services/emailLiveSync.test.js` 改动：

1. 顶部加 worker 工厂：

```js
function makeWorkerForTest(client, settings) {
  return {
    mailboxId: settings.id,
    settings,
    client,
    idleTask: null,
    pollTimer: null,
    stopping: false,
    fetching: false,
    state: {
      mode: 'idle', status: 'connected', lastMailAt: null, lastFullSyncAt: null,
      lastError: null, reconnectAttempts: 0, connectedSince: null
    }
  };
}
```

2. `mockDb` 中删除 `FROM email_settings` 分支（fetchNew 不再从 DB 读 settings），`settings` 参数仍保留用于传给 `makeWorkerForTest`。
3. 所有 `liveSync.fetchNew(client)` 改为 `liveSync.fetchNew(makeWorkerForTest(client, settings))`，其中 `settings` 为各用例传入 mockDb 的那份（如 `{ ...baseSettings, last_uid: 0 }`）。
4. INSERT params 下标从 8 起整体 +1（新增 mailbox_id 在第 8 位）：文件内下标注释改为 `0 email_record_id, 1 campaign_id, 2 customer_id, 3 from_address, 4 message_id, 5 subject, 6 body_text, 7 received_at, 8 mailbox_id, 9 confirm_status, 10 classification, 11 classification_source, 12 classification_reason, 13 in_reply_to, 14 references_json, 15 clean_body_text, 16 body_html, 17 quoted_body_text, 18 signature_text, 19 raw_source, 20 parse_status, 21 parse_error`；相应断言 `params[12]→[13]`、`params[13]→[14]`、`params[14]→[15]`、`params[16]→[17]`、`params[18]→[19]`、`params[19]→[20]`、`params[20]→[21]`、`[12,13,14,15,16,17,18]` 的循环改为 `[13,14,15,16,17,18,19]`，并新增 `assert.equal(params[8], baseSettings.id)` 验证 mailbox_id 落库。
5. `sync status exposes mode...` 用例改为异步数组断言：

```js
test('sync status returns one entry per mailbox', async () => {
  const emailMailboxes = require('../services/emailMailboxes');
  const original = emailMailboxes.listMailboxes;
  emailMailboxes.listMailboxes = async () => [
    { id: 1, username: 'a@x.com', label: '默认邮箱', sync_mode: 'idle' },
    { id: 2, username: 'b@x.com', label: 'B 业务', sync_mode: 'poll' }
  ];
  try {
    const rows = await liveSync.getEmailSyncStatus();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].mailbox_id, 1);
    assert.equal(rows[0].username, 'a@x.com');
    assert.equal(rows[0].status, 'off', '无 worker 的邮箱状态为 off');
    for (const key of ['mailbox_id', 'username', 'label', 'mode', 'status', 'last_mail_at', 'last_full_sync_at', 'last_error', 'reconnect_attempts', 'connected_since']) {
      assert.ok(key in rows[0], `status missing ${key}`);
    }
  } finally {
    emailMailboxes.listMailboxes = original;
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/emailLiveSync.test.js`
Expected: FAIL（`fetchNew` 仍是旧签名，`getEmailSyncStatus` 仍返回对象）

- [ ] **Step 3: 实现 emailLiveSync 多 worker 改造**

顶部 require 区加 `const emailMailboxes = require('./emailMailboxes');`。

**3a. 替换模块状态块（:25-40）与删除 getSettings（:44-46）**：

```js
// 多邮箱：每个启用邮箱一个 worker（IDLE 长连接或定时轮询），各自维护 last_uid 游标
const workers = new Map(); // mailboxId -> worker
let fullScanTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWorker(settings) {
  return {
    mailboxId: settings.id,
    settings,
    client: null,
    idleTask: null,
    pollTimer: null,
    stopping: false,
    fetching: false,
    state: {
      mode: 'off',
      status: 'off', // connecting | connected | reconnecting | failed | off
      lastMailAt: null,
      lastFullSyncAt: null,
      lastError: null,
      reconnectAttempts: 0,
      connectedSince: null
    }
  };
}
```

（删除旧的 `state`/`client`/`idleTask`/`pollTimer`/`stopping`/`fetching` 全局变量和 `getSettings` 函数；`makeClient` 保持不变。）

**3b. processFetchedMessage 改签名并落 mailbox_id**：函数签名改为 `async function processFetchedMessage(message, mailboxId)`；INSERT 语句加列与参数：

```js
      `INSERT INTO email_replies
       (email_record_id, campaign_id, customer_id, from_address, message_id, subject, body_text, received_at,
        mailbox_id,
        ai_status, confirm_status, classification, classification_source, classification_reason, classified_at,
        created_at, updated_at,
        in_reply_to, references_json, clean_body_text, body_html, quoted_body_text, signature_text,
        raw_source, parse_status, parse_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NOW(), NOW(), NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner?.id || null, owner?.campaign_id || null, owner?.customer_id || null, fromAddress, messageId,
       subject, bodyText, receivedAt, mailboxId || null, confirmStatus,
       classification, classificationSource, classificationReason,
       // …其余参数与原顺序一致…
```

**3c. 替换 fetchNew / fetchNewSafe**：

```js
// UID 增量抓取：只处理 uid > last_uid 的邮件并推进游标（逐封持久化，崩溃不重复）
async function fetchNew(worker, activeClient = worker.client) {
  if (worker.fetching) return { fetched: 0, matched: 0, unmatched: 0, busy: true };
  worker.fetching = true;
  const settings = worker.settings;
  try {
    let lastUid = Number(settings.last_uid) || 0;
    if (!lastUid) {
      // 首次初始化：只收启用之后的新邮件，历史邮件由一次性导入补齐
      lastUid = Math.max(0, Number(activeClient.mailbox?.uidNext || 1) - 1);
      await dbOperations.run('UPDATE email_settings SET last_uid = ? WHERE id = ?', [lastUid, settings.id]);
      return { fetched: 0, matched: 0, unmatched: 0, initialized: true };
    }

    let fetched = 0;
    let matched = 0;
    let unmatched = 0;
    const range = `${lastUid + 1}:*`;
    for await (const message of activeClient.fetch(range, { envelope: true, bodyParts: ['text'], source: true }, { uid: true })) {
      if (!message?.uid || message.uid <= lastUid) continue;
      const outcome = await processFetchedMessage(message, settings.id);
      fetched += 1;
      if (outcome.duplicate) { /* 不计入 */ } else if (outcome.matched) matched += 1;
      else unmatched += 1;
      lastUid = message.uid;
      settings.last_uid = lastUid;
      worker.state.lastMailAt = new Date();
      await dbOperations.run('UPDATE email_settings SET last_uid = ? WHERE id = ?', [lastUid, settings.id]);
    }
    return { fetched, matched, unmatched };
  } finally {
    worker.fetching = false;
  }
}

async function fetchNewSafe(worker, activeClient) {
  try {
    return await fetchNew(worker, activeClient);
  } catch (error) {
    worker.state.lastError = error.message;
    return { fetched: 0, matched: 0, unmatched: 0, error: error.message };
  }
}
```

**3d. 替换 runIdleLoop / pollOnceLive**：

```js
async function runIdleLoop(worker) {
  const settings = worker.settings;
  let attempt = 0;
  while (!worker.stopping) {
    try {
      worker.state.status = attempt ? 'reconnecting' : 'connecting';
      worker.state.reconnectAttempts = attempt;
      worker.client = makeClient(settings);
      await worker.client.connect();
      await worker.client.mailboxOpen('INBOX');
      attempt = 0;
      worker.state.status = 'connected';
      worker.state.connectedSince = new Date();
      worker.state.lastError = null;
      worker.state.reconnectAttempts = 0;
      // 连接/重连后立即补扫，覆盖断线窗口
      const catchUp = await fetchNewSafe(worker);
      if (!catchUp.busy && !catchUp.error) worker.state.lastFullSyncAt = new Date();
      worker.client.on('exists', () => { fetchNewSafe(worker); });
      worker.client.on('error', () => {});
      while (!worker.stopping && worker.client.usable) {
        await worker.client.idle();
        await fetchNewSafe(worker);
      }
      if (worker.stopping) break;
      throw new Error('IDLE 连接已断开');
    } catch (error) {
      worker.state.lastError = error.message;
      worker.state.status = 'reconnecting';
      worker.state.reconnectAttempts = attempt + 1;
      console.error(`[email] IDLE 连接异常（邮箱 ${settings.username}，第 ${attempt + 1} 次重连）:`, error.message);
      try { await worker.client?.logout(); } catch { /* ignore */ }
      worker.client = null;
      if (worker.stopping) break;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      await sleep(delay);
    }
  }
}

// poll 模式：一次性连接补扫后断开
async function pollOnceLive(worker) {
  const oneShot = makeClient(worker.settings);
  try {
    await oneShot.connect();
    await oneShot.mailboxOpen('INBOX');
    const result = await fetchNewSafe(worker, oneShot);
    if (!result.error && !result.busy) worker.state.lastFullSyncAt = new Date();
    await oneShot.logout();
  } catch (error) {
    worker.state.lastError = error.message;
    worker.state.status = 'failed';
    try { await oneShot.logout(); } catch { /* ignore */ }
  }
}
```

**3e. 替换 stopMachinery / startEmailSync / restartEmailSync 为 worker 管理**：

```js
function startWorker(settings) {
  const mode = SYNC_MODES.has(settings?.sync_mode) ? settings.sync_mode : 'idle';
  const worker = makeWorker(settings);
  worker.state.mode = mode;
  workers.set(settings.id, worker);

  if (mode === 'off' || !settings?.imap_host || !settings?.username || !settings?.password) {
    worker.state.status = 'off';
    return worker;
  }
  if (mode === 'poll') {
    const minutes = Number(settings.poll_interval_minutes) || 5;
    worker.state.status = 'connected';
    console.log(`[email] 回复追踪（${settings.username}）：定时轮询模式，每 ${minutes} 分钟一次。`);
    worker.pollTimer = setInterval(() => pollOnceLive(worker), minutes * 60 * 1000);
    worker.pollTimer.unref();
    return worker;
  }
  console.log(`[email] 回复追踪（${settings.username}）：实时监听模式（IMAP IDLE）。`);
  worker.idleTask = runIdleLoop(worker);
  return worker;
}

async function stopWorker(worker) {
  worker.stopping = true;
  if (worker.pollTimer) { clearInterval(worker.pollTimer); worker.pollTimer = null; }
  try { await worker.client?.logout(); } catch { /* ignore */ }
  worker.client = null;
  if (worker.idleTask) { await worker.idleTask.catch(() => {}); worker.idleTask = null; }
}

async function stopMachinery() {
  if (fullScanTimer) { clearInterval(fullScanTimer); fullScanTimer = null; }
  for (const worker of workers.values()) await stopWorker(worker);
  workers.clear();
}

async function startEmailSync() {
  // 测试环境不建立真实连接（node --test 默认 NODE_ENV=test）
  if (process.env.NODE_ENV === 'test') return;
  await stopMachinery();
  const backfilled = await emailBounceService.backfillSystemMails().catch((error) => {
    console.error('[email] 历史系统邮件整理失败:', error.message);
    return 0;
  });
  if (backfilled > 0) console.log(`[email] 已整理 ${backfilled} 封历史系统邮件/退信。`);

  const rows = await emailMailboxes.listMailboxes({ enabledOnly: true });
  for (const settings of rows) startWorker(settings);
  if (!rows.length) {
    console.log('[email] 回复同步已关闭（无启用的邮箱）。');
    return;
  }
  // 15 分钟补偿扫描：遍历所有已连接的 worker
  fullScanTimer = setInterval(async () => {
    for (const worker of workers.values()) {
      if (worker.client && worker.state.status === 'connected') {
        const result = await fetchNewSafe(worker);
        if (!result.error && !result.busy) worker.state.lastFullSyncAt = new Date();
      }
    }
  }, FULL_SCAN_INTERVAL_MS);
  fullScanTimer.unref();
}

async function restartEmailSync(mailboxId = null) {
  if (process.env.NODE_ENV === 'test') return;
  if (!mailboxId) {
    await startEmailSync();
    return;
  }
  const id = Number(mailboxId);
  const worker = workers.get(id);
  if (worker) {
    await stopWorker(worker);
    workers.delete(id);
  }
  const settings = await emailMailboxes.getMailboxById(id);
  if (settings && settings.enabled) startWorker(settings);
}
```

**3f. 替换 syncNow / testImapConnection / getEmailSyncStatus**：

```js
// 「立即同步一次」：带 id 只同步该邮箱；不带 id 聚合所有启用邮箱
async function syncNow(mailboxId = null) {
  const targets = mailboxId
    ? [await emailMailboxes.getMailboxById(Number(mailboxId))].filter(Boolean)
    : await emailMailboxes.listMailboxes({ enabledOnly: true });
  const total = { fetched: 0, matched: 0, unmatched: 0 };
  for (const settings of targets) {
    const result = await syncMailboxNow(settings);
    total.fetched += result.fetched;
    total.matched += result.matched;
    total.unmatched += result.unmatched;
  }
  return total;
}

async function syncMailboxNow(settings) {
  const worker = workers.get(settings.id);
  // IDLE 模式复用长连接，其他模式一次性连接补扫
  if (worker?.state.mode === 'idle' && worker.client && worker.state.status === 'connected') {
    const result = await fetchNew(worker);
    if (!result.error) worker.state.lastFullSyncAt = new Date();
    return result;
  }
  if (!settings?.imap_host || !settings?.username || !settings?.password) {
    throw new Error(`邮箱 ${settings?.username || settings?.id} 的 IMAP 未配置完整`);
  }
  const oneShot = makeClient(settings);
  try {
    await oneShot.connect();
    await oneShot.mailboxOpen('INBOX');
    const tempWorker = makeWorker(settings);
    const result = await fetchNew(tempWorker, oneShot);
    if (worker) worker.state.lastFullSyncAt = new Date();
    await oneShot.logout();
    return result;
  } catch (error) {
    try { await oneShot.logout(); } catch { /* ignore */ }
    throw error;
  }
}

async function testImapConnection(mailboxId = null) {
  const settings = mailboxId
    ? await emailMailboxes.getMailboxById(Number(mailboxId))
    : await emailMailboxes.getDefaultMailbox();
  if (!settings?.imap_host || !settings?.username || !settings?.password) {
    throw new Error('IMAP 未配置完整');
  }
  const testClient = makeClient(settings);
  try {
    await testClient.connect();
    await testClient.mailboxOpen('INBOX', { readOnly: true });
    const info = { exists: testClient.mailbox?.exists ?? null, uidNext: testClient.mailbox?.uidNext ?? null };
    await testClient.logout();
    return info;
  } catch (error) {
    try { await testClient.logout(); } catch { /* ignore */ }
    throw error;
  }
}

async function getEmailSyncStatus() {
  const rows = await emailMailboxes.listMailboxes();
  return rows.map((row) => {
    const worker = workers.get(row.id);
    return {
      mailbox_id: row.id,
      username: row.username,
      label: row.label,
      mode: worker?.state.mode || row.sync_mode || 'off',
      status: worker?.state.status || 'off',
      last_mail_at: worker?.state.lastMailAt || null,
      last_full_sync_at: worker?.state.lastFullSyncAt || null,
      last_error: worker?.state.lastError || null,
      reconnect_attempts: worker?.state.reconnectAttempts || 0,
      connected_since: worker?.state.connectedSince || null
    };
  });
}
```

**3g. 导出**：保持原有导出名单不变（`startEmailSync, restartEmailSync, stopEmailSync: stopMachinery, syncNow, testImapConnection, getEmailSyncStatus, fetchNew, processFetchedMessage`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test services/emailLiveSync.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归服务端测试**

Run: `cd server && npm test`
Expected: 全部 PASS（重点看 `routes/emails.test.js`、`services/emailReplyPoller.test.js`——后者不应受影响）

- [ ] **Step 6: Commit（先向用户确认）**

```bash
git add server/services/emailLiveSync.js server/services/emailLiveSync.test.js
git commit -m "feat: per-mailbox IMAP sync workers"
```

---

### Task 6: 会话归属 —— email_threads 补 mailbox_id

**Files:**
- Modify: `server/services/emailThreader.js`（`assignReplyThread` 约 :187-190 之后、`assignRecordThread` 约 :197 起）
- Test: `server/services/emailThreader.test.js`（追加用例，沿用文件内既有 fake-db 风格）

**Interfaces:**
- Consumes: Task 1 的 `email_threads.mailbox_id`、`email_replies.mailbox_id`、`email_records.mailbox_id`。
- Produces: 会话创建/归属时把首封邮件所在邮箱写入 `email_threads.mailbox_id`（只补空不覆盖）。

- [ ] **Step 1: 写失败测试（追加到 `server/services/emailThreader.test.js`）**

```js
test('assignReplyThread backfills thread mailbox_id from the reply', async () => {
  const calls = [];
  const fakeDb = {
    get: async (sql) => {
      if (String(sql).includes('SELECT mailbox_id FROM email_replies WHERE id = ?')) return { mailbox_id: 9 };
      return null;
    },
    query: async () => [],
    run: async (sql, params) => { calls.push({ sql: String(sql), params }); return { id: 42, changes: 1 }; }
  };
  await emailThreader.assignReplyThread({
    replyId: 5, messageId: '<m5@t>', inReplyTo: null, references: [],
    campaignId: 2, customerId: 7, receivedAt: new Date('2026-08-07T01:00:00Z'), subject: 'Re: x'
  }, fakeDb);
  const backfill = calls.find(({ sql }) => sql.includes('UPDATE email_threads SET mailbox_id'));
  assert.ok(backfill, '应回填会话 mailbox_id');
  assert.equal(backfill.params[0], 9);
});
```

参数名以 `emailLiveSync` 调用 `assignReplyThread` 的实参为准（`replyId/messageId/inReplyTo/references/campaignId/customerId`，时间字段名以 `emailThreader.js` 内实际形参为准）；`emailThreader` 的 require 名沿用该测试文件顶部既有写法。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/emailThreader.test.js`
Expected: 新用例 FAIL（无 `UPDATE email_threads SET mailbox_id` 调用）

- [ ] **Step 3: 实现**

`assignReplyThread` 中，在写入 `email_replies.thread_id` 的 UPDATE（约 :187-190）之后、函数返回前插入（变量名以函数内实际为准）：

```js
    // 多邮箱：会话归属到首封邮件所在邮箱（只补空，不覆盖）
    const replyMailbox = await db.get('SELECT mailbox_id FROM email_replies WHERE id = ?', [params.replyId]);
    if (replyMailbox?.mailbox_id && threadId) {
      await db.run('UPDATE email_threads SET mailbox_id = ? WHERE id = ? AND mailbox_id IS NULL',
        [replyMailbox.mailbox_id, threadId]);
    }
```

`assignRecordThread` 中，在会话确定（threadId 已知）之后同样插入：

```js
    const recordMailbox = await db.get('SELECT mailbox_id FROM email_records WHERE id = ?', [recordId]);
    if (recordMailbox?.mailbox_id && threadId) {
      await db.run('UPDATE email_threads SET mailbox_id = ? WHERE id = ? AND mailbox_id IS NULL',
        [recordMailbox.mailbox_id, threadId]);
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test services/emailThreader.test.js`
Expected: 全部 PASS

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add server/services/emailThreader.js server/services/emailThreader.test.js
git commit -m "feat: attribute threads to mailbox"
```

---

### Task 7: Campaign 绑定发件邮箱（server/routes/campaigns.js）

**Files:**
- Modify: `server/routes/campaigns.js`（POST `/` :519-548、PUT `/:id` :550-598，**CRLF 文件，保持 CRLF**）
- Test: `server/routes/campaigns.test.js`（追加用例，沿用该文件既有 helpers 风格）

**Interfaces:**
- Consumes: Task 1 的 `campaigns.mailbox_id`。
- Produces: `POST /api/campaigns` 与 `PUT /api/campaigns/:id` 接受可选 `mailbox_id`（正整数或 null）；不存在的邮箱返回 400；PUT 传 `null` 可清除绑定（回到默认邮箱）。

- [ ] **Step 1: 写失败测试（追加到 `server/routes/campaigns.test.js`，helpers 用文件内既有写法）**

```js
test('POST /campaigns persists mailbox_id and rejects unknown mailbox', async () => {
  const writes = [];
  await withPatchedDb({
    get: async (sql) => {
      const text = String(sql);
      if (text.includes('FROM campaigns WHERE name = ?')) return null; // 无重名
      if (text.includes('FROM email_settings WHERE id = ?')) return { id: 3 }; // 邮箱存在
      if (text.includes('FROM campaigns WHERE id = ?')) return { id: 8, name: 'P', mailbox_id: 3 };
      return null;
    },
    run: async (sql, params) => { writes.push({ sql: String(sql), params }); return { id: 8, changes: 1 }; }
  }, async () => {
    const res = await callHandler(findHandler(router, 'post', '/'), {
      body: { name: 'P', product: 'X', mailbox_id: 3 }
    });
    assert.equal(res.payload.success, true);
    const insert = writes.find(({ sql }) => sql.includes('INSERT INTO campaigns'));
    assert.ok(insert.sql.includes('mailbox_id'), 'INSERT 应含 mailbox_id 列');
    assert.equal(insert.params.at(-1), 3, 'mailbox_id 落库');
  });

  await withPatchedDb({
    get: async (sql) => {
      const text = String(sql);
      if (text.includes('FROM campaigns WHERE name = ?')) return null;
      if (text.includes('FROM email_settings WHERE id = ?')) return null; // 邮箱不存在
      return null;
    }
  }, async () => {
    const res = await callHandler(findHandler(router, 'post', '/'), {
      body: { name: 'P2', product: 'X', mailbox_id: 999 }
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /发件邮箱不存在/);
  });
});

test('PUT /campaigns/:id can bind and clear mailbox_id', async () => {
  const writes = [];
  const existing = { id: 5, name: 'P', mailbox_id: 3 };
  await withPatchedDb({
    get: async (sql) => {
      const text = String(sql);
      if (text.includes('FROM campaigns WHERE id = ?')) return existing;
      if (text.includes('WHERE name = ? AND id != ?')) return null; // 无重名
      if (text.includes('FROM email_settings WHERE id = ?')) return { id: 7 };
      return null;
    },
    run: async (sql, params) => { writes.push({ sql: String(sql), params }); return { id: 0, changes: 1 }; }
  }, async () => {
    // 绑定到 7
    await callHandler(findHandler(router, 'put', '/:id'), {
      params: { id: '5' }, body: { name: 'P', mailbox_id: 7 }
    });
    let update = writes.find(({ sql }) => sql.includes('UPDATE campaigns SET'));
    let idx = update.sql.split('mailbox_id = ?').length - 1;
    assert.equal(idx, 1, 'UPDATE 应直接赋值 mailbox_id（不用 COALESCE）');
    assert.equal(update.params[7], 7, 'mailbox_id 参数在 negative_keywords 之后、id 之前');

    // 显式传 null 清除绑定
    writes.length = 0;
    await callHandler(findHandler(router, 'put', '/:id'), {
      params: { id: '5' }, body: { name: 'P', mailbox_id: null }
    });
    update = writes.find(({ sql }) => sql.includes('UPDATE campaigns SET'));
    assert.equal(update.params[7], null, '传 null 清除绑定回默认邮箱');
  });
});
```

helpers（`findHandler`/`callHandler`/`withPatchedDb`）与 `router` 变量沿用 `campaigns.test.js` 文件顶部既有定义。注意 PUT 参数下标 7 依赖 Global Constraints 中 UPDATE 的参数顺序（cleanName, brand, product, period, brand_keywords, purchase_keywords, negative_keywords, mailbox_id, id），若实现时调整顺序需同步改下标。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/campaigns.test.js`
Expected: 新用例 FAIL（mailbox_id 未入库/未校验）

- [ ] **Step 3: 实现**

文件顶部（require 区附近）加辅助函数：

```js
async function mailboxExists(id) {
  if (!id) return true;
  const row = await dbOperations.get('SELECT id FROM email_settings WHERE id = ?', [id]);
  return Boolean(row);
}
```

POST `/`（:519-548）：解构加 `mailbox_id`；校验后 INSERT 加列：

```js
    const {
      name, brand, product, period, brand_keywords, purchase_keywords, negative_keywords, mailbox_id
    } = req.body;
    // …name 校验与重名检查保持原样…
    if (!(await mailboxExists(mailbox_id))) {
      return res.status(400).json({ success: false, error: '发件邮箱不存在' });
    }

    const result = await dbOperations.run(
      `INSERT INTO campaigns
        (name, brand, product, campaign_type, status, period,
         brand_keywords, purchase_keywords, negative_keywords, mailbox_id)
       VALUES (?, ?, ?, 'active_project', 'active', ?, ?, ?, ?, ?)`,
      [
        name.trim(), brand || '', product || '', period || '',
        brand_keywords || '', purchase_keywords || '', negative_keywords || '',
        mailbox_id || null
      ]
    );
```

PUT `/:id`（:550-598）：解构加 `mailbox_id`；校验；UPDATE 不用 COALESCE（要支持显式清 NULL），用"未传则保留原值"语义：

```js
    const { name, brand, product, period, brand_keywords, purchase_keywords, negative_keywords, mailbox_id } = req.body;
    // …既有的 cleanName / 存在性 / 重名校验保持原样…
    if (!(await mailboxExists(mailbox_id))) {
      return res.status(400).json({ success: false, error: '发件邮箱不存在' });
    }

    await dbOperations.run(
      `UPDATE campaigns SET
       name = ?,
       brand = COALESCE(?, brand),
       product = ?,
       period = COALESCE(?, period),
       brand_keywords = COALESCE(?, brand_keywords),
       purchase_keywords = COALESCE(?, purchase_keywords),
       negative_keywords = COALESCE(?, negative_keywords),
       mailbox_id = ?,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        cleanName,
        brand ?? null,
        product !== undefined ? product : cleanName,
        period ?? null,
        brand_keywords ?? null,
        purchase_keywords ?? null,
        negative_keywords ?? null,
        mailbox_id === undefined ? campaign.mailbox_id : (mailbox_id || null),
        id
      ]
    );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test routes/campaigns.test.js`
Expected: 全部 PASS

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add server/routes/campaigns.js server/routes/campaigns.test.js
git commit -m "feat: bind campaign to sending mailbox"
```

---

### Task 8: 前端 —— emailApi 多邮箱化 + 邮箱配置 Tab 改列表

**Files:**
- Modify: `client/src/pages/emailApi.js`（:1-32 settings 封装、:282-288 previewEmail 的 senderName）
- Modify: `client/src/pages/Emails.js`（SettingsTab :1118-1389 整段重写）
- Test: `client/src/pages/Emails.test.js`（settings mock 改数组 + 重写邮箱配置用例）

**Interfaces:**
- Consumes: Task 3 的全部 settings API（GET 返回数组、test/test-imap/sync-now 可带 `{ id }`、sync-status 返回数组）。
- Produces（Task 9 依赖）: `getEmailSettings()` 返回邮箱数组（元素含 `id/label/username/sender_name/is_default/enabled/sync_mode` 等，password 为掩码）；`createEmailMailbox(values)`、`saveEmailSettings(id, values)`、`deleteEmailMailbox(id)`、`setDefaultEmailMailbox(id)`、`testEmailSettings(id)`、`testImapSettings(id)`、`syncEmailNow(id)`、`getEmailSyncStatus()` 返回状态数组。

- [ ] **Step 1: 更新测试 mock 与用例（先改测试）**

`client/src/pages/Emails.test.js`：

1. mockApi 中 `/api/emails/settings` 分支改为返回数组：

```js
    if (url === '/api/emails/settings') {
      return Promise.resolve({
        data: {
          data: [
            { id: 1, label: '默认邮箱', username: 'u@x.com', smtp_host: 'smtp.x.com', sync_mode: 'idle', poll_interval_minutes: 5, is_default: 1, enabled: 1, password: '••••••••' }
          ]
        }
      });
    }
    if (url === '/api/emails/settings/sync-status') {
      return Promise.resolve({
        data: {
          data: [
            {
              mailbox_id: 1, username: 'u@x.com', label: '默认邮箱',
              mode: 'idle', status: 'connected',
              last_mail_at: '2026-07-27T06:00:00Z', last_full_sync_at: '2026-07-27T06:10:00Z',
              last_error: null, reconnect_attempts: 0, connected_since: '2026-07-27T05:00:00Z'
            }
          ]
        }
      });
    }
```

2. 原「邮箱配置显示收信模式与连接状态…」用例（:130-148）重写为：

```js
test('邮箱配置以列表展示邮箱，支持测试 IMAP 和立即同步', async () => {
  render(<Emails />);
  await userEvent.click(await screen.findByText('邮箱配置'));

  expect(await screen.findByText('默认邮箱')).toBeInTheDocument();
  expect(screen.getByText('u@x.com')).toBeInTheDocument();
  expect(screen.getByText('已连接')).toBeInTheDocument();

  axios.post.mockResolvedValue({ data: { success: true, message: 'IMAP 连接成功（收件箱 261 封邮件）' } });
  await userEvent.click(screen.getByRole('button', { name: '测试 IMAP' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/emails/settings/test-imap', { id: 1 }));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('IMAP 连接成功（收件箱 261 封邮件）'));

  axios.post.mockResolvedValue({ data: { success: true, message: '同步完成：新收 2，匹配 1，未识别 1' } });
  await userEvent.click(screen.getByRole('button', { name: '立即同步' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/emails/settings/sync-now', { id: 1 }));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('同步完成：新收 2，匹配 1，未识别 1'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd client && CI=true npx react-scripts test src/pages/Emails.test.js --watchAll=false`
Expected: 邮箱配置用例 FAIL（旧 UI 是单表单，无列表/按钮）

- [ ] **Step 3: 改造 emailApi.js**

settings 封装段（:8-32）替换为：

```js
// ---- 邮箱配置（多邮箱） ----

export async function getEmailSettings() {
  const res = await axios.get('/api/emails/settings');
  return res.data.data || [];
}

export async function createEmailMailbox(values) {
  await axios.post('/api/emails/settings', values);
}

// id 为空时走兼容端点（操作默认邮箱）
export async function saveEmailSettings(id, values) {
  if (id) await axios.put(`/api/emails/settings/${id}`, values);
  else await axios.put('/api/emails/settings', values);
}

export async function deleteEmailMailbox(id) {
  await axios.delete(`/api/emails/settings/${id}`);
}

export async function setDefaultEmailMailbox(id) {
  await axios.post(`/api/emails/settings/${id}/default`);
}

export async function testEmailSettings(id) {
  const res = await axios.post('/api/emails/settings/test', id ? { id } : {});
  return res.data.message;
}

export async function testImapSettings(id) {
  const res = await axios.post('/api/emails/settings/test-imap', id ? { id } : {});
  return res.data.message;
}

export async function syncEmailNow(id) {
  const res = await axios.post('/api/emails/settings/sync-now', id ? { id } : {});
  return res.data.message;
}

export async function getEmailSyncStatus() {
  const res = await axios.get('/api/emails/settings/sync-status');
  return res.data.data || [];
}
```

`previewEmail`（:282-288）的 senderName 段改为取默认邮箱：

```js
  let senderName = '';
  try {
    const settings = await getEmailSettings();
    const mailbox = settings.find((m) => m.is_default) || settings[0];
    senderName = mailbox?.sender_name || '';
  } catch (error) {
    senderName = '';
  }
```

- [ ] **Step 4: 重写 SettingsTab（`client/src/pages/Emails.js:1118-1389`）**

保留 `SYNC_STATUS_LABELS`、`SYNC_MODE_LABELS`、`formatSyncTime` 常量。`SettingsTab` 整段替换为（屏蔽规则卡的逻辑与 JSX 原样保留，此处省略号部分即原 :1342-1389 内容，原样搬入）：

```jsx
function SettingsTab() {
  const [form] = Form.useForm();
  const [mailboxes, setMailboxes] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [syncStatuses, setSyncStatuses] = useState([]);
  const [editing, setEditing] = useState(null); // null=关闭弹窗；{}=新增；row=编辑
  const [saving, setSaving] = useState(false);
  const [filterRules, setFilterRules] = useState([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [newRuleType, setNewRuleType] = useState('sender');
  const [newRuleValue, setNewRuleValue] = useState('');
  const syncMode = Form.useWatch('sync_mode', form);

  const fetchMailboxes = useCallback(async () => {
    setListLoading(true);
    try {
      setMailboxes(await getEmailSettings());
    } catch (error) {
      message.error('获取邮箱列表失败');
    } finally {
      setListLoading(false);
    }
  }, []);

  const fetchSyncStatus = useCallback(async () => {
    try {
      setSyncStatuses(await getEmailSyncStatus());
    } catch (error) {
      // 状态接口失败不影响配置页
    }
  }, []);

  const fetchFilterRules = useCallback(async () => {
    setRulesLoading(true);
    try {
      setFilterRules(await getEmailFilterRules());
    } catch (error) {
      message.error('获取屏蔽规则失败');
    } finally {
      setRulesLoading(false);
    }
  }, []);

  useEffect(() => { fetchMailboxes(); fetchSyncStatus(); fetchFilterRules(); }, [fetchMailboxes, fetchSyncStatus, fetchFilterRules]);

  // 收信状态每 15 秒刷新一次
  useEffect(() => {
    const timer = setInterval(fetchSyncStatus, 15000);
    return () => clearInterval(timer);
  }, [fetchSyncStatus]);

  const openEditor = (row) => {
    setEditing(row || {});
    form.resetFields();
    if (row) form.setFieldsValue(row);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing?.id) await saveEmailSettings(editing.id, values);
      else await createEmailMailbox(values);
      message.success('邮箱设置已保存，收信监听已重启');
      setEditing(null);
      fetchMailboxes();
      setTimeout(fetchSyncStatus, 1500);
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (row, enabled) => {
    try {
      await saveEmailSettings(row.id, { ...row, enabled });
      message.success(enabled ? '邮箱已启用' : '邮箱已停用');
      fetchMailboxes();
      setTimeout(fetchSyncStatus, 1500);
    } catch (error) {
      message.error(error.response?.data?.error || '操作失败');
    }
  };

  const handleSetDefault = async (row) => {
    try {
      await setDefaultEmailMailbox(row.id);
      message.success('已设为默认邮箱');
      fetchMailboxes();
    } catch (error) {
      message.error(error.response?.data?.error || '操作失败');
    }
  };

  const handleDelete = async (row) => {
    try {
      await deleteEmailMailbox(row.id);
      message.success('邮箱已删除');
      fetchMailboxes();
      fetchSyncStatus();
    } catch (error) {
      message.error(error.response?.data?.error || '删除失败');
    }
  };

  const handleTest = async (row) => {
    try {
      const msg = await testEmailSettings(row.id);
      message.success(msg || 'SMTP 连接成功');
    } catch (error) {
      message.error(error.response?.data?.error || '连接失败');
    }
  };

  const handleTestImap = async (row) => {
    try {
      const msg = await testImapSettings(row.id);
      message.success(msg || 'IMAP 连接成功');
    } catch (error) {
      message.error(error.response?.data?.error || 'IMAP 连接失败');
    }
  };

  const handleSyncNow = async (row) => {
    try {
      const msg = await syncEmailNow(row.id);
      message.success(msg || '同步完成');
      fetchSyncStatus();
    } catch (error) {
      message.error(error.response?.data?.error || '同步失败');
    }
  };

  // …屏蔽规则的 handleAddRule / handleToggleRule / handleDeleteRule 与原实现完全一致，原样保留…

  const statusByMailbox = new Map(syncStatuses.map((s) => [s.mailbox_id, s]));

  return (
    <div style={{ maxWidth: 960 }}>
      <Card
        title="邮箱配置"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>添加邮箱</Button>}
      >
        <Table
          size="small"
          rowKey="id"
          loading={listLoading}
          pagination={false}
          dataSource={mailboxes}
          columns={[
            { title: '别名', dataIndex: 'label', width: 140, render: (v, row) => (
              <Space size={4}>
                <span>{v || '-'}</span>
                {row.is_default ? <Tag color="blue">默认</Tag> : null}
              </Space>
            ) },
            { title: '邮箱账号', dataIndex: 'username', width: 200 },
            { title: '发件人', dataIndex: 'sender_name', width: 130, render: (v) => v || '-' },
            { title: '收信模式', dataIndex: 'sync_mode', width: 110, render: (v) => SYNC_MODE_LABELS[v] || v || '-' },
            { title: '收信状态', width: 110, render: (_, row) => {
              const st = statusByMailbox.get(row.id);
              const label = SYNC_STATUS_LABELS[st?.status] || { text: st?.status || '-', color: 'default' };
              return <Tag color={label.color}>{label.text}</Tag>;
            } },
            { title: '启用', dataIndex: 'enabled', width: 70, render: (v, row) => (
              <Switch size="small" checked={Boolean(v)} onChange={(checked) => handleToggleEnabled(row, checked)} />
            ) },
            { title: '操作', render: (_, row) => (
              <Space size={0} wrap>
                <Button type="link" size="small" onClick={() => openEditor(row)}>编辑</Button>
                {!row.is_default && <Button type="link" size="small" onClick={() => handleSetDefault(row)}>设默认</Button>}
                <Button type="link" size="small" onClick={() => handleTest(row)}>测试 SMTP</Button>
                <Button type="link" size="small" onClick={() => handleTestImap(row)}>测试 IMAP</Button>
                <Button type="link" size="small" onClick={() => handleSyncNow(row)}>立即同步</Button>
                {!row.is_default && (
                  <Popconfirm title="删除该邮箱？有历史数据时将被拒绝" onConfirm={() => handleDelete(row)}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                )}
              </Space>
            ) }
          ]}
        />
      </Card>

      <Modal
        title={editing?.id ? '编辑邮箱' : '添加邮箱'}
        open={editing !== null}
        onOk={handleSave}
        onCancel={() => setEditing(null)}
        confirmLoading={saving}
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="label" label="邮箱别名" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="如：龙虾公司-企业邮" />
          </Form.Item>
          <Form.Item name="smtp_host" label="SMTP 服务器" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="如 smtp.qiye.aliyun.com" />
          </Form.Item>
          <Space size="large">
            <Form.Item name="smtp_port" label="SMTP 端口" initialValue={465}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
            <Form.Item name="smtp_secure" label="SMTP SSL" valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="imap_host" label="IMAP 服务器（用于回复追踪）">
            <Input placeholder="如 imap.qiye.aliyun.com" />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="imap_port" label="IMAP 端口" initialValue={993}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
            <Form.Item name="imap_secure" label="IMAP TLS" valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
            <Form.Item name="sync_mode" label="收信模式" initialValue="idle">
              <Select style={{ width: 180 }} options={[
                { value: 'idle', label: '实时监听（推荐）' },
                { value: 'poll', label: '定时轮询' },
                { value: 'off', label: '关闭回复同步' }
              ]} />
            </Form.Item>
            {(syncMode || 'idle') === 'poll' && (
              <Form.Item name="poll_interval_minutes" label="轮询间隔（分钟）" initialValue={5}>
                <InputNumber min={1} max={120} />
              </Form.Item>
            )}
          </Space>
          <Form.Item name="username" label="邮箱账号" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="you@company.com" />
          </Form.Item>
          <Form.Item name="password" label="授权码 / 三方客户端安全密码">
            <Input.Password placeholder="阿里邮箱建议填三方客户端安全密码" />
          </Form.Item>
          <Form.Item name="sender_name" label="发件人显示名">
            <Input placeholder="如 MOOER Marketing" />
          </Form.Item>
          <Form.Item name="default_cc" label="默认抄送">
            <TextArea rows={2} placeholder="多个地址用逗号/分号/换行分隔" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 屏蔽规则卡：原 :1342-1389 的 Card 原样保留在此 */}
    </div>
  );
}
```

import 同步调整：`emailApi` 引入改为 `getEmailSettings, createEmailMailbox, saveEmailSettings, deleteEmailMailbox, setDefaultEmailMailbox, testEmailSettings, testImapSettings, syncEmailNow, getEmailSyncStatus, getEmailFilterRules, ...`；AntD 引入补 `Modal`（如未引入）。删除不再使用的 `testing/testingImap/syncing/syncStatus` 旧 state 与旧 handlers。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd client && CI=true npx react-scripts test src/pages/Emails.test.js --watchAll=false`
Expected: 全部 PASS

- [ ] **Step 6: Commit（先向用户确认）**

```bash
git add client/src/pages/emailApi.js client/src/pages/Emails.js client/src/pages/Emails.test.js
git commit -m "feat: mailbox list UI in settings tab"
```

---

### Task 9: Campaign 邮箱下拉 + 列表邮箱标识

**Files:**
- Modify: `server/routes/emails.js`（/drafts :309-322、/records :205-213、/replies :515-528 三处查询加 JOIN + `mailbox_id` 筛选参数）
- Modify: `client/src/pages/CampaignCreateModal.js`（提交 :38-43、表单 :79-109）
- Modify: `client/src/pages/CampaignManageModal.js`（openEditor :49-55、保存 :73-78、表单 :148-176）
- Modify: `client/src/pages/Emails.js`（草稿列 :556-559、回复列 :838/:856/:880 附近、审批记录列 :1054 附近）
- Test: `server/routes/emails.test.js`（/drafts 返回 mailbox 字段用例）、`client/src/pages/Emails.test.js`（如 mock 数据补充字段后断言列展示）

**Interfaces:**
- Consumes: Task 7 的 `mailbox_id` 入参；Task 8 的 `getEmailSettings()` 数组。
- Produces: `/api/emails/drafts`、`/api/emails/records`、`/api/emails/replies` 的每行新增 `mailbox_label`、`mailbox_username` 字段，并支持可选查询参数 `mailbox_id`（正整数）过滤；Campaign 新建/编辑弹窗有「发件邮箱」下拉。

- [ ] **Step 1: 服务端查询加邮箱字段与筛选参数**

`/drafts` 查询（:309-322）：SELECT 列表加 `ms.label AS mailbox_label, ms.username AS mailbox_username`，JOIN 区加 `LEFT JOIN email_settings ms ON ms.id = d.mailbox_id`；query 解析处加筛选：

```js
    if (mailbox_id) { conditions.push('d.mailbox_id = ?'); params.push(Number(mailbox_id)); }
```

（`mailbox_id` 从 `req.query` 解构，与既有 `status/kind/risk_level/campaign_id` 并列。）

`/records` 查询（:205-213）：SELECT 加 `ms.label AS mailbox_label, ms.username AS mailbox_username`，加 `LEFT JOIN email_settings ms ON ms.id = er.mailbox_id`；筛选处加：

```js
    if (mailbox_id) { conditions.push('er.mailbox_id = ?'); params.push(Number(mailbox_id)); }
```

`/replies` 查询（:515-528）：SELECT 加 `ms.label AS mailbox_label, ms.username AS mailbox_username`，加 `LEFT JOIN email_settings ms ON ms.id = er.mailbox_id`；筛选处加（注意 `er` 在该查询里别名指 email_replies）：

```js
    if (mailbox_id) { conditions.push('er.mailbox_id = ?'); params.push(Number(mailbox_id)); }
```

在 `server/routes/emails.test.js` 追加用例（mock `dbOperations.query` 返回含 `mailbox_label` 的行，断言透传；JOIN 与筛选条件断言 SQL 文本）：

```js
test('GET /drafts joins mailbox label and filters by mailbox_id', async () => {
  await withPatchedDb({
    query: async (sql, params = []) => {
      if (String(sql).includes('FROM email_drafts')) {
        assert.ok(String(sql).includes('LEFT JOIN email_settings ms ON ms.id = d.mailbox_id'), '草稿查询应 JOIN 邮箱表');
        assert.ok(String(sql).includes('d.mailbox_id = ?'), '应按 mailbox_id 过滤');
        assert.deepEqual(params, [2]);
        return [{ id: 1, subject: 'Hi', mailbox_label: 'B 业务', mailbox_username: 'b@x.com' }];
      }
      return [];
    }
  }, async () => {
    const res = await callHandler(findHandler(router, 'get', '/drafts'), { query: { mailbox_id: '2' } });
    assert.equal(res.payload.data.drafts[0].mailbox_label, 'B 业务');
  });
});
```

- [ ] **Step 2: 跑服务端测试**

Run: `cd server && node --test routes/emails.test.js`
Expected: 全部 PASS

- [ ] **Step 3: Campaign 弹窗加下拉**

`CampaignCreateModal.js`：顶部 `import { getEmailSettings } from './emailApi';`；组件内加 state 与加载：

```js
  const [mailboxes, setMailboxes] = useState([]);
  useEffect(() => {
    if (!open) return;
    getEmailSettings().then((rows) => setMailboxes((rows || []).filter((m) => m.enabled))).catch(() => {});
  }, [open]);
```

（`open` 的 prop 名以该组件实际为准。）提交体（:38-43）加 `mailbox_id: values.mailbox_id || null`。表单的「项目周期」之后插入：

```jsx
        <Form.Item label="发件邮箱" name="mailbox_id" tooltip="不选则使用默认邮箱">
          <Select
            allowClear
            placeholder="默认邮箱"
            options={mailboxes.map((m) => ({ value: m.id, label: `${m.label || m.username}（${m.username}）` }))}
          />
        </Form.Item>
```

`CampaignManageModal.js`：同样引入与加载 mailboxes；`openEditor`（:49-55）的 `form.setFieldsValue({...})` 加 `mailbox_id: editing.campaign.mailbox_id ?? undefined`；保存体（:73-78）加 `mailbox_id: values.mailbox_id ?? null`；表单「项目周期」之后插入同一个 Form.Item。

- [ ] **Step 4: 列表加邮箱标识列**

`client/src/pages/Emails.js`：

草稿列表（:556-559 区域），在「项目」列后插入：

```js
    { title: '发件邮箱', dataIndex: 'mailbox_label', width: 130, render: (v, r) => v || r.mailbox_username || '-' },
```

回复相关三张表（:838、:856、:880 区域），在「发件人」列后插入：

```js
    { title: '收件邮箱', dataIndex: 'mailbox_label', width: 130, render: (v, r) => v || r.mailbox_username || '-' },
```

审批记录表（:1054 区域），在「项目」列后插入同草稿列表的「发件邮箱」列。

- [ ] **Step 4b: 三个 Tab 加按邮箱筛选 + 审批回退警告提示**

在审批台（ApprovalTab）、邮件待办（RepliesTab）、审批记录（ApprovalHistoryTab）各自的筛选区加一个「邮箱」下拉（与各 Tab 既有筛选项并列，state 命名沿用该 Tab 既有筛选 state 的风格）：

```jsx
<Select
  allowClear
  placeholder="全部邮箱"
  style={{ width: 180 }}
  options={mailboxes.map((m) => ({ value: m.id, label: m.label || m.username }))}
  onChange={(value) => setMailboxId(value)}
/>
```

- `mailboxes` 在各 Tab 内通过 `getEmailSettings()` 加载（`useEffect` 挂载时拉一次，失败静默）。
- 对应 `emailApi.js` 的列表封装（草稿/回复/记录三个函数，名字以文件实际为准）的查询参数加可选 `mailbox_id`；各 Tab 的请求处把选中的 `mailboxId` 传入。
- 审批台「通过/发送」成功回调处（`approveDraft`/`sendDraft` 调用成功后），若响应 `data?.warning` 非空则 `message.warning(res.data.warning)`，让"已回退默认邮箱发送"对审批人可见。

`Emails.test.js` 的列表 mock 数据（草稿/回复）补 `mailbox_label: '默认邮箱'` 字段，并在审批台用例中断言「发件邮箱」列渲染出该文案；筛选下拉渲染断言 `expect(screen.getByText('全部邮箱')).toBeInTheDocument()`（ApprovalTab 区域）。

- [ ] **Step 5: 跑前端测试**

Run: `cd client && CI=true npx react-scripts test src/pages/Emails.test.js --watchAll=false`
Expected: 全部 PASS

- [ ] **Step 6: Commit（先向用户确认）**

```bash
git add server/routes/emails.js server/routes/emails.test.js client/src/pages/CampaignCreateModal.js client/src/pages/CampaignManageModal.js client/src/pages/Emails.js client/src/pages/Emails.test.js
git commit -m "feat: campaign mailbox picker and mailbox badges in email lists"
```

---

### Task 10: 全量回归 + 手工冒烟

- [ ] **Step 1: 服务端全量测试**

Run: `cd server && npm test`
Expected: 全部 PASS

- [ ] **Step 2: 前端全量测试**

Run: `cd client && CI=true npm test -- --watchAll=false`
Expected: 全部 PASS

- [ ] **Step 3: 前端构建**

Run: `cd client && npm run build`
Expected: 构建成功，无新增 warning

- [ ] **Step 4: 手工冒烟（开发库已跑过 Task 1 迁移）**

1. `cd server && npm run dev` 启动服务，日志应出现每个启用邮箱的回复追踪行（如 `[email] 回复追踪（u@x.com）：实时监听模式（IMAP IDLE）。`）
2. 邮箱配置 Tab：添加第二个邮箱 → 测试 SMTP/IMAP → 立即同步 → 设为默认/停用/删除（有数据拒绝）各走一遍
3. Campaign 绑定第二个邮箱 → 生成草稿 → 审批发送 → 检查 `email_records.mailbox_id` 与发件箱发件人
4. 向两个邮箱各回一封邮件 → 邮件待办中「收件邮箱」标识正确

- [ ] **Step 5: 更新文档**

在 `README-启动说明.md` 或相关运维文档中补一句多邮箱说明（如已有邮箱配置章节则就地更新；没有则跳过，不新增文档文件）。

- [ ] **Step 6: Final Commit（先向用户确认）**

```bash
git add -A
git commit -m "docs: note multi-mailbox support"
```
