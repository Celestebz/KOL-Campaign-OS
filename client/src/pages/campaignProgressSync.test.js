import {
  CAMPAIGN_PROGRESS_CHANGED,
  notifyCampaignProgressChanged,
  subscribeCampaignProgressChanged
} from './campaignProgressSync';

test('审批后只广播有效且去重的项目 id', () => {
  const listener = jest.fn();
  const unsubscribe = subscribeCampaignProgressChanged(listener);
  notifyCampaignProgressChanged([12, '12', 49, null, -1]);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener.mock.calls[0][0].campaignIds).toEqual([12, 49]);
  unsubscribe();
});

test('取消订阅后不再接收项目进度事件', () => {
  const listener = jest.fn();
  const unsubscribe = subscribeCampaignProgressChanged(listener);
  unsubscribe();
  window.dispatchEvent(new CustomEvent(CAMPAIGN_PROGRESS_CHANGED, { detail: { campaignIds: [1] } }));
  expect(listener).not.toHaveBeenCalled();
});
