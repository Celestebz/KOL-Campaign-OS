import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import axios from 'axios';
import { message } from 'antd';
import Customers, { normalizeYoutubeSnapshot } from './Customers';

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

test('maps the YouTube snapshot engagement rate for the detail view', () => {
  expect(normalizeYoutubeSnapshot({
    posts_30d: 10,
    avg_views_30d: 42000,
    median_views_30d: 38000,
    engagement_rate_30d: 0.064
  })).toMatchObject({
    posts: 10,
    avg_views: 42000,
    median_views: 38000,
    engagement_rate: 0.064
  });
});

test('shows platform home links and follower counts in the KOL management table', async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/customers') return Promise.resolve({
      data: {
        data: [{
          id: 11,
          name: 'Alice',
          youtube_url: 'https://youtube.com/@alice',
          youtube_followers: '780000',
          instagram_url: 'https://instagram.com/alice',
          instagram_followers: '120000',
          tiktok_url: 'https://tiktok.com/@alice',
          tiktok_followers: '350000',
          avg_views_30d: 42000,
          median_views_30d: 38000,
          posts_30d: 6
        }]
      }
    });
    if (url === '/api/customers/filter-options') return Promise.resolve({ data: { data: { countries: [], platforms: [] } } });
    return Promise.resolve({ data: { data: [] } });
  });

  render(<Customers />);

  expect(await screen.findByText('Alice')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'YouTube' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Instagram' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'TikTok' })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '合作平台' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '平台账号名' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '平台主页链接' })).not.toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'YouTube近10条数据' })).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '近30天平均曝光' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '近30天中位曝光' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '近30天作品数' })).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: '互动率' })).not.toBeInTheDocument();
  const homeLinks = screen.getAllByRole('link', { name: '主页' });
  expect(homeLinks).toHaveLength(3);
  expect(homeLinks[0]).toHaveAttribute('href', 'https://youtube.com/@alice');
  expect(homeLinks[0]).toHaveAttribute('target', '_blank');
  expect(screen.getByText('780000')).toBeInTheDocument();
  expect(screen.getByText('120000')).toBeInTheDocument();
  expect(screen.getByText('350000')).toBeInTheDocument();
  expect(screen.getByText('均曝：42000')).toBeInTheDocument();
  expect(screen.getByText('中位：38000')).toBeInTheDocument();
  expect(screen.getByText('作品：6')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看详情' })).toBeInTheDocument();
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

test('pushes pending KOL records to Feishu from the management page', async () => {
  axios.post.mockResolvedValue({
    data: { success: true, data: { success_count: 4, failed_count: 0, results: [] } }
  });
  render(<Customers />);
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /同步待处理到飞书/ }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/sync/feishu/push', {
    scope: 'kols', ids: []
  }));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('同步到飞书完成：新建字段 0，KOL成功 4，失败 0'));
});

test('initializes missing Feishu fields from the KOL management page', async () => {
  axios.post.mockResolvedValue({
    data: { success: true, data: { created: ['主页链接'], existing: ['KOL名称'], conflicts: [] } }
  });
  render(<Customers />);
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /检查\/初始化飞书字段/ }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/sync/feishu/ensure-kol-fields'));
  await waitFor(() => expect(message.success).toHaveBeenCalledWith('飞书字段检查完成：新建 1，已存在 1'));
});

