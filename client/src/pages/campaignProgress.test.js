import {
  deriveCampaignStage,
  deriveProgressText,
  deriveResponsibility,
  normalizeCampaignProgress,
  pendingApprovalCount
} from './campaignProgress';

const detail = (overrides = {}) => ({
  campaign: { id: 1, name: '测试项目', status: 'active' },
  strategy: { id: 2, status: 'ready' },
  summary: { by_project_status: {} },
  risks: [],
  ...overrides
});

test('五阶段按最靠后的真实业务节点推导', () => {
  expect(deriveCampaignStage(detail())).toBe('finding');
  expect(deriveCampaignStage(detail({ summary: { contacted: 2, by_project_status: {} } }))).toBe('outreach');
  expect(deriveCampaignStage(detail({ summary: { kols_confirmed: 1, by_project_status: {} } }))).toBe('fulfillment');
  expect(deriveCampaignStage(detail({ summary: { by_project_status: { pending_publish: 1 } } }))).toBe('content');
});

test('策略草案、候选、邮件和回复形成统一待审核计数', () => {
  expect(pendingApprovalCount(detail({
    strategy: { status: 'draft' },
    summary: { candidates_pending_review: 3, drafts_pending: 2, replies_pending: 1 }
  }))).toBe(7);
});

test('责任方优先级为异常、人工、AI、外部', () => {
  expect(deriveResponsibility(detail({ summary: { exceptions: 1 } })).key).toBe('exception');
  expect(deriveResponsibility(detail({ strategy: { status: 'draft' } })).key).toBe('human');
  expect(deriveResponsibility(detail({ summary: { finder_tasks_running: 1 } })).key).toBe('ai');
  expect(deriveResponsibility(detail({ summary: { contacted: 3, replied: 1 } })).key).toBe('external');
});

test('项目进度聚合主推产品、计数和下一步', () => {
  const row = normalizeCampaignProgress(detail({
    products: [{ role: 'hero', product: { name: '割草机', sku: 'TMB-1401' } }],
    summary: { kols_total: 8, kols_candidate: 5, kols_confirmed: 2, by_project_status: {} },
    next_step: '有 5 位候选达人待审核，请到工作台处理'
  }));
  expect(row.primaryProductSku).toBe('TMB-1401');
  expect(row.confirmedKols).toBe(2);
  expect(row.nextStep).toBe('合作履约推进中');
});

test('项目管理使用中性进度文案，不展示审核催促或异常', () => {
  expect(deriveProgressText(detail({
    summary: { candidates_pending_review: 108, exceptions: 3, by_project_status: {} }
  }))).toBe('候选达人确认中 · 108 位');
  expect(deriveProgressText(detail({
    summary: { drafts_pending: 5, by_project_status: {} }
  }))).toBe('外联邮件准备中 · 5 封');
});
