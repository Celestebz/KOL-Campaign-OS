import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { message } from 'antd';
import RawCandidates from './RawCandidates';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('antd', () => {
  const actual = jest.requireActual('antd');
  return { ...actual, message: { ...actual.message, success: jest.fn(), error: jest.fn(), warning: jest.fn() } };
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

describe('RawCandidates product-scoped UI', () => {
  beforeEach(() => {
    axios.get.mockImplementation((url) => {
      if (url === '/api/campaigns') {
        return Promise.resolve({ data: { data: [{ id: 1, name: 'Vivatrees Christmas' }] } });
      }
      if (url === '/api/kol-strategies') {
        return Promise.resolve({
          data: {
            data: [{
              id: 1,
              name: 'Vivatrees Strategy',
              status: 'ready',
              campaign_id: 1,
              campaign_name: 'Vivatrees Christmas',
              campaign_product_id: 2,
              product_name: 'Evercrest',
              primary_platform: 'youtube'
            }]
          }
        });
      }
      if (url === '/api/raw-candidates') {
        return Promise.resolve({
          data: {
            data: [{
              id: 101,
              kol_name: 'Test Creator',
              campaign_id: 1,
              strategy_id: 1,
              platform: 'youtube',
              target_platform: 'youtube',
              status: 'new',
              ai_score: 74,
              fit_score: 74,
              product_name: 'Evercrest',
              product_brand: 'Vivatrees',
              fit_identity_status: 'known_kol_new_product_fit',
              matched_customer_id: 5
            }]
          }
        });
      }
      if (url === '/api/finder-tasks') {
        return Promise.resolve({ data: { data: [] } });
      }
      if (url === '/api/campaigns/1/products') {
        return Promise.resolve({ data: { data: [] } });
      }
      return Promise.resolve({ data: { data: [] } });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('renders known KOL new product fit labels and keeps approval enabled', async () => {
    render(<RawCandidates />);

    expect(await screen.findByText('已有 KOL · 新产品匹配')).toBeInTheDocument();
    expect(screen.getByText('Evercrest')).toBeInTheDocument();
    expect(screen.getByText('产品匹配 74')).toBeInTheDocument();
    const row = screen.getByText('Test Creator').closest('tr');
    const approveButton = row.querySelector('button');
    expect(approveButton).not.toBeDisabled();
  });

  test('syncs approved candidates to the Feishu candidate pool', async () => {
    axios.post.mockResolvedValue({ data: { data: { success_count: 2, failed_count: 0, results: [] } } });
    render(<RawCandidates />);

    const button = await screen.findByRole('button', { name: /同步到飞书候选池/ });
    await userEvent.click(button);

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/sync/feishu/push', { scope: 'campaign_kols' }));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('同步完成：成功 2，失败 0'));
  });

  test('keeps the original candidate view focused on the candidate list', async () => {
    const { container } = render(<RawCandidates />);

    expect(await screen.findByRole('heading', { name: '原始候选' })).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll('.ant-select-selection-placeholder')).some((node) => node.textContent === '状态')).toBe(false);
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/raw-candidates', { params: { actionable: 1 } }));
    expect(screen.queryByText('最近寻找任务')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /创建寻找任务/ })).not.toBeInTheDocument();
  });

  test('scopes console result review to the requested Finder task', async () => {
    render(<RawCandidates finderTaskId="42" />);
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/raw-candidates', { params: { finder_task_id: '42', actionable: 1 } }));
  });

  test('approves a strategy-free candidate without asking for a strategy', async () => {
    const originalGet = axios.get.getMockImplementation();
    axios.get.mockImplementation((url, ...args) => url === '/api/raw-candidates'
      ? Promise.resolve({ data: { data: [{ id: 102, kol_name: 'Agent Creator', campaign_id: 1,
        strategy_id: null, finder_task_id: 42, fit_campaign_product_id: 2, status: 'manual_review' }] } })
      : originalGet(url, ...args));
    axios.post.mockResolvedValue({ data: { success: true } });
    render(<RawCandidates finderTaskId="42" />);
    const creator = await screen.findByText('Agent Creator');
    await userEvent.click(within(creator.closest('tr')).getByRole('button', { name: /加入候选池/ }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/raw-candidates/102/approve', {
      campaign_id: 1, campaign_product_id: 2
    }));
  });

  test('renders finder task controls in the dedicated task view', async () => {
    render(<RawCandidates view="tasks" />);

    expect(await screen.findByRole('heading', { name: '寻找任务' })).toBeInTheDocument();
    expect(screen.getByText('最近寻找任务')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /创建寻找任务/ })).toBeInTheDocument();
    expect(screen.queryByText('Test Creator')).not.toBeInTheDocument();
  });
});

test('handles initial campaign and strategy network failures without unhandled runtime errors', async () => {
  const networkError = new Error('Network Error');
  axios.get.mockImplementation((url) => {
    if (url === '/api/campaigns' || url === '/api/kol-strategies') {
      return Promise.reject(networkError);
    }
    return Promise.resolve({ data: { data: [] } });
  });

  render(<RawCandidates />);

  await waitFor(() => {
    expect(message.error).toHaveBeenCalledWith('获取产品/活动失败，请确认后端服务已启动');
    expect(axios.get).not.toHaveBeenCalledWith('/api/kol-strategies', expect.anything());
  });
});
