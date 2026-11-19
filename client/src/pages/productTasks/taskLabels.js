export const REVIEW = { pending: '待审核', approved: '审核通过', rejected: '审核不通过' };
export const COOPERATION = { candidate: '候选', negotiating: '洽谈中', confirmed: '已确认合作', shipped: '已寄样', producing: '制作中', published: '已发布', completed: '已完成', cancelled: '已取消' };
export const INTENT = { unknown: '尚未表态', interested: '有意向', question: '需要沟通', rejected: '拒绝本次产品' };
export const OUTREACH = { not_contacted: '未触达', waiting_reply: '待回复', replied: '已回复', contact_failed: '联系异常' };
export const options = (labels) => Object.entries(labels).map(([value, label]) => ({ value, label }));
export const dateText = (value) => value ? String(value).slice(0, 10) : '未确认';
export const isCooperating = (row) => ['confirmed', 'shipped', 'producing', 'published', 'completed'].includes(row.cooperation_status);
export function suggestedTasks(customer, tasks) {
  const fits = customer.product_recommendations || [];
  return tasks.filter((task) => task.status === 'active' && task.task_type !== 'delivery_follow_up'
    && task.products?.length && task.products.every((product) => fits.some((fit) => (
      Number(fit.product_id) === Number(product.product_id) || (fit.sku && fit.sku === product.sku)
    )))).map((task) => task.id);
}