describe('KOL 总表加入项目', () => {
  function mockWithCampaigns() {
    axios.get.mockImplementation((url) => {
      if (url === '/api/customers') return Promise.resolve({ data: { data: [{ id: 11, name: 'Alice', platform: 'YouTube' }] } });
      if (url === '/api/customers/filter-options') return Promise.resolve({ data: { data: { countries: [], platforms: [] } } });
      if (url === '/api/campaigns') {
        return Promise.resolve({
          data: {
            data: [
              { id: 2, name: 'TMB-1401｜Finishing Mower', period: '2026 Q3' },
              { id: 3, name: 'TRA-0429｜Wood Chipper', period: '2026 Q3' },
              { id: 59, name: 'TSA-0512', period: '2026 Q3' }
            ]
          }
        });
      }
      if (url === '/api/campaigns/2/products') {
        return Promise.resolve({
          data: { data: [{ id: 1, product_id: 10, role: 'hero', product: { id: 10, sku: 'TMB-1401', name: '48-inch PTO Finish Mower' } }] }
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
  }

  async function openPoolModalForAlice() {
    render(<Customers />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: '加入项目' });
    // antd 固定列会克隆一份 pointer-events:none 的按钮，fireEvent 绕过该限制
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText('加入项目（1 个 KOL）')).toBeInTheDocument();
  }

  async function selectTmbCampaign() {
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByText('TMB-1401｜Finishing Mower'));
    await waitFor(() => expect(within(dialog).getAllByRole('combobox').length).toBeGreaterThan(1));
    await waitFor(() => expect(within(dialog).getAllByRole('combobox')[1]).not.toBeDisabled());
    fireEvent.mouseDown(within(dialog).getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByText('TMB-1401 | 48-inch PTO Finish Mower'));
  }

  test('行内按钮打开弹窗，选择项目后显示 SKU、产品名称与项目周期', async () => {
    mockWithCampaigns();
    await openPoolModalForAlice();
    await selectTmbCampaign();
    expect(await screen.findByText('TMB-1401')).toBeInTheDocument();
    expect(screen.getByText('48-inch PTO Finish Mower')).toBeInTheDocument();
    expect(screen.getByText('2026 Q3')).toBeInTheDocument();
    expect(screen.getByText('合作平台（可选）')).toBeInTheDocument();
    expect(screen.queryByText('优先级（可选）')).not.toBeInTheDocument();
    expect(screen.getByText('备注（可选）')).toBeInTheDocument();
  });


  test('未确认合作时加入候选池，不提交合作履约阶段', async () => {
    mockWithCampaigns();
    axios.post.mockResolvedValue({ data: { success: true, data: { id: 502 } } });
    render(<Customers />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: '加入候选池' });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText('加入候选池（1 个 KOL）')).toBeInTheDocument();
    expect(screen.queryByText('合作阶段（必选）')).not.toBeInTheDocument();
    expect(screen.queryByText('优先级（可选）')).not.toBeInTheDocument();
    await selectTmbCampaign();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '加入候选池' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/customers/11/candidate-pool', {
      campaign_id: 2, product_id: 10, cooperation_platforms: [], notes: ''
    }));
    expect(axios.post.mock.calls[0][1]).not.toHaveProperty('project_status');
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('已将 1 个 KOL 加入候选池'));
  });

  test('从产品库添加产品后，提交关联新增产品', async () => {
    mockWithCampaigns();
    const get = axios.get.getMockImplementation();
    let attached = false;
    axios.get.mockImplementation((url) => {
      if (url === '/api/products') return Promise.resolve({ data: { data: [{ id: 20, sku: 'SKU-20', name: 'Second Product', status: 'active' }] } });
      if (url === '/api/campaigns/2/products' && attached) return Promise.resolve({ data: { data: [{ id: 2, product_id: 20, status: 'active', product: { id: 20, sku: 'SKU-20', name: 'Second Product' } }] } });
      return get(url);
    });
    axios.post.mockImplementation((url) => {
      if (url === '/api/campaigns/2/products') attached = true;
      return Promise.resolve({ data: { success: true, data: { id: 501 } } });
    });
    await openPoolModalForAlice();
    await selectTmbCampaign();
    fireEvent.click(screen.getByRole('button', { name: /添加产品/ }));
    const productTitle = await screen.findByText('添加产品到项目');
    const productDialog = productTitle.closest('[role="dialog"]');
    await userEvent.click(within(productDialog).getByRole('tab', { name: '选择已有产品' }));
    await userEvent.click(within(productDialog).getByRole('combobox'));
    await userEvent.click(await screen.findByText('SKU-20 | Second Product'));
    await userEvent.click(within(productDialog).getByRole('button', { name: '添加产品' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/campaigns/2/products', { product_id: 20, role: 'secondary' }));
    await waitFor(() => expect(screen.getByText('Second Product')).toBeInTheDocument());
    const intakeDialog = screen.getAllByRole('dialog').find((dialog) => within(dialog).queryByText('加入项目（1 个 KOL）'));
    await userEvent.click(within(intakeDialog).getByRole('button', { name: '加入项目' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/customers/11/projects', expect.objectContaining({ product_id: 20 })));
  });

  test('直接输入产品名称创建并关联项目，SKU 可留空', async () => {
    mockWithCampaigns();
    const get = axios.get.getMockImplementation();
    let attached = false;
    axios.get.mockImplementation((url) => {
      if (url === '/api/campaigns/2/products' && attached) return Promise.resolve({ data: { data: [{ id: 3, product_id: 30, product: { id: 30, name: 'Custom Tree', sku: null } }] } });
      return get(url);
    });
    axios.post.mockImplementation((url) => {
      if (url === '/api/products') return Promise.resolve({ data: { success: true, data: { id: 30, name: 'Custom Tree', status: 'active' } } });
      if (url === '/api/campaigns/2/products') attached = true;
      return Promise.resolve({ data: { success: true } });
    });
    await openPoolModalForAlice();
    await selectTmbCampaign();
    fireEvent.click(screen.getByRole('button', { name: /添加产品/ }));
    const title = await screen.findByText('添加产品到项目');
    const dialog = title.closest('[role="dialog"]');
    fireEvent.change(within(dialog).getByRole('textbox', { name: '产品名称' }), { target: { value: '  Custom Tree  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加产品' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/products', { name: 'Custom Tree', sku: null, brand: '' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/campaigns/2/products', { product_id: 30, role: 'secondary' }));
    await waitFor(() => expect(screen.getByText('Custom Tree')).toBeInTheDocument());
  });

  test('提交后调用 projects 接口并提示成功', async () => {
    mockWithCampaigns();
    axios.post.mockResolvedValue({
      data: { success: true, data: { id: 501 }, message: '已加入项目', warning: null }
    });
    await openPoolModalForAlice();
    await selectTmbCampaign();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '加入项目' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/customers/11/projects', expect.objectContaining({
      campaign_id: 2,
      product_id: 10,
      project_status: 'pending_shipping'
    })));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('已将 1 个 KOL 加入项目'));
    expect(message.error).not.toHaveBeenCalled();
  });

  test('选择部分发布后按所选阶段加入合作区', async () => {
    mockWithCampaigns();
    axios.post.mockResolvedValue({ data: { success: true, data: { id: 501 } } });
    await openPoolModalForAlice();
    await selectTmbCampaign();
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getAllByRole('combobox')[2]);
    await userEvent.click(await screen.findByText('部分发布'));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '加入项目' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/customers/11/projects', expect.objectContaining({ project_status: 'partially_published' })));
  });

  test('重复加入同一项目显示明确提示', async () => {
    mockWithCampaigns();
    axios.post.mockResolvedValue({
      data: { success: true, duplicate: true, data: { id: 88 }, message: '该 KOL 已在此项目合作区中' }
    });
    await openPoolModalForAlice();
    await selectTmbCampaign();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '加入项目' }));
    await waitFor(() => expect(message.warning).toHaveBeenCalledWith('1 个 KOL 已在此项目合作区中'));
    expect(message.success).not.toHaveBeenCalled();
  });

  test('KOL 缺少主平台主页时显示醒目警告', async () => {
    mockWithCampaigns();
    axios.post.mockResolvedValue({
      data: {
        success: true,
        data: { id: 501 },
        message: '已加入项目',
        warning: '该 KOL 尚未填写主平台主页，飞书中的主页和粉丝数据将为空。'
      }
    });
    await openPoolModalForAlice();
    await selectTmbCampaign();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '加入项目' }));
    await waitFor(() => expect(message.warning).toHaveBeenCalledWith('该 KOL 尚未填写主平台主页，飞书中的主页和粉丝数据将为空。'));
  });
});
