import axios from 'axios';

// 工作台前端 API 封装：走真实后端接口 /api/workbench（后端并行开发中）。
// 契约见 docs/superpowers/specs/2026-07-25-boss-workbench-upgrade.md 13.1。
// 不写 mock 数据：请求失败时由调用方降级为空态展示。

export async function getWorkbench() {
  const res = await axios.get('/api/workbench');
  const payload = res.data;
  // 兼容 { summary, items, recent_decisions } 与统一包装的 { data: {...} } 两种返回。
  const data = payload && payload.summary ? payload : (payload && payload.data) || {};
  return {
    summary: data.summary || {},
    items: data.items || [],
    recent_decisions: data.recent_decisions || []
  };
}

// 提交人工决定：decision ∈ approve/reject/request_changes/pause/retry/skip/stop。
// version 必须传当前 item.version 做乐观锁；冲突时后端返回 409，由调用方处理。
export async function submitDecision(approvalItemId, { decision, note, version }) {
  const res = await axios.post(`/api/approvals/${approvalItemId}/decision`, {
    decision,
    note,
    version,
    decided_by: 'boss'
  });
  return res.data;
}
