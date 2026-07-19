import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import axios from 'axios';
import { message } from 'antd';
import CampaignKols from './CampaignKols';
import { describeSyncResult } from './campaignKolSyncResult';

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

const kolRow = {
  id: 7,
  campaign_id: 3,
  campaign_name: 'Lobster Co',
  customer_id: 11,
  kol_name: 'Alice',
  project_status: 'candidate',
  sync_status: 'sync_pending',
  published_video_count: 0
};

function mockListRequests() {
  axios.get.mockImplementation((url) => {
    if (url === '/api/campaigns') return Promise.resolve({ data: { data: [{ id: 3, name: 'Lobster Co' }] } });
    if (url === '/api/campaign-kols') return Promise.resolve({ data: { data: [kolRow] } });
    return Promise.resolve({ data: { data: [] } });
  });
}

async function clickSync() {
  render(<CampaignKols />);
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  const button = screen.getByRole('button', { name: /同步待同步到飞书项目子表/ });
  await userEvent.click(button);
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/sync/feishu/push', expect.anything()));
  await waitFor(() => expect(
    message.success.mock.calls.length + message.warning.mock.calls.length + message.error.mock.calls.length
  ).toBe(1));
}

describe('describeSyncResult', () => {
  test('returns success when nothing failed', () => {
    expect(describeSyncResult({ success_count: 8, failed_count: 0, results: [] }))
      .toEqual({ type: 'success', content: '同步完成：成功 8，失败 0' });
  });

  test('returns warning with the first failure reason when partially successful', () => {
    const result = describeSyncResult({
      success_count: 5,
      failed_count: 3,
      results: [
        { success: true },
        { success: false, error: 'field type mismatch' },
        { success: false, error: 'second error' }
      ]
    });
    expect(result.type).toBe('warning');
    expect(result.content).toContain('成功 5，失败 3');
    expect(result.content).toContain('field type mismatch');
    expect(result.content).not.toContain('second error');
  });

  test('returns error with the first failure reason when everything failed', () => {
    const result = describeSyncResult({
      success_count: 0,
      failed_count: 8,
      results: [{ success: false, error: 'hyperlink field requires object' }]
    });
    expect(result.type).toBe('error');
    expect(result.content).toContain('8');
    expect(result.content).toContain('hyperlink field requires object');
  });
});

describe('CampaignKols sync notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRequests();
  });

  test('shows success message when all records sync', async () => {
    axios.post.mockResolvedValue({
      data: { data: { success_count: 8, failed_count: 0, results: [] } }
    });
    await clickSync();
    expect(message.success).toHaveBeenCalledWith('同步完成：成功 8，失败 0');
    expect(message.warning).not.toHaveBeenCalled();
    expect(message.error).not.toHaveBeenCalled();
  });

  test('shows warning with the first failure reason when some records fail', async () => {
    axios.post.mockResolvedValue({
      data: {
        data: {
          success_count: 5,
          failed_count: 3,
          results: [{ success: false, error: 'field type mismatch' }]
        }
      }
    });
    await clickSync();
    expect(message.warning).toHaveBeenCalledTimes(1);
    expect(message.warning.mock.calls[0][0]).toContain('成功 5，失败 3');
    expect(message.warning.mock.calls[0][0]).toContain('field type mismatch');
    expect(message.success).not.toHaveBeenCalled();
    expect(message.error).not.toHaveBeenCalled();
  });

  test('shows error with the first failure reason when all records fail', async () => {
    axios.post.mockResolvedValue({
      data: {
        data: {
          success_count: 0,
          failed_count: 8,
          results: [{ success: false, error: 'hyperlink field requires object' }]
        }
      }
    });
    await clickSync();
    expect(message.error).toHaveBeenCalledTimes(1);
    expect(message.error.mock.calls[0][0]).toContain('8');
    expect(message.error.mock.calls[0][0]).toContain('hyperlink field requires object');
    expect(message.success).not.toHaveBeenCalled();
    expect(message.warning).not.toHaveBeenCalled();
  });
});
