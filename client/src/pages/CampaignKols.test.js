import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import axios from 'axios';
import { message } from 'antd';
import CampaignKols, {
  defaultCooperationType,
  normalizeLegacyPriority,
  normalizeLegacyProjectStatus,
  OUTREACH_STATUS_OPTIONS,
  OUTREACH_PHASE_OPTIONS,
  displayEmail,
  hasPendingEmail,
  outreachPhaseForDisplay
} from './CampaignKols';
import { describeSyncResult } from './campaignKolSyncResult';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn() }));
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
  contact_name: 'Alice Manager',
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
  const button = screen.getByRole('button', { name: /同步待同步到飞书项目跟进表/ });
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

describe('KOL cooperation legacy enum normalization', () => {
  test('maps legacy project statuses into the current workflow', () => {
    expect(normalizeLegacyProjectStatus('confirmed')).toBe('pending_shipping');
    expect(normalizeLegacyProjectStatus('candidate')).toBe('pending_confirmation');
    expect(normalizeLegacyProjectStatus('published')).toBe('published');
  });

  test('maps legacy and uppercase priorities', () => {
    expect(normalizeLegacyPriority('normal')).toBe('t2');
    expect(normalizeLegacyPriority('T1')).toBe('t1');
  });

  test('defaults only blank cooperation types to product exchange', () => {
    expect(defaultCooperationType(null)).toBe('product_exchange');
    expect(defaultCooperationType('')).toBe('product_exchange');
    expect(defaultCooperationType('paid_product')).toBe('paid_product');
    expect(defaultCooperationType('other')).toBe('other');
  });

  test('prefers the current KOL email and ignores legacy no-email placeholders', () => {
    expect(displayEmail('al@example.com', '没邮箱')).toBe('al@example.com');
    expect(displayEmail('', '暂无邮箱')).toBe('-');
    expect(displayEmail('', 'snapshot@example.com')).toBe('snapshot@example.com');
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

describe('CampaignKols business views', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRequests();
  });

  test('candidate view requests candidate stage and exposes confirmation action', async () => {
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('项目候选池')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /确认合作/ })).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/campaign-kols', expect.objectContaining({
      params: expect.objectContaining({ pipeline_stage: 'candidate' })
    }));
  });

  test('candidate view shows an email added after the no-email snapshot was created', async () => {
    axios.get.mockImplementation((url) => {
      if (url === '/api/campaigns') return Promise.resolve({ data: { data: [{ id: 3, name: 'Lobster Co' }] } });
      if (url === '/api/campaign-kols') return Promise.resolve({
        data: { data: [{ ...kolRow, kol_name: 'Al Bladez', email: 'al@example.com', email_snapshot: '没邮箱' }] }
      });
      return Promise.resolve({ data: { data: [] } });
    });

    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Al Bladez')).toBeInTheDocument();
    expect(screen.getByText('al@example.com')).toBeInTheDocument();
    expect(screen.queryByText('没邮箱')).not.toBeInTheDocument();
  });

  test('cooperation view requests only confirmed relationships', async () => {
    render(<CampaignKols />);
    expect(await screen.findByText('KOL 合作')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith('/api/campaign-kols', expect.objectContaining({
      params: expect.objectContaining({ pipeline_stage: 'confirmed' })
    }));
  });
});

