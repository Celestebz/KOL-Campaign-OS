import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import axios from 'axios';
import { message } from 'antd';
import Customers from './Customers';

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

function mockListRequests() {
  axios.get.mockImplementation((url) => {
    if (url === '/api/customers') return Promise.resolve({ data: { data: [{ id: 11, name: 'Alice', platform: 'YouTube' }] } });
    if (url === '/api/customers/filter-options') return Promise.resolve({ data: { data: { countries: [], platforms: [] } } });
    return Promise.resolve({ data: { data: [] } });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListRequests();
});

async function renderAndClickPull() {
  render(<Customers />);
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  const button = screen.getByRole('button', { name: /从飞书导入/ });
  await userEvent.click(button);
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/sync/feishu/pull'));
}

test('posts to the pull endpoint and refetches the KOL list', async () => {
  axios.post.mockResolvedValue({
    data: { success: true, data: { fetched: 6, created: 2, updated: 3, skipped: 1, failed: 0, errors: [] } }
  });
  await renderAndClickPull();
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('从飞书导入完成：新增 2，更新 3，跳过 1，失败 0'));
  expect(message.warning).not.toHaveBeenCalled();
  const listCalls = axios.get.mock.calls.filter(([url]) => url === '/api/customers');
  expect(listCalls.length).toBeGreaterThanOrEqual(2);
});

test('warns instead of celebrating when some records failed', async () => {
  axios.post.mockResolvedValue({
    data: { success: true, data: { fetched: 6, created: 2, updated: 3, skipped: 0, failed: 1, errors: [{ record_id: 'rec1', error: 'UNIQUE' }] } }
  });
  await renderAndClickPull();
  await waitFor(() => expect(message.warning).toHaveBeenCalledWith('从飞书导入完成：新增 2，更新 3，跳过 0，失败 1'));
  expect(message.success).not.toHaveBeenCalled();
});

test('shows the backend error when the pull request fails', async () => {
  axios.post.mockRejectedValue({ response: { data: { error: 'Feishu Bitable is not configured: App ID' } } });
  await renderAndClickPull();
  await waitFor(() => expect(message.warning).toHaveBeenCalledWith('Feishu Bitable is not configured: App ID'));
  expect(message.success).not.toHaveBeenCalled();
});
