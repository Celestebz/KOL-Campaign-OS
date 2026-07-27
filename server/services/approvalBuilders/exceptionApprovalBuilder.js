// 异常处理 builder：finder_tasks 失败（failed/partial_failed） + email_drafts 发送失败（send_failed）
//   + automation_runs 失败（failed/partial_failed，阶段 D1：后台任务失败进异常队列，retry 只重跑失败项）。
const { dbOperations } = require('../../database');
const { clean, truncate, iso, openAction, parseJson } = require('./shared');

// run_type → 中文标签（未知类型原样展示 run_type）
const RUN_TYPE_LABELS = {
  email_draft_batch: '批量邮件起草'
};

// run_type → 工作台“去处理”跳转（未知类型回退首页）
const RUN_TYPE_HREFS = {
  email_draft_batch: '/emails'
};

async function buildExceptionItems() {
  const finderRows = await dbOperations.query(
    `SELECT ft.id, ft.campaign_id, ft.name, ft.platform, ft.status,
            ft.error_message, ft.result_count, ft.success_count, ft.failed_count, ft.updated_at,
            c.name AS campaign_name
     FROM finder_tasks ft
     LEFT JOIN campaigns c ON c.id = ft.campaign_id
     WHERE ft.status IN ('failed', 'partial_failed')
     ORDER BY ft.updated_at DESC
     LIMIT 50`
  );
  const emailRows = await dbOperations.query(
    `SELECT d.id, d.campaign_id, d.customer_id, d.subject, d.updated_at,
            k.name AS kol_name, c.name AS campaign_name,
            (SELECT r.error FROM email_records r
             WHERE r.draft_id = d.id AND r.status = 'failed'
             ORDER BY r.id DESC LIMIT 1) AS send_error
     FROM email_drafts d
     LEFT JOIN customers k ON k.id = d.customer_id
     LEFT JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.status = 'send_failed'
     ORDER BY d.updated_at DESC
     LIMIT 50`
  );

  const runRows = await dbOperations.query(
    `SELECT r.id, r.campaign_id, r.run_type, r.status, r.progress_json, r.last_error, r.updated_at,
            c.name AS campaign_name
     FROM automation_runs r
     LEFT JOIN campaigns c ON c.id = r.campaign_id
     WHERE r.status IN ('failed', 'partial_failed')
     ORDER BY r.updated_at DESC
     LIMIT 50`
  );

  const finderItems = finderRows.map((row) => {
    // Older Finder runs could be marked failed when result import succeeded but a
    // later binding/finalization step failed. Treat those as partial success so
    // the workbench does not encourage users to rerun the whole search and create
    // duplicate candidates.
    const successCount = Number(row.success_count || row.result_count || 0);
    const failedCount = Number(row.failed_count || 0);
    const isPartialSuccess = row.status === 'partial_failed' || successCount > 0;
    const facts = [`失败节点：Finder 任务（${clean(row.platform) || '未知平台'}）`];
    if (clean(row.error_message)) facts.push(`错误信息：${truncate(row.error_message, 200)}`);
    if (isPartialSuccess) {
      facts.push(`部分完成：成功 ${successCount} 条，失败 ${failedCount} 条`);
    }
    return {
      id: `exception:finder:${row.id}`,
      type: 'exception',
      subject_type: 'finder',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${clean(row.name) || `Finder 任务 #${row.id}`} · ${isPartialSuccess ? '部分成功（收尾失败）' : '执行失败'}`,
      dedupe_key: `exception:finder:${row.id}`,
      risk_level: isPartialSuccess ? 'medium' : 'high',
      facts,
      opinion: isPartialSuccess
        ? '已有结果，请只处理失败的收尾节点；不要重新执行整个 Finder，以免重复导入候选。'
        : '建议重试失败节点；如多次失败请人工处理。',
      risks: isPartialSuccess
        ? ['已有搜索结果，整任务重跑可能重复导入候选']
        : ['任务中断，后续达人搜索/分析流程未推进'],
      actions: openAction('/finder'),
      updated_at: iso(row.updated_at)
    };
  });

  const emailItems = emailRows.map((row) => {
    const kolName = clean(row.kol_name) || `达人 #${row.customer_id}`;
    const facts = ['失败节点：邮件发送'];
    if (clean(row.send_error)) facts.push(`错误信息：${truncate(row.send_error, 200)}`);
    if (clean(row.subject)) facts.push(`邮件主题：${truncate(row.subject, 80)}`);
    return {
      id: `exception:email:${row.id}`,
      type: 'exception',
      subject_type: 'email_draft',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 邮件发送失败`,
      dedupe_key: `exception:email:${row.id}`,
      risk_level: 'high',
      facts,
      opinion: '建议检查 SMTP 配置后重新发送。',
      risks: ['达人触达中断'],
      actions: openAction('/emails'),
      updated_at: iso(row.updated_at)
    };
  });

  const runItems = runRows.map((row) => {
    const typeLabel = RUN_TYPE_LABELS[row.run_type] || clean(row.run_type) || '未知类型';
    const progress = parseJson(row.progress_json, {}) || {};
    const facts = [`失败节点：后台任务（${typeLabel}）`];
    facts.push(`进度：${progress.completed || 0}/${progress.total || 0} 完成，成功 ${progress.succeeded || 0} 条，失败 ${progress.failed || 0} 条`);
    if (clean(row.last_error)) facts.push(`错误信息：${truncate(row.last_error, 200)}`);
    return {
      id: `exception:run:${row.id}`,
      type: 'exception',
      subject_type: 'automation_run',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${typeLabel} #${row.id} · ${row.status === 'partial_failed' ? '部分失败' : '执行失败'}`,
      dedupe_key: `exception:run:${row.id}`,
      risk_level: 'high',
      facts,
      opinion: '建议重试失败项（只重跑失败条目，已成功的不会重复执行）。',
      risks: ['后台任务中断，后续流程未推进'],
      actions: openAction(RUN_TYPE_HREFS[row.run_type] || '/'),
      updated_at: iso(row.updated_at)
    };
  });

  return [...finderItems, ...emailItems, ...runItems];
}

module.exports = { buildExceptionItems };