describe('CampaignKols confirm cooperation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRequests();
  });

  test('candidate view shows the required notice, confirms and syncs to the tracking table', async () => {
    axios.post.mockImplementation((url) => {
      if (url.includes('/confirm-cooperation')) {
        return Promise.resolve({ data: { success: true, data: { ...kolRow, pipeline_stage: 'confirmed' } } });
      }
      return Promise.resolve({ data: { data: { success_count: 1, failed_count: 0, results: [{ success: true }] } } });
    });

    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /确认合作/ }));
    expect(await screen.findByText('确认后将进入 KOL 合作，并同步至飞书项目跟进表；候选池记录会保留。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^(OK|确\s*定)$/ }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/campaign-kols/7/confirm-cooperation'));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/sync/feishu/push', {
      scope: 'campaign_kols', ids: [7]
    }));
    await waitFor(() => expect(message.success).toHaveBeenCalledWith('已确认合作，并同步到飞书项目跟进表'));
    expect(message.warning).not.toHaveBeenCalled();
    expect(message.error).not.toHaveBeenCalled();
  });

  test('keeps the local confirmation and warns with the reason when the Feishu sync fails', async () => {
    axios.post.mockImplementation((url) => {
      if (url.includes('/confirm-cooperation')) {
        return Promise.resolve({ data: { success: true, data: { ...kolRow, pipeline_stage: 'confirmed' } } });
      }
      return Promise.resolve({
        data: { data: { success_count: 0, failed_count: 1, results: [{ success: false, error: '飞书连接超时' }] } }
      });
    });

    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /确认合作/ }));
    await userEvent.click(await screen.findByRole('button', { name: /^(OK|确\s*定)$/ }));

    await waitFor(() => expect(message.warning).toHaveBeenCalledTimes(1));
    expect(message.warning.mock.calls[0][0]).toContain('已确认合作，但飞书项目跟进同步失败');
    expect(message.warning.mock.calls[0][0]).toContain('飞书连接超时');
    expect(message.success).not.toHaveBeenCalled();
    expect(message.error).not.toHaveBeenCalled();
  });
});

describe('CampaignKols 联系人列', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRequests();
  });

  test('candidate pool shows the contact from KOL management and does not expose a duplicate input', async () => {
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('联系人')).toBeInTheDocument();
    expect(screen.getByText('Alice Manager')).toBeInTheDocument();

    const editButtons = screen.getAllByRole('button', { name: /编辑/ });
    // antd 固定列克隆节点 pointer-events:none，用 fireEvent 触发
    fireEvent.click(editButtons[editButtons.length - 1]);
    expect(await screen.findByText('编辑项目候选')).toBeInTheDocument();
    expect(screen.queryByText('该项目下使用的联系人名称，不影响 KOL 总表')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('联系人姓名')).not.toBeInTheDocument();
  });

  test('ignores a legacy project contact override in favor of the latest KOL management value', async () => {
    axios.get.mockImplementation((url) => {
      if (url === '/api/campaigns') return Promise.resolve({ data: { data: [{ id: 3, name: 'Lobster Co' }] } });
      if (url === '/api/campaign-kols') return Promise.resolve({ data: { data: [{ ...kolRow, contact_name_override: 'Old Contact' }] } });
      return Promise.resolve({ data: { data: [] } });
    });

    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice Manager')).toBeInTheDocument();
    expect(screen.queryByText('Old Contact')).not.toBeInTheDocument();
  });
});

describe('CampaignKols 状态列按视图取舍', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRequests();
  });

  test('candidate pool hides the constant 项目状态 column and keeps 外联状态', async () => {
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getAllByText('外联状态').length).toBeGreaterThan(0);
    expect(screen.queryByText('项目状态')).not.toBeInTheDocument();
  });

  test('cooperation view keeps the 项目状态 column', async () => {
    render(<CampaignKols />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getAllByText('项目状态').length).toBeGreaterThan(0);
  });
});

