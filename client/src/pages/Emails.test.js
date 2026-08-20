import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import axios from 'axios';
import { message } from 'antd';
import Emails from './Emails';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), put: jest.fn() }));
jest.mock('antd', () => {
  const actual = jest.requireActual('antd');
  return { ...actual, message: { ...actual.message, success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() } };
});

beforeAll(() => {
  window.matchMedia = window.matchMedia || (() => ({
    matches: false,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn()
  }));
  global.ResizeObserver = global.ResizeObserver || class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function mockApi() {
  axios.get.mockImplementation((url, config) => {
    if (url === '/api/emails/replies') {
      if (config?.params?.scope === 'unmatched') {
        return Promise.resolve({
          data: { data: [{ id: 9, from_address: 'ad@x.com', subject: '促销邮件', received_at: '2026-07-27T06:00:00Z', body_text: '', mailbox_label: '默认邮箱' }] }
        });
      }
      return Promise.resolve({
        data: {
          data: [{
            id: 5, kol_name: 'Alice', campaign_name: 'TMB-1401｜Finishing Mower',
            subject: 'Re: 合作', received_at: '2026-07-27T06:00:00Z',
            ai_status: 'success', ai_summary: '对合作有意向', ai_intent: 'interested', confirm_status: 'pending', mailbox_label: '默认邮箱'
          }]
        }
      });
    }
    if (url === '/api/emails/settings') {
      return Promise.resolve({
        data: {
          data: [
            { id: 1, label: '默认邮箱', username: 'u@x.com', smtp_host: 'smtp.x.com', sync_mode: 'idle', poll_interval_minutes: 5, is_default: 1, enabled: 1, password: '••••••••' }
          ]
        }
      });
    }
    if (url === '/api/emails/settings/sync-status') {
      return Promise.resolve({
        data: {
          data: [
            {
              mailbox_id: 1, username: 'u@x.com', label: '默认邮箱',
              mode: 'idle', status: 'connected',
              last_mail_at: '2026-07-27T06:00:00Z', last_full_sync_at: '2026-07-27T06:10:00Z',
              last_error: null, reconnect_attempts: 0, connected_since: '2026-07-27T05:00:00Z'
            }
          ]
        }
      });
    }
    if (url === '/api/emails/approval-dashboard/summary') {
      return Promise.resolve({
        data: {
          data: {
            todayContactedKols: 12,
            weekContactedKols: 48,
            previousWeekContactedKols: 39,
            weekDifference: 9,
            replyRate30d: 8.6,
            repliedKols30d: 6,
            deliveredKols30d: 70,
            denominatorType: 'sent_success',
            timezone: 'Asia/Shanghai'
          }
        }
      });
    }
    if (url === '/api/emails/drafts') {
      return Promise.resolve({
        data: {
          data: {
            drafts: [],
            counts: { pending_review: 0, high_risk: 0, approved: 0 }
          }
        }
      });
    }
    if (url === '/api/customers') {
      return Promise.resolve({ data: { data: [{ id: 7, name: 'Alice', email: 'alice@x.com' }] } });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  axios.post.mockResolvedValue({ data: { success: true, message: 'ok', data: {} } });
  axios.put.mockResolvedValue({ data: { success: true } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi();
});

test('未识别回复列表支持绑定 KOL', async () => {
  render(<Emails />);
  await userEvent.click(await screen.findByRole('tab', { name: '邮件待办' }));
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/emails/replies', { params: { scope: 'needs_reply' } }));
  expect(await screen.findByText('Alice')).toBeInTheDocument();

  await userEvent.click(screen.getByText('未识别回复'));
  expect(await screen.findByText('ad@x.com')).toBeInTheDocument();
  expect(axios.get).toHaveBeenCalledWith('/api/emails/replies', { params: { scope: 'unmatched' } });

  await userEvent.click(screen.getByRole('button', { name: '绑定 KOL' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/绑定 KOL - ad@x\.com/)).toBeInTheDocument();

  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/customers', expect.anything()));
  await userEvent.click(within(dialog).getByRole('combobox'));
  await userEvent.click(await screen.findByText('Alice（alice@x.com）'));

  axios.post.mockResolvedValue({ data: { success: true, data: { id: 9, customer_id: 7 } } });
  await userEvent.click(within(dialog).getByRole('button', { name: /绑\s*定/ }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/emails/replies/9/bind', { customer_id: 7 }));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('已绑定 KOL，AI 摘要生成中'));
}, 30000);

test('邮件待办为 AI 摘要保留可读宽度，并可悬浮查看完整内容', async () => {
  render(<Emails />);
  await userEvent.click(await screen.findByRole('tab', { name: '邮件待办' }));

  const summary = await screen.findByText('对合作有意向');
  const summaryTable = summary.closest('table');
  const headers = Array.from(summaryTable.querySelectorAll('thead th'));
  const summaryColumnIndex = headers.findIndex((header) => header.textContent.includes('AI 摘要'));
  const summaryColumn = summaryTable.querySelectorAll('colgroup col')[summaryColumnIndex];
  expect(summaryColumn).toHaveStyle({ width: '280px' });

  await userEvent.hover(summary);
  await waitFor(() => expect(screen.getAllByText('对合作有意向')).toHaveLength(2));
}, 30000);

test('确认意向后列表优先显示人工确认值', async () => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, config) => {
    if (url === '/api/emails/replies') {
      return Promise.resolve({ data: { data: [{
        id: 6, kol_name: 'Bob', campaign_name: '人工确认项目', subject: 'Re: 条款',
        received_at: '2026-08-17T06:00:00Z', ai_status: 'success',
        ai_summary: 'AI 原始摘要', ai_intent: 'interested',
        confirmed_summary: '人工修改后的摘要', confirmed_intent: 'rejected',
        confirm_status: 'confirmed', mailbox_label: '默认邮箱'
      }] } });
    }
    return defaultGet(url, config);
  });

  render(<Emails />);
  await userEvent.click(await screen.findByRole('tab', { name: '邮件待办' }));

  expect(await screen.findByText('人工修改后的摘要')).toBeInTheDocument();
  expect(screen.getByText('已拒绝')).toBeInTheDocument();
  expect(screen.queryByText('AI 原始摘要')).not.toBeInTheDocument();
  expect(screen.queryByText('有意向')).not.toBeInTheDocument();
}, 30000);

test('邮箱配置以列表展示邮箱，支持测试 IMAP 和立即同步', async () => {
  render(<Emails />);
  await userEvent.click(await screen.findByText('邮箱配置'));

  expect(await screen.findByText('默认邮箱')).toBeInTheDocument();
  expect(screen.getByText('u@x.com')).toBeInTheDocument();
  expect(screen.getByText('已连接')).toBeInTheDocument();

  axios.post.mockResolvedValue({ data: { success: true, message: 'IMAP 连接成功（收件箱 261 封邮件）' } });
  await userEvent.click(screen.getByRole('button', { name: '测试 IMAP' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/emails/settings/test-imap', { id: 1 }));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('IMAP 连接成功（收件箱 261 封邮件）'));

  axios.post.mockResolvedValue({ data: { success: true, message: '同步完成：新收 2，匹配 1，未识别 1' } });
  await userEvent.click(screen.getByRole('button', { name: '立即同步' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/emails/settings/sync-now', { id: 1 }));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('同步完成：新收 2，匹配 1，未识别 1'));
}, 30000);

// ---- 审批台顶部三张新指标卡 ----

test('审批台顶部展示新的三张指标卡（今日/本周联络 KOL、30天回复率），不再展示旧的审批计数', async () => {
  render(<Emails />);
  // 三个新标题渲染
  expect(await screen.findByText('今日联络 KOL')).toBeInTheDocument();
  expect(screen.getByText('本周联络 KOL')).toBeInTheDocument();
  expect(screen.getByText('30天回复率')).toBeInTheDocument();
  // 三个数值（来自 mockApi，等待 dashboard 异步加载完成）
  expect(await screen.findByText('12')).toBeInTheDocument();
  expect(await screen.findByText('48')).toBeInTheDocument();
  expect(await screen.findByText('8.6%')).toBeInTheDocument();
  // 旧的三个审批计数卡片已下线
  expect(screen.queryByText('待审阅')).not.toBeInTheDocument();
  expect(screen.queryByText('高风险')).not.toBeInTheDocument();
  expect(screen.queryByText('已批准待发送')).not.toBeInTheDocument();
  // 接口被实际调用
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/emails/approval-dashboard/summary'));
});

test('本周联络 KOL 显示较上周对比文案，30天回复率副标题显示分子分母', async () => {
  render(<Emails />);
  expect(await screen.findByText('今日联络 KOL')).toBeInTheDocument();
  // 上升 +9（findByText 等待 dashboard 异步加载完成）
  expect(await screen.findByText('较上周 +9')).toBeInTheDocument();
  // 副标题："6人回复 / 70人发送成功"
  expect(await screen.findByText('6人回复 / 70人发送成功')).toBeInTheDocument();
});

test('本周联络 KOL 在下降时显示负数对比', async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/emails/approval-dashboard/summary') {
      return Promise.resolve({
        data: { data: { todayContactedKols: 3, weekContactedKols: 6, previousWeekContactedKols: 12, weekDifference: -6, replyRate30d: 5, repliedKols30d: 1, deliveredKols30d: 20, denominatorType: 'sent_success', timezone: 'Asia/Shanghai' } }
      });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  render(<Emails />);
  expect(await screen.findByText('较上周 -6')).toBeInTheDocument();
});

test('本周联络 KOL 持平时显示与上周持平', async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/emails/approval-dashboard/summary') {
      return Promise.resolve({
        data: { data: { todayContactedKols: 5, weekContactedKols: 20, previousWeekContactedKols: 20, weekDifference: 0, replyRate30d: 10, repliedKols30d: 2, deliveredKols30d: 20, denominatorType: 'sent_success', timezone: 'Asia/Shanghai' } }
      });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  render(<Emails />);
  expect(await screen.findByText('与上周持平')).toBeInTheDocument();
});

test('30天回复率分母为 0 时显示 — 而非 0%', async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/emails/approval-dashboard/summary') {
      return Promise.resolve({
        data: { data: { todayContactedKols: 0, weekContactedKols: 0, previousWeekContactedKols: 0, weekDifference: 0, replyRate30d: null, repliedKols30d: 0, deliveredKols30d: 0, denominatorType: 'sent_success', timezone: 'Asia/Shanghai' } }
      });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  render(<Emails />);
  // 30天回复率的分母为 0 时显示 —（不带 % 后缀）；其它卡当数值为 0 时正常显示 0
  const dashes = await screen.findAllByText('—');
  expect(dashes.length).toBeGreaterThanOrEqual(1);
  // 关键断言：不能出现 "0%"（避免误导）
  expect(screen.queryByText('0%')).not.toBeInTheDocument();
  // 副标题分母为 0 时也显示 —
  expect(await screen.findByText('0人回复 / —人发送成功')).toBeInTheDocument();
});

test('审批台指标接口失败时不影响审批列表，三张卡显示 —', async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/emails/approval-dashboard/summary') return Promise.reject(new Error('summary down'));
    if (url === '/api/emails/drafts') {
      return Promise.resolve({
        data: { data: { drafts: [{ id: 1, status: 'pending_review', risk_level: 'high', kind: 'first_touch', kol_name: 'Alice', generated_at: '2026-07-27T06:00:00Z' }], counts: { pending_review: 1, high_risk: 1, approved: 0 } } }
      });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  render(<Emails />);
  // 审批列表仍然可用（summary 接口失败时草稿行正常渲染；“状态”筛选已迁至审批记录页）
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  // summary 接口失败时三张卡的数值占位都是 —（指标卡数值位置至少 3 个 —）
  await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3));
});

test('审批记录的状态筛选保留已发送/已批准/发送失败等选项', async () => {
  render(<Emails />);
  await userEvent.click(await screen.findByRole('tab', { name: '审批记录' }));
  // 状态筛选在审批记录页，第一个 combobox 即“全部状态”（后一个为“全部邮箱”）
  const comboboxes = await screen.findAllByRole('combobox');
  await userEvent.click(comboboxes[0]);
  expect(await screen.findByText('已发送')).toBeInTheDocument();
  expect(screen.getByText('已批准')).toBeInTheDocument();
  expect(screen.getByText('已驳回')).toBeInTheDocument();
  expect(screen.getByText('发送失败')).toBeInTheDocument();
});

test('审批台提供邮箱筛选，审批记录展示发件邮箱', async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/emails/drafts') {
      return Promise.resolve({
        data: {
          data: {
            drafts: [
              { id: 3, status: 'sent', kind: 'first_touch', kol_name: 'Bob', campaign_name: 'TMB-1', mailbox_label: '默认邮箱', subject: 'Hi' },
              { id: 4, status: 'pending_review', kind: 'first_touch', kol_name: 'Bob', campaign_name: 'TMB-1', mailbox_label: '默认邮箱', mailbox_username: 'u@x.com', recipient_email: 'bob@x.com', subject: 'Hi', body_text: 'Hello' }
            ],
            counts: { pending_review: 1, high_risk: 0, approved: 0 }
          }
        }
      });
    }
    return Promise.resolve({ data: { data: [] } });
  });
  render(<Emails />);
  expect(await screen.findByText('全部邮箱')).toBeInTheDocument();
  await userEvent.click((await screen.findAllByText('Bob'))[0]);
  expect(await screen.findByText('发件邮箱')).toBeInTheDocument();
  expect(await screen.findByDisplayValue('默认邮箱')).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('tab', { name: '审批记录' }));
  expect(await screen.findByText('默认邮箱')).toBeInTheDocument();
  expect((await screen.findAllByText('Bob')).length).toBeGreaterThanOrEqual(1);
});
