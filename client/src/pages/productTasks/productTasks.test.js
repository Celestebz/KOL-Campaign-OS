import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import axios from 'axios';
import TaskMemberBoard from './TaskMemberBoard';
import TaskIntakeModal from './TaskIntakeModal';
import TaskOutreachModal from './TaskOutreachModal';
import { suggestedTasks } from './taskLabels';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), put: jest.fn() }));
beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => jest.clearAllMocks());
test('combination suggestions require evidence for every product and exclude delivery follow-ups', () => {
  const tasks = [
    { id: 1, status: 'active', products: [{ product_id: 10, sku: 'A' }, { product_id: 11, sku: 'B' }] },
    { id: 2, status: 'active', products: [{ product_id: 10, sku: 'A' }] },
    { id: 3, status: 'active', task_type: 'delivery_follow_up', products: [{ product_id: 10, sku: 'A' }] }
  ];
  expect(suggestedTasks({ product_recommendations: [{ product_id: 10, sku: 'A' }] }, tasks)).toEqual([2]);
  expect(suggestedTasks({ historical_cooperation_skus: ['A'] }, tasks)).toEqual([]);
});
test('one creator can remain a candidate for B while cooperating on A', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: { data: url.endsWith('/task-members') ? [
    { id: 1, task_id: 1, customer_id: 7, kol_name: 'Alice', task_name: 'A合作', review_status: 'approved', cooperation_status: 'confirmed', intent: 'interested', outreach_status: 'replied' },
    { id: 2, task_id: 2, customer_id: 7, kol_name: 'Alice', task_name: 'B候选', review_status: 'pending', cooperation_status: 'candidate', intent: 'unknown', outreach_status: 'not_contacted' }
  ] : [] } }));
  const view = render(<TaskMemberBoard campaignId={5} view="candidate" />);
  expect(await screen.findByText('B候选')).toBeInTheDocument();
  expect(screen.queryByText('A合作')).not.toBeInTheDocument();
  view.rerender(<TaskMemberBoard campaignId={5} view="cooperation" />);
  expect(await screen.findByText('A合作')).toBeInTheDocument();
  expect(screen.queryByText('B候选')).not.toBeInTheDocument();
});
test('intake submits explicit creator-task pairs and never promotes them to cooperation', async () => {
  window.history.replaceState({}, '', '/customers?campaign_id=5&task_id=8');
  axios.get.mockResolvedValue({ data: { data: [{ id: 8, status: 'active', name: '铲雪机', products: [{ product_id: 10, sku: 'A' }] }] } });
  axios.post.mockResolvedValue({ data: { data: [{ id: 20, created: true }] } });
  const customers = [{ id: 7, name: 'Alice' }];
  render(<TaskIntakeModal open customers={customers} campaigns={[{ id: 5, name: '冬季推广', status: 'active', campaign_type: 'active_project' }]} onClose={() => {}} />);
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/campaigns/5/tasks'));
  await screen.findByText('铲雪机 · A');
  fireEvent.click(screen.getByRole('button', { name: '加入所选任务' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/campaigns/5/task-members', {
    assignments: [{ customer_id: 7, task_id: 8 }]
  }));
  window.history.replaceState({}, '', '/');
});

test('preview groups multiple tasks and draft creation does not implicitly send', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: { data: url.endsWith('/templates')
    ? [{ id: 3, kind: 'fixed', name: '合作邀请模板' }]
    : [{ id: 4, enabled: true, label: '商务邮箱' }] } }));
  axios.post.mockImplementation((url) => Promise.resolve({ data: { data: url.endsWith('/preview') ? {
    preview_hash: 'a'.repeat(64), recipients: [{ customer_id: 7, name: 'Alice', email: 'a@example.com', member_ids: [1, 2],
      blocked_reasons: [], snapshots: [{ name: 'A任务' }, { name: 'B任务' }], subject: 'Products A and B', body_text: 'Hello Alice' }]
  } : { drafts: [{ id: 9 }], skipped: [] } } }));
  render(<TaskOutreachModal open campaignId={5} memberIds={[1, 2]} onClose={() => {}} />);
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '开发信模板' }));
  fireEvent.click(await screen.findByText('合作邀请模板'));
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '开发信发件邮箱' }));
  fireEvent.click(await screen.findByText('商务邮箱'));
  fireEvent.click(screen.getByRole('button', { name: '逐人预览' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/campaigns/5/task-outreach/preview', {
    member_ids: [1, 2], template_id: 3, mailbox_id: 4, allow_repeat: false
  }));
  await screen.findByText(/可发送 1 人/);
  fireEvent.click(screen.getByRole('button', { name: '生成待审邮件' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/campaigns/5/task-outreach/drafts', expect.objectContaining({
    member_ids: [1, 2], preview_hash: 'a'.repeat(64), request_key: expect.any(String)
  })));
  expect(axios.post.mock.calls.some(([url]) => url.endsWith('/send') || url.endsWith('/approve'))).toBe(false);
});