describe('CampaignKols 状态字段按阶段分离', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRequests();
    axios.patch.mockResolvedValue({ data: { success: true, data: {} } });
    axios.put.mockResolvedValue({ data: { success: true, data: [] } });
  });

  async function openEditDialog() {
    const editButtons = screen.getAllByRole('button', { name: /编辑/ });
    fireEvent.click(editButtons[editButtons.length - 1]);
    return screen.findByRole('dialog');
  }

  test('outreach options contain phases only, excluding the email todo', () => {
    expect(OUTREACH_STATUS_OPTIONS.map((option) => option.value)).toEqual([
      'not_contacted', 'contacted', 'negotiating',
      'interested', 'confirmed', 'terminated'
    ]);
  });

  test('UI separates outreach phase from the email reply todo', () => {
    expect(OUTREACH_PHASE_OPTIONS.map((option) => option.value)).not.toContain('waiting_reply');
    expect(hasPendingEmail({ outreach_status: 'waiting_reply' })).toBe(true);
    expect(hasPendingEmail({ outreach_status: 'interested', needs_reply: true })).toBe(true);
    expect(hasPendingEmail({ outreach_status: 'interested', needs_reply: false })).toBe(false);
    expect(outreachPhaseForDisplay('waiting_reply')).toBe('negotiating');
  });

  test('candidate edit modal shows only 外联状态 with the waiting-note, save submits no project_status', async () => {
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    const dialog = await openEditDialog();

    expect(await within(dialog).findByText('外联状态')).toBeInTheDocument();
    expect(within(dialog).queryByText('项目状态')).not.toBeInTheDocument();
    expect(within(dialog).getByText('邮件是否待回复会由系统根据最新收发邮件单独维护')).toBeInTheDocument();
    expect(within(dialog).getByText('项目备注')).toBeInTheDocument();
    ['收货地址', '内容形式', '预计上线时间', '发货日期', '物流单号', '合作发布视频'].forEach((label) => {
      expect(within(dialog).queryByText(label)).not.toBeInTheDocument();
    });
    expect(axios.get).not.toHaveBeenCalledWith('/api/campaign-kols/7/published-videos');

    await userEvent.click(within(dialog).getByRole('button', { name: /^(OK|确\s*定)$/ }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalled());
    const [url, body] = axios.patch.mock.calls[0];
    expect(url).toBe('/api/campaign-kols/7');
    expect(body.outreach_status).toBe('not_contacted');
    expect('project_status' in body).toBe(false);
    ['shipping_address', 'content_format', 'expected_publish_at', 'shipping_date', 'tracking_number'].forEach((field) => {
      expect(field in body).toBe(false);
    });
    expect(axios.put).not.toHaveBeenCalledWith('/api/campaign-kols/7/published-videos', expect.anything());
  });

  test('cooperation edit modal shows only 项目状态, save submits no outreach_status', async () => {
    render(<CampaignKols />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    const dialog = await openEditDialog();

    expect(await within(dialog).findByText('项目状态')).toBeInTheDocument();
    expect(within(dialog).queryByText('外联状态')).not.toBeInTheDocument();
    ['收货地址', '内容形式', '预计上线时间', '发货日期', '物流单号', '合作发布视频', '项目备注'].forEach((label) => {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    });

    await userEvent.click(within(dialog).getByRole('button', { name: /^(OK|确\s*定)$/ }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalled());
    const body = axios.patch.mock.calls[0][1];
    expect(body.project_status).toBeDefined();
    expect('outreach_status' in body).toBe(false);
  });

  test('cooperation view hides the 外联状态 column', async () => {
    render(<CampaignKols />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getAllByText('项目状态').length).toBeGreaterThan(0);
    expect(screen.queryByText('外联状态')).not.toBeInTheDocument();
  });

  test('empty outreach_status shows 待联系 in candidate pool', async () => {
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('待联系')).toBeInTheDocument();
  });

  test('legacy replied shows 待回复 and legacy rejected shows 已终止', async () => {
    axios.get.mockImplementation((url) => {
      if (url === '/api/campaigns') return Promise.resolve({ data: { data: [{ id: 3, name: 'Lobster Co' }] } });
      if (url === '/api/campaign-kols') {
        return Promise.resolve({
          data: {
            data: [
              { ...kolRow, id: 8, kol_name: 'Bob', outreach_status: 'replied' },
              { ...kolRow, id: 9, kol_name: 'Carol', outreach_status: 'rejected' }
            ]
          }
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('待回复')).toBeInTheDocument();
    expect(screen.getByText('已终止')).toBeInTheDocument();
  });
});

describe('CampaignKols 筛选栏按阶段使用对应状态', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListRequests();
  });

  test('candidate view shows 外联状态 filter and fetches with outreach param', async () => {
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    // 表格列 + 筛选占位，至少两处
    expect(screen.getAllByText('外联状态').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('邮件待办')).toHaveLength(1);

    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByText('沟通中'));
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/campaign-kols', expect.objectContaining({
      params: expect.objectContaining({ outreach_status: 'negotiating', pipeline_stage: 'candidate' })
    })));
  });

  test('cooperation view shows 项目状态 filter instead of a generic 状态', async () => {
    render(<CampaignKols />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getAllByText('项目状态').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('外联状态')).not.toBeInTheDocument();
    expect(screen.queryByText('状态')).not.toBeInTheDocument();
  });

  test('labels Feishu sync status and shows localized options', async () => {
    render(<CampaignKols view="candidate" />);
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getAllByText('飞书同步状态').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('待同步')).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('combobox')[2]);
    expect(await screen.findByText('已同步')).toBeInTheDocument();
    expect(await screen.findByText('同步失败')).toBeInTheDocument();
  });
});
