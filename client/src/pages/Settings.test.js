import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { message } from 'antd';
import Settings from './Settings';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('antd', () => {
  const actual = jest.requireActual('antd');
  return { ...actual, message: { ...actual.message, success: jest.fn(), error: jest.fn() } };
});

const remoteSettings = {
  platforms: {
    youtube: { primary: 'maton_gateway', fallbacks: [], providers: { maton_gateway: { api_key: '••••••••', connection_id: 'conn-1' } } },
    instagram: { primary: 'scrapecreators', fallbacks: [], providers: {} },
    tiktok: { primary: 'scrapecreators', fallbacks: [], providers: {} }
  },
  aiModels: { active: 'deepseek', providers: { deepseek: { api_key: '••••••••', model: 'deepseek-chat' } } },
  externalAgent: { enabled: true, api_token: '••••••••', notes: '' },
  cloudStorage: { feishu: { app_id: '', app_secret: '', base_url: 'https://open.feishu.cn', app_token: '', campaign_subtable_map: 'Vivatrees EverJoy=tbliXAzgY46zjt3U' } },
  fallbackStrategy: { enableFallback: false, saveFailureReasons: true, saveRawResponses: true, allowAiToolCalls: false }
};

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

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation((url) => Promise.resolve(url === '/api/campaigns'
    ? { data: { data: [{ id: 7, name: 'VivaTrees Everglow 7.5ft Instagram US 2026' }] } }
    : { data: { data: remoteSettings } }));
  axios.post.mockResolvedValue({ data: { success: true } });
});

test('edits Feishu project mappings with system campaign choices', async () => {
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: '云端存储' }));

  expect(screen.queryByLabelText('默认项目 KOL 子表')).not.toBeInTheDocument();
  expect(screen.getByText('无法匹配旧项目映射：Vivatrees EverJoy。子表 ID 已带入下方，请重新选择系统项目后保存。')).toBeInTheDocument();
  const tableId = screen.getByLabelText('飞书子表 ID');
  expect(tableId).toHaveValue('tbliXAzgY46zjt3U');
  await userEvent.clear(tableId);
  await userEvent.type(tableId, 'tbliXAzgY46zjt3U');
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '系统项目' }));
  await screen.findByRole('option', { name: 'VivaTrees Everglow 7.5ft Instagram US 2026' });
  const projectOption = Array.from(document.querySelectorAll('.ant-select-item-option'))
    .find((option) => option.textContent === 'VivaTrees Everglow 7.5ft Instagram US 2026');
  fireEvent.click(projectOption);
  const saveButton = screen.getByRole('button', { name: '保存更改' });
  expect(saveButton).toBeEnabled();
  await userEvent.click(saveButton);

  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
    settings: expect.objectContaining({
      cloudStorage: expect.objectContaining({
        feishu: expect.objectContaining({ campaign_subtable_map: '{"7":"tbliXAzgY46zjt3U"}' })
      })
    })
  })));
});

test('removes Agent Automation while retaining YouTube Maton and External Agent API', async () => {
  render(<Settings />);
  expect(await screen.findByText('配置概览')).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: 'Agent 自动化' })).not.toBeInTheDocument();
  expect(screen.queryByText('BrowserAct')).not.toBeInTheDocument();
  expect(screen.queryByText('Playwright Local')).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'External Agent API' })).toBeInTheDocument();

  await userEvent.click(screen.getByRole('tab', { name: '平台数据源' }));
  expect(screen.getByRole('button', { name: '配置 Maton Gateway' })).toBeInTheDocument();
});

test('opens a provider drawer with only the selected provider fields', async () => {
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: '平台数据源' }));
  await userEvent.click(screen.getByRole('button', { name: '配置 Maton Gateway' }));

  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('配置 Maton Gateway')).toBeInTheDocument();
  expect(screen.getByLabelText('Maton Connection ID')).toBeInTheDocument();
  expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
});

test('saving one provider posts the complete settings tree and refreshes the page', async () => {
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: 'AI 模型' }));
  await userEvent.click(screen.getByRole('button', { name: '配置 DeepSeek' }));
  await userEvent.clear(screen.getByLabelText('Model'));
  await userEvent.type(screen.getByLabelText('Model'), 'deepseek-chat-v2');
  await userEvent.click(screen.getByRole('button', { name: '保存此配置' }));

  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
    settings: expect.objectContaining({
      platforms: expect.any(Object),
      aiModels: expect.objectContaining({ providers: expect.any(Object) }),
      cloudStorage: expect.any(Object)
    })
  })));
  await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(4));
  expect(message.success).toHaveBeenCalledWith('DeepSeek 配置已保存');
});

test('registers beforeunload after a section value changes', async () => {
  const addSpy = jest.spyOn(window, 'addEventListener');
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: '运行与备用策略' }));
  await userEvent.click(screen.getByRole('switch', { name: '主源失败后尝试备用源' }));

  await waitFor(() => expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function)));
  addSpy.mockRestore();
});

test('shows a retry action when loading settings fails', async () => {
  axios.get.mockRejectedValueOnce(new Error('Network Error'));
  render(<Settings />);

  expect(await screen.findByText('获取 API 设置失败，请确认后端服务已启动后重试。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
});

test('keeps provider drawer open and preserves input when saving fails', async () => {
  axios.post.mockRejectedValueOnce({ response: { data: { error: 'Connection rejected' } } });
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: 'AI 模型' }));
  await userEvent.click(screen.getByRole('button', { name: '配置 DeepSeek' }));
  await userEvent.clear(screen.getByLabelText('Model'));
  await userEvent.type(screen.getByLabelText('Model'), 'saved-in-form');
  await userEvent.click(screen.getByRole('button', { name: '保存此配置' }));

  expect(await screen.findByText('Connection rejected')).toBeInTheDocument();
  expect(screen.getByLabelText('Model')).toHaveValue('saved-in-form');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
