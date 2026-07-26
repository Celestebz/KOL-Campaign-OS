import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
    expect(message.error).toHaveBeenCalledWith('获取策略失败，请确认后端服务已启动');
  });
});
