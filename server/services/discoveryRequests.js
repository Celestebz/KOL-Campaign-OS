const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const platforms = new Set(['youtube', 'instagram', 'tiktok']);
const stages = new Set(['searching', 'verifying', 'analyzing', 'writing', 'done']);
const positiveId = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw error(400, 'Invalid id');
  return n;
};
const key = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw error(400, 'A stable request/execution key (8-80 characters) is required');
  return value;
};

// Dependency injection keeps workflow tests isolated from production credentials/data.
function createDiscoveryService({ model, sequelize, query, createFinderTask }) {
  const publicData = (row) => {
    const data = row.toJSON ? row.toJSON() : { ...row };
    delete data.execution_id;
    delete data.owner_user_id;
    delete data.request_key;
    return { ...data, candidate_count: Number(data.candidate_count || 0) };
  };
  const owner = (value) => positiveId(value);
  const find = async (userId, id, transaction) => {
    const row = await model.findOne({ where: { id: positiveId(id), owner_user_id: owner(userId) },
      ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) throw error(404, '找人需求不存在');
    return row;
  };
  const binding = async (strategyId, transaction) => {
    const [row] = await query(`SELECT ks.id, ks.campaign_id, ks.campaign_product_id, ks.name AS strategy_name,
      c.name AS campaign_name, p.name AS product_name
      FROM kol_strategies ks JOIN campaigns c ON c.id = ks.campaign_id
      JOIN campaign_products cp ON cp.id = ks.campaign_product_id AND cp.campaign_id = c.id
      JOIN products p ON p.id = cp.product_id
      WHERE ks.id = ? AND ks.status = 'ready' AND c.status = 'active'
        AND cp.status = 'active' AND p.status = 'active'`, [positiveId(strategyId)], transaction);
    if (!row) throw error(409, '请先为有效项目产品发布搜索策略');
    return row;
  };
  async function describe(row) {
    const data = publicData(row);
    const [context] = await query(`SELECT c.name AS campaign_name, p.name AS product_name, ks.name AS strategy_name
      FROM kol_strategies ks LEFT JOIN campaigns c ON c.id = ?
      LEFT JOIN campaign_products cp ON cp.id = ?
      LEFT JOIN products p ON p.id = cp.product_id WHERE ks.id = ?`, [row.campaign_id, row.campaign_product_id, row.strategy_id]);
    const [counts] = row.finder_task_id ? await query(`SELECT COUNT(*) AS candidate_count FROM raw_candidates
      WHERE finder_task_id = ? AND status NOT IN ('ignored', 'duplicate', 'error')`, [row.finder_task_id]) : [{ candidate_count: 0 }];
    return { ...data, ...context, candidate_count: Number(counts?.candidate_count || 0) };
  }
  async function create(userId, body) {
    const input = { owner_user_id: owner(userId), request_key: key(body.request_key),
      strategy_id: positiveId(body.strategy_id), target_platform: body.target_platform,
      target_count: Number(body.target_count), requirements: String(body.requirements || '').trim() };
    if (!platforms.has(input.target_platform)) throw error(400, '请选择一个目标平台');
    if (!Number.isInteger(input.target_count) || input.target_count < 1 || input.target_count > 50) throw error(400, '每次目标人数为 1–50');
    if (!input.requirements || input.requirements.length > 5000) throw error(400, '请填写找人要求（最多 5000 字）');
    const existing = await model.findOne({ where: { owner_user_id: input.owner_user_id, request_key: input.request_key } });
    if (existing) {
      if (['strategy_id', 'target_platform', 'target_count', 'requirements'].some((field) => existing[field] !== input[field])) throw error(409, '此提交标识已用于其他需求，请刷新后重试');
      return describe(existing);
    }
    const context = await binding(input.strategy_id);
    try {
      return await describe(await model.create({ ...input, campaign_id: context.campaign_id,
        campaign_product_id: context.campaign_product_id, status: 'queued', stage: 'waiting' }));
    } catch (e) {
      if (e.name === 'SequelizeUniqueConstraintError') return create(userId, body);
      throw e;
    }
  }
  async function claim(userId, id, body) {
    const executionId = key(body.execution_id);
    const row = await sequelize.transaction(async (transaction) => {
      const request = await find(userId, id, transaction);
      if (request.status === 'running' && request.execution_id === executionId) return request;
      if (request.status !== 'queued') throw error(409, '需求已被领取或已停止，请勿重复执行');
      const context = await binding(request.strategy_id, transaction);
      if (context.campaign_id !== request.campaign_id || context.campaign_product_id !== request.campaign_product_id) throw error(409, '策略的项目产品绑定已变化，请新建需求');
      if (!request.finder_task_id) {
        const task = await createFinderTask({ strategyId: request.strategy_id, targetPlatform: request.target_platform,
          limit: request.target_count, notes: request.requirements, searchSource: `${request.target_platform}_search`, autoStart: false, transaction });
        request.finder_task_id = task.id;
      }
      request.status = 'running';
      request.stage = 'searching';
      request.execution_id = executionId;
      request.heartbeat_at = new Date();
      request.progress_note = 'Agent 已接手';
      await request.save({ transaction });
      return request;
    });
    return describe(row);
  }
  async function active(userId, id, executionId, transaction) {
    const row = await find(userId, id, transaction);
    if (row.status !== 'running' || row.execution_id !== key(executionId)) throw error(409, '当前 Agent 不再持有此需求，请停止执行');
    return row;
  }
  async function progress(userId, id, body) {
    const status = body.status || 'running';
    const stage = body.stage;
    const note = String(body.note || '').trim();
    if (!['running', 'blocked', 'completed'].includes(status) || !stages.has(stage) || note.length > 2000) throw error(400, 'Invalid progress');
    if (status !== 'running' && !note) throw error(400, '结束或阻塞时必须说明结果，包括未达标原因');
    if ((status === 'completed') !== (stage === 'done')) throw error(400, 'Completed requests must use stage=done');
    const row = await sequelize.transaction(async (transaction) => {
      const request = await find(userId, id, transaction);
      if (status !== 'running' && request.execution_id === key(body.execution_id) && request.status === status && request.stage === stage && request.progress_note === note) return request;
      key(body.execution_id);
      if (request.status !== 'running' || request.execution_id !== body.execution_id) throw error(409, '当前 Agent 不再持有此需求，请停止执行');
      request.status = status;
      request.stage = stage;
      request.progress_note = note;
      request.heartbeat_at = new Date();
      await request.save({ transaction });
      return request;
    });
    return describe(row);
  }
  async function control(userId, id, action) {
    const row = await sequelize.transaction(async (transaction) => {
      const request = await find(userId, id, transaction);
      if (action === 'cancel') {
        if (!['queued', 'running', 'blocked'].includes(request.status)) throw error(409, '需求已结束');
        request.status = 'cancelled';
        request.progress_note = '已停止后续执行；已在处理的单次请求可能仍会完成';
      } else if (action === 'retry') {
        if (!['blocked', 'cancelled'].includes(request.status)) throw error(409, '请先停止任务，再交给 Agent 继续');
        request.status = 'queued';
        request.stage = 'waiting';
        request.progress_note = '等待 Agent 继续，保留已有证据与结果';
        request.execution_id = null;
      } else throw error(400, 'Invalid action');
      await request.save({ transaction });
      return request;
    });
    return describe(row);
  }
  return { create, claim, active, progress, control,
    get: async (userId, id) => describe(await find(userId, id)),
    list: async (userId) => (await query(`SELECT dr.*, c.name AS campaign_name, p.name AS product_name, ks.name AS strategy_name,
      (SELECT COUNT(*) FROM raw_candidates rc WHERE rc.finder_task_id = dr.finder_task_id
        AND rc.status NOT IN ('ignored', 'duplicate', 'error')) AS candidate_count
      FROM discovery_requests dr LEFT JOIN campaigns c ON c.id = dr.campaign_id
      LEFT JOIN campaign_products cp ON cp.id = dr.campaign_product_id
      LEFT JOIN products p ON p.id = cp.product_id LEFT JOIN kol_strategies ks ON ks.id = dr.strategy_id
      WHERE dr.owner_user_id = ? ORDER BY dr.id DESC LIMIT 50`, [owner(userId)])).map(publicData) };
}

let instance;
function getService() {
  if (!instance) {
    const { models, sequelize, Sequelize } = require('../database');
    instance = createDiscoveryService({ model: models.DiscoveryRequest, sequelize,
      query: (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: Sequelize.QueryTypes.SELECT, logging: false }),
      createFinderTask: (...args) => require('../routes/finderTasks').createFinderTask(...args) });
  }
  return instance;
}
module.exports = { createDiscoveryService, getService };
