import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import axios from 'axios';
import VideoImportModal from './VideoImportModal';

jest.mock('axios', () => ({ post: jest.fn() }));
beforeAll(() => {
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => jest.clearAllMocks());
const rows = [{ row_number: 2, source_url: 'https://youtu.be/dQw4w9WgXcQ', quote: 'USD 500', kol_name: 'Creator', notes: '', price: { display: 'USD 500.00' }, status: 'new' }];
const preview = { rows, summary: { new: 1, update: 0, skip: 0, invalid: 0 } };

test('upload only previews first; confirmation saves and offers follow-up for returned IDs', async () => {
  axios.post.mockResolvedValueOnce({ data: { data: preview } }).mockResolvedValueOnce({ data: { data: { imported: 1, updated: 0, skipped: 0, failed: 0, ids: [8], rows: [{ ...rows[0], status: 'imported' }] } } });
  const onImported = jest.fn(); const onCrawl = jest.fn();
  render(<VideoImportModal campaigns={[]} onClose={jest.fn()} onImported={onImported} onView={jest.fn()} onCrawl={onCrawl} />);
  fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['data'], 'test.csv', { type: 'text/csv' })] } });
  await waitFor(() => expect(screen.getByRole('button', { name: '预览校验' })).toBeEnabled());
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '预览校验' }));
  await screen.findByText('USD 500.00');
  expect(onImported).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认导入 1 条' }));
  await waitFor(() => expect(onImported).toHaveBeenCalledWith([8]));
  expect(axios.post.mock.calls[1][0]).toBe('/api/videos/import/confirm');
  expect(axios.post.mock.calls[1][1]).toMatchObject({ default_currency: 'USD', duplicate_mode: 'skip' });
  fireEvent.click(screen.getByRole('button', { name: '抓取本次导入' }));
  expect(onCrawl).toHaveBeenCalledWith([8]);
});

test('changing default currency invalidates a prior preview', async () => {
  axios.post.mockResolvedValue({ data: { data: preview } });
  render(<VideoImportModal campaigns={[]} onClose={jest.fn()} onImported={jest.fn()} onView={jest.fn()} onCrawl={jest.fn()} />);
  fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['data'], 'test.csv')] } });
  await waitFor(() => expect(screen.getByRole('button', { name: '预览校验' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '预览校验' }));
  await screen.findByText('USD 500.00');
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '默认币种' }));
  fireEvent.click(screen.getAllByText('CNY').find(node => node.className === 'ant-select-item-option-content'));
  expect(screen.getByRole('button', { name: /确认导入/ })).toBeDisabled();
});

test('an ambiguous project can be resolved in preview and the explicit choice is submitted', async () => {
  const unresolved = { ...rows[0], campaign_name: '重名项目', status: 'invalid', reason: '存在同名项目，请手动选择' };
  const resolved = { ...rows[0], campaign_name: '重名项目', campaign_override_id: 12, campaign_id: 12, resolved_campaign_name: '重名项目', status: 'new' };
  axios.post.mockResolvedValueOnce({ data: { data: { rows: [unresolved], summary: { new: 0, link: 0, update: 0, skip: 0, invalid: 1 } } } })
    .mockResolvedValueOnce({ data: { data: { rows: [resolved], summary: { new: 1, link: 0, update: 0, skip: 0, invalid: 0 } } } })
    .mockResolvedValueOnce({ data: { data: { imported: 1, linked: 0, updated: 0, skipped: 0, failed: 0, ids: [8], rows: [{ ...resolved, status: 'imported' }] } } });
  render(<VideoImportModal campaigns={[{ value: 11, label: '重名项目' }, { value: 12, label: '重名项目' }]} onClose={jest.fn()} onImported={jest.fn()} onView={jest.fn()} onCrawl={jest.fn()} />);
  fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['data'], 'test.csv')] } });
  await waitFor(() => expect(screen.getByRole('button', { name: '预览校验' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '预览校验' }));
  await screen.findByText('存在同名项目，请手动选择');
  expect(screen.getByRole('button', { name: /确认导入/ })).toBeDisabled();
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '第2行项目' }));
  fireEvent.click(screen.getAllByText('重名项目（#12）').find(node => node.className === 'ant-select-item-option-content'));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认导入 1 条' })).toBeEnabled());
  expect(axios.post.mock.calls[1][0]).toBe('/api/videos/import/validate');
  expect(axios.post.mock.calls[1][1].rows[0].campaign_override_id).toBe(12);
  fireEvent.click(screen.getByRole('button', { name: '确认导入 1 条' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(3));
  expect(axios.post.mock.calls[2][1].rows[0]).toMatchObject({ campaign_name: '重名项目', campaign_override_id: 12 });
});
