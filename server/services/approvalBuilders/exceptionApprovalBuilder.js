// 异常处理 builder：finder_tasks 失败（failed/partial_failed） + email_drafts 发送失败（send_failed）。
const { dbOperations } = require('../../database');
const { clean, truncate, iso, openAction } = require('./shared');

async function buildExceptionItems() {
  const finderRows = await dbOperations.query(
    `SELECT ft.id, ft.campaign_id, ft.name, ft.platform, ft.status,
            ft.error_message, ft.success_count, ft.failed_count, ft.updated_at,
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

  const finderItems = finderRows.map((row) => {
    const facts = [`失败节点：Finder 任务（${clean(row.platform) || '未知平台'}）`];
    if (clean(row.error_message)) facts.push(`错误信息：${truncate(row.error_message, 200)}`);
    if (row.status === 'partial_failed') {
      facts.push(`部分完成：成功 ${row.success_count || 0} 条，失败 ${row.failed_count || 0} 条`);
    }
    return {
      id: `exception:finder:${row.id}`,
      type: 'exception',
      subject_type: 'finder',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${clean(row.name) || `Finder 任务 #${row.id}`} · 执行失败`,
      dedupe_key: `exception:finder:${row.id}`,
      risk_level: 'high',
      facts,
      opinion: '建议重试失败节点；如多次失败请人工处理。',
      risks: ['任务中断，后续达人搜索/分析流程未推进'],
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

  return [...finderItems, ...emailItems];
}

module.exports = { buildExceptionItems };
