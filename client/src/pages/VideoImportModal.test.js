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
