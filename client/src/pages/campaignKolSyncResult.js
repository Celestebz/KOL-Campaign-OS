// Summarize a /api/sync/feishu/push response into an antd message type + content.
// All succeeded -> success; partial failure -> warning; all failed -> error.
// Failure messages include the first per-record error so users see why sync failed.
export function describeSyncResult(data = {}) {
  const successCount = data.success_count || 0;
  const failedCount = data.failed_count || 0;
  const firstError = (data.results || []).find((item) => item && !item.success)?.error || '';

  if (failedCount === 0) {
    return { type: 'success', content: `同步完成：成功 ${successCount}，失败 0` };
  }
  if (successCount === 0) {
    return {
      type: 'error',
      content: `同步失败：${failedCount} 条全部失败${firstError ? `，原因：${firstError}` : ''}`
    };
  }
  return {
    type: 'warning',
    content: `同步部分成功：成功 ${successCount}，失败 ${failedCount}${firstError ? `，首个失败原因：${firstError}` : ''}`
  };
}
