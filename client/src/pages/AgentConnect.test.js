import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import AgentConnect from './AgentConnect';

beforeAll(() => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  global.fetch = jest.fn((url) => Promise.resolve({ ok: true, json: async () => url.endsWith('/connections')
    ? { data: [{ id: 3, label: 'My computer', refresh_expires_at: '2027-01-01T00:00:00Z' }] }
    : { label: 'Test laptop', status: 'pending' } }));
});
afterEach(() => { delete global.fetch; });
test('shows matching connection code and waits for explicit browser approval', async () => {
  render(<MemoryRouter initialEntries={['/agent/connect?code=ABCD-EFGH']}><AgentConnect /></MemoryRouter>);
  expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
  expect(screen.getByText('发起设备：Test laptop')).toBeInTheDocument();
  expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /允\s*许\s*连\s*接/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/auth/agent/device/ABCD-EFGH/decision', expect.objectContaining({ method: 'POST', body: '{"approve":true}' })));
  expect(await screen.findByText(/已允许连接，请返回 Agent/)).toBeInTheDocument();
});
test('embedded settings exposes connection revocation without manual credential fields', async () => {
  render(<AgentConnect embedded />);
  expect(await screen.findByText('My computer')).toBeInTheDocument();
  expect(screen.queryByLabelText('Agent API Token')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '撤销连接' }));
  fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/auth/agent/connections/3', { method: 'DELETE' }));
});
test('expired connection request displays a recoverable message and never offers approval', async () => {
  fetch.mockImplementation((url) => Promise.resolve({ ok: url.endsWith('/connections'), json: async () => url.endsWith('/connections') ? { data: [] } : { error: 'expired_device' } }));
  render(<MemoryRouter initialEntries={['/agent/connect?code=ABCD-EFGH']}><AgentConnect /></MemoryRouter>);
  expect(await screen.findByText(/连接请求已过期/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '允许连接' })).not.toBeInTheDocument();
});
