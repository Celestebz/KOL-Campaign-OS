import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import DiscoveryConsole, { handoffText } from './DiscoveryConsole';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const item = { id: 3, campaign_name: 'Trees', product_name: 'Evercrest', target_platform: 'tiktok', target_count: 10,
  requirements: 'US home creators', status: 'queued', stage: 'waiting', candidate_count: 0 };
beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation((url) => Promise.resolve({ data: { data: url === '/api/discovery-requests' ? [item] : [] } }));
});
test('queued requests require explicit Agent handoff and do not start discovery on page load', async () => {
  render(<MemoryRouter><DiscoveryConsole /></MemoryRouter>);
  expect(await screen.findByText('等待 Agent 接手')).toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '复制任务指令' }));
  expect(screen.getByRole('textbox', { name: 'Agent 任务指令' }).value).toContain('/api/agent/discovery-requests/3');
  expect(axios.post).not.toHaveBeenCalled();
});
test('stored results link to only the current Finder task', async () => {
  axios.get.mockResolvedValue({ data: { data: [{ ...item, finder_task_id: 99, status: 'completed' }] } });
  render(<MemoryRouter><DiscoveryConsole /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: '审核本次 Raw 候选' })).toHaveAttribute('href', '/finder?finder_task_id=99');
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument();
});
test('API failure is displayed rather than showing a successful empty queue', async () => {
  axios.get.mockImplementation((url) => url === '/api/discovery-requests' ? Promise.reject(new Error('offline')) : Promise.resolve({ data: { data: [] } }));
  render(<MemoryRouter><DiscoveryConsole /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('读取任务失败，请检查连接后刷新')).toBeInTheDocument());
  expect(screen.queryByText('还没有找人需求')).not.toBeInTheDocument();
});
test('handoff includes the explicit selected server and never embeds access credentials', () => {
  const text = handoffText({ ...item, api_token: 'secret-example' }, 'https://os.example.com');
  expect(text).toContain('https://os.example.com');
  expect(text).toContain('US home creators');
  expect(text).not.toContain('secret-example');
});
