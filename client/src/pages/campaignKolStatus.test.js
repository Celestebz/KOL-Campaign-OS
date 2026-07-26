import { getMainStatus, getSubStatusLabel, MAIN_STATUSES, SUB_STATUS_LABELS } from './campaignKolStatus';

describe('campaignKolStatus 主状态映射', () => {
  test('8 个细分状态按 8.3 收敛到 5 个主状态', () => {
    expect(getMainStatus('pending_confirmation')).toEqual(MAIN_STATUSES.pending_confirmation);
    expect(getMainStatus('pending_shipping')).toEqual(MAIN_STATUSES.in_progress);
    expect(getMainStatus('shipped')).toEqual(MAIN_STATUSES.in_progress);
    expect(getMainStatus('delivered')).toEqual(MAIN_STATUSES.in_progress);
    expect(getMainStatus('content_preparation')).toEqual(MAIN_STATUSES.in_progress);
    expect(getMainStatus('pending_publish')).toEqual(MAIN_STATUSES.pending_publish);
    expect(getMainStatus('published')).toEqual(MAIN_STATUSES.completed);
    expect(getMainStatus('cancelled')).toEqual(MAIN_STATUSES.terminated);
  });

  test('主状态中文标签', () => {
    expect(MAIN_STATUSES.pending_confirmation.label).toBe('待确认');
    expect(MAIN_STATUSES.in_progress.label).toBe('合作执行中');
    expect(MAIN_STATUSES.pending_publish.label).toBe('待上线');
    expect(MAIN_STATUSES.completed.label).toBe('已完成');
    expect(MAIN_STATUSES.terminated.label).toBe('已终止');
  });

  test('每个细分状态都有中文标签', () => {
    expect(Object.keys(SUB_STATUS_LABELS)).toHaveLength(8);
    expect(getSubStatusLabel('content_preparation')).toBe('内容准备中');
    expect(getSubStatusLabel('published')).toBe('已上线');
  });

  test('未知值原样兜底，空值兜底为 -', () => {
    expect(getMainStatus('candidate')).toEqual({ value: 'candidate', label: 'candidate', color: 'default' });
    expect(getMainStatus(undefined)).toEqual({ value: '', label: '-', color: 'default' });
    expect(getMainStatus(null).label).toBe('-');
    expect(getSubStatusLabel('candidate')).toBe('candidate');
    expect(getSubStatusLabel(undefined)).toBe('');
  });
});
