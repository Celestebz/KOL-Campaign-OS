module.exports = {
  async up(q, S) {
    const tables = new Set((await q.showAllTables()).map((name) => typeof name === 'string' ? name : name.tableName));
    const id = () => ({ type: S.INTEGER, primaryKey: true, autoIncrement: true });
    const ref = (table) => ({ type: S.INTEGER, allowNull: false, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const timestamps = () => ({ created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } });
    if (!tables.has('campaign_tasks')) {
      await q.createTable('campaign_tasks', {
        id: id(), campaign_id: ref('campaigns'), name: { type: S.STRING(255), allowNull: false },
        task_type: { type: S.STRING(30), allowNull: false, defaultValue: 'recruitment' },
        status: { type: S.STRING(30), allowNull: false, defaultValue: 'active' },
        priority: { type: S.INTEGER, allowNull: false, defaultValue: 0 }, owner: S.STRING(255),
        approval_due_at: S.DATEONLY, publish_from: S.DATEONLY, publish_due_at: S.DATEONLY,
        sample_min: S.INTEGER, sample_max: S.INTEGER, candidate_target: S.INTEGER,
        requirements: S.TEXT, import_key: S.STRING(64), ...timestamps()
      });
      await q.addIndex('campaign_tasks', ['campaign_id', 'status']);
      await q.addIndex('campaign_tasks', ['campaign_id', 'import_key'], { unique: true, name: 'task_import_unique' });
    }
    if (!tables.has('campaign_task_products')) {
      await q.createTable('campaign_task_products', {
        id: id(), task_id: ref('campaign_tasks'), campaign_product_id: ref('campaign_products'), ...timestamps()
      });
      await q.addIndex('campaign_task_products', ['task_id', 'campaign_product_id'], { unique: true, name: 'task_product_unique' });
    }
    if (!tables.has('campaign_kol_tasks')) {
      await q.createTable('campaign_kol_tasks', {
        id: id(), task_id: ref('campaign_tasks'), campaign_kol_id: ref('campaign_kols'),
        review_status: { type: S.STRING(30), allowNull: false, defaultValue: 'pending' },
        cooperation_status: { type: S.STRING(30), allowNull: false, defaultValue: 'candidate' },
        intent: { type: S.STRING(30), allowNull: false, defaultValue: 'unknown' },
        next_follow_up_at: S.DATE, agreed_publish_at: S.DATEONLY, received_at: S.DATEONLY,
        draft_due_at: S.DATEONLY, published_at: S.DATEONLY, video_url: S.STRING(2048),
        quoted_fee: S.STRING(255), notes: S.TEXT, ...timestamps()
      });
      await q.addIndex('campaign_kol_tasks', ['task_id', 'campaign_kol_id'], { unique: true, name: 'task_kol_unique' });
      await q.addIndex('campaign_kol_tasks', ['campaign_kol_id']);
    }
    if (!tables.has('campaign_task_events')) {
      await q.createTable('campaign_task_events', {
        id: id(), kol_task_id: ref('campaign_kol_tasks'), actor_id: S.INTEGER,
        event_type: { type: S.STRING(50), allowNull: false }, summary: S.TEXT,
        occurred_at: { type: S.DATE, allowNull: false }, ...timestamps()
      });
      await q.addIndex('campaign_task_events', ['kol_task_id', 'occurred_at']);
    }
    if (!tables.has('email_task_links')) {
      await q.createTable('email_task_links', {
        id: id(), draft_id: ref('email_drafts'), kol_task_id: ref('campaign_kol_tasks'),
        snapshot: { type: S.TEXT, allowNull: false }, ...timestamps()
      });
      await q.addIndex('email_task_links', ['draft_id', 'kol_task_id'], { unique: true, name: 'email_task_unique' });
      await q.addIndex('email_task_links', ['kol_task_id']);
    }
    // A DDL interruption may leave a table created but its indexes unfinished.
    for (const [table, fields, name, unique] of [
      ['campaign_tasks', ['campaign_id', 'status'], 'campaign_tasks_campaign_id_status', false],
      ['campaign_tasks', ['campaign_id', 'import_key'], 'task_import_unique', true],
      ['campaign_task_products', ['task_id', 'campaign_product_id'], 'task_product_unique', true],
      ['campaign_kol_tasks', ['task_id', 'campaign_kol_id'], 'task_kol_unique', true],
      ['campaign_kol_tasks', ['campaign_kol_id'], 'campaign_kol_tasks_campaign_kol_id', false],
      ['campaign_task_events', ['kol_task_id', 'occurred_at'], 'campaign_task_events_kol_task_id_occurred_at', false],
      ['email_task_links', ['draft_id', 'kol_task_id'], 'email_task_unique', true],
      ['email_task_links', ['kol_task_id'], 'email_task_links_kol_task_id', false],
      ['email_records', ['draft_id', 'status'], 'task_mail_draft_status', false],
      ['email_records', ['thread_id', 'owner_user_id', 'created_at', 'id'], 'task_mail_thread_time', false]
    ]) {
      if (!(await q.showIndex(table)).some((index) => index.name === name)) await q.addIndex(table, fields, { name, unique });
    }
  },
  async down() {
    throw new Error('任务和触达历史不自动删除；请使用经过审阅的数据迁移。');
  }
};
