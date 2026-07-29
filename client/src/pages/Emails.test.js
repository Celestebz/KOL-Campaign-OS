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
          data: { data: [{ id: 9, from_address: 'ad@x.com', subject: '促销邮件', received_at: '2026-07-27T06:00:00Z', body_text: '' }] }
        });
      }
      return Promise.resolve({
        data: {
          data: [{
            id: 5, kol_name: 'Alice', campaign_name: 'TMB-1401｜Finishing Mower',
            subject: 'Re: 合作', received_at: '2026-07-27T06:00:00Z',
            ai_status: 'success', ai_summary: '对合作有意向', ai_intent: 'interested', confirm_status: 'pending'
          }]
        }
      });
    }
    if (url === '/api/emails/settings') {
      return Promise.resolve({
        data: { data: { smtp_host: 'smtp.x.com', username: 'u@x.com', sync_mode: 'idle', poll_interval_minutes: 5 } }
      });
    }
    if (url === '/api/emails/settings/sync-status') {
      return Promise.resolve({
        data: {
          data: {
            mode: 'idle', status: 'connected',
            last_mail_at: '2026-07-27T06:00:00Z', last_full_sync_at: '2026-07-27T06:10:00Z',
            last_error: null, reconnect_attempts: 0, connected_since: '2026-07-27T05:00:00Z'
          }
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
  await userEvent.click(await screen.findByText('邮件待办'));
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
});

test('邮箱配置显示收信模式与连接状态，支持测试 IMAP 和立即同步', async () => {
  render(<Emails />);
  await userEvent.click(await screen.findByText('邮箱配置'));

  expect((await screen.findAllByText('收信模式')).length).toBeGreaterThan(0);
  expect(await screen.findByText('已连接')).toBeInTheDocument();
  expect(screen.getByText('最后收到邮件')).toBeInTheDocument();
  expect(screen.getByText('最后补偿同步')).toBeInTheDocument();

  axios.post.mockResolvedValue({ data: { success: true, message: 'IMAP 连接成功（收件箱 261 封邮件）' } });
  await userEvent.click(screen.getByRole('button', { name: '测试 IMAP' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/emails/settings/test-imap'));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('IMAP 连接成功（收件箱 261 封邮件）'));

  axios.post.mockResolvedValue({ data: { success: true, message: '同步完成：新收 2，匹配 1，未识别 1' } });
  await userEvent.click(screen.getByRole('button', { name: '立即同步一次' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/emails/settings/sync-now'));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('同步完成：新收 2，匹配 1，未识别 1'));
});

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
  // 审批列表仍然可用（说明：草稿筛选条件存在）
  expect(await screen.findByText('状态')).toBeInTheDocument();
  // summary 接口失败时三张卡的数值占位都是 —（指标卡数值位置至少 3 个 —）
  await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3));
});

test('审批列表的状态筛选条件仍保留待审阅/已批准/已发送等选项', async () => {
  render(<Emails />);
  // Antd Select 的占位文字 "状态" 不可点击；改点 combobox
  const comboboxes = await screen.findAllByRole('combobox');
  // 第三个 combobox 是 "状态" 过滤（前两个：类型、风险）
  await userEvent.click(comboboxes[2]);
  expect(await screen.findByText('待审阅')).toBeInTheDocument();
  expect(screen.getByText('已批准')).toBeInTheDocument();
  expect(screen.getByText('已发送')).toBeInTheDocument();
  expect(screen.getByText('发送失败')).toBeInTheDocument();
});
