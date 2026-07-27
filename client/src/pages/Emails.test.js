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
            ai_status: 'success', ai_summary: '对合作有意向', ai_intent: 'interested'
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
  await userEvent.click(await screen.findByText('回复待确认'));
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
