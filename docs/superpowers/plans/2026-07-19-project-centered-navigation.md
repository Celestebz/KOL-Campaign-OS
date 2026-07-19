# 项目中心导航实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有按功能分散的页面重组为五项一级导航，并在单个项目内提供项目概览、产品需求、KOL 策略、KOL 寻找和 KOL 合作五个工作页面。

**Architecture:** 保留现有 REST API 和页面业务能力，先建立纯路由与上下文层，再把现有页面以项目范围模式嵌入新的 `CampaignWorkspace`。旧 URL 暂时通过重定向兼容，避免书签失效；本阶段不新增外部 Agent 写接口，也不改动数据库结构。

**Tech Stack:** React 18、React Router 6、Ant Design 5、Axios、Jest、React Testing Library、Express、Node test runner。

## Global Constraints

- 一级导航只显示：项目、KOL 库、产品库、内容分析、设置。
- 登录默认进入项目列表，不提供独立 Dashboard 入口。
- 项目内部名称固定为：项目概览、产品需求、KOL 策略、KOL 寻找、KOL 合作。
- KOL 保持英文缩写，不使用“达人”。
- 候选审批属于 KOL 寻找页面，不建立独立项目标签。
- 内容分析保持跨项目一级入口；本计划只建立聚合入口，深度重组另行规划。
- 不修改 `brief`、`finder`、`kol` 等数据库及 API 字段名。
- 不删除用户数据，不改变现有 Campaign、Product、Strategy、Finder 或 Campaign KOL 记录。

---

## 文件结构

- `client/src/navigation/appNavigation.js`：一级导航、项目标签和旧路由映射的唯一配置源。
- `client/src/navigation/appNavigation.test.js`：导航名称、数量和兼容路由契约测试。
- `client/src/App.js`：渲染一级导航和顶层路由，不承载项目业务逻辑。
- `client/src/pages/Campaigns.js`：项目列表与项目首页统计。
- `client/src/pages/CampaignWorkspace.js`：加载项目上下文并渲染项目内标签页。
- `client/src/pages/CampaignWorkspace.test.js`：项目上下文、标签切换与错误状态测试。
- `client/src/pages/CampaignOverview.js`：单项目概览。
- `client/src/pages/CampaignProducts.js`：从现有项目抽屉中抽出的产品需求管理。
- `client/src/pages/KolStrategy.js`：增加可选的项目范围模式。
- `client/src/pages/RawCandidates.js`：增加可选的项目范围模式。
- `client/src/pages/CampaignKols.js`：增加可选的项目范围模式。
- `client/src/pages/ContentAnalysis.js`：内容分析聚合入口。
- `client/src/pages/SystemSettings.js`：设置聚合入口。

---

### Task 1: 建立导航与路由契约

**Files:**
- Create: `client/src/navigation/appNavigation.js`
- Create: `client/src/navigation/appNavigation.test.js`
- Modify: `client/src/App.js`

**Interfaces:**
- Produces: `primaryNavigation: Array<{key: string, label: string, icon: ReactNode}>`
- Produces: `campaignTabs: Array<{key: string, label: string}>`
- Produces: `legacyRouteRedirects: Array<{from: string, to: string}>`
- Consumes: React Router `Navigate`, `Routes`, `Route`。

- [ ] **Step 1: 写导航契约失败测试**

```js
import { campaignTabs, legacyRouteRedirects, primaryNavigation } from './appNavigation';

test('only exposes five primary navigation entries', () => {
  expect(primaryNavigation.map((item) => item.label)).toEqual([
    '项目', 'KOL 库', '产品库', '内容分析', '设置'
  ]);
});

test('uses the approved project tab names', () => {
  expect(campaignTabs.map((item) => item.label)).toEqual([
    '项目概览', '产品需求', 'KOL 策略', 'KOL 寻找', 'KOL 合作'
  ]);
});

test('keeps old bookmarks through explicit redirects', () => {
  expect(legacyRouteRedirects).toEqual(expect.arrayContaining([
    { from: '/', to: '/campaigns' },
    { from: '/strategy', to: '/campaigns' },
    { from: '/finder', to: '/campaigns' },
    { from: '/campaign-kols', to: '/campaigns' },
    { from: '/send', to: '/content-analysis' },
    { from: '/records', to: '/content-analysis' },
    { from: '/templates', to: '/settings' }
  ]));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd client && CI=true npm test -- --runInBand src/navigation/appNavigation.test.js`

Expected: FAIL，提示 `Cannot find module './appNavigation'`。

- [ ] **Step 3: 实现导航配置**

```js
import React from 'react';
import {
  ProjectOutlined, ProductOutlined, SettingOutlined,
  TeamOutlined, VideoCameraOutlined
} from '@ant-design/icons';

export const primaryNavigation = [
  { key: '/campaigns', label: '项目', icon: <ProjectOutlined /> },
  { key: '/customers', label: 'KOL 库', icon: <TeamOutlined /> },
  { key: '/products', label: '产品库', icon: <ProductOutlined /> },
  { key: '/content-analysis', label: '内容分析', icon: <VideoCameraOutlined /> },
  { key: '/settings', label: '设置', icon: <SettingOutlined /> }
];

export const campaignTabs = [
  { key: 'overview', label: '项目概览' },
  { key: 'products', label: '产品需求' },
  { key: 'strategy', label: 'KOL 策略' },
  { key: 'finder', label: 'KOL 寻找' },
  { key: 'cooperation', label: 'KOL 合作' }
];

export const legacyRouteRedirects = [
  { from: '/', to: '/campaigns' },
  { from: '/strategy', to: '/campaigns' },
  { from: '/finder', to: '/campaigns' },
  { from: '/campaign-kols', to: '/campaigns' },
  { from: '/send', to: '/content-analysis' },
  { from: '/records', to: '/content-analysis' },
  { from: '/templates', to: '/settings' }
];
```

更新 `App.js`：菜单从 `primaryNavigation` 读取；为上述旧地址渲染 `<Navigate replace />`；新增 `/campaigns/:campaignId/:tab?`、`/content-analysis` 和聚合后的 `/settings` 路由。

- [ ] **Step 4: 运行导航测试**

Run: `cd client && CI=true npm test -- --runInBand src/navigation/appNavigation.test.js`

Expected: 3 tests PASS。

- [ ] **Step 5: 提交**

```bash
git add client/src/navigation/appNavigation.js client/src/navigation/appNavigation.test.js client/src/App.js
git commit -m "feat: simplify primary navigation"
```

---

### Task 2: 建立项目工作台与项目上下文

**Files:**
- Create: `client/src/pages/CampaignWorkspace.js`
- Create: `client/src/pages/CampaignWorkspace.test.js`
- Create: `client/src/pages/CampaignOverview.js`
- Modify: `client/src/App.js`

**Interfaces:**
- Consumes: `GET /api/campaigns`
- Consumes: `GET /api/campaigns/:campaignId/products`
- Consumes: `campaignTabs` from `client/src/navigation/appNavigation.js`
- Produces: `CampaignWorkspace`，通过 props 向子页传递 `{campaignId, campaign, campaignProducts, refreshCampaign}`。

- [ ] **Step 1: 写项目工作台失败测试**

```js
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import CampaignWorkspace from './CampaignWorkspace';

jest.mock('axios');

test('loads campaign context and renders approved tabs', async () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/campaigns') return Promise.resolve({
      data: { data: [{ id: 7, name: 'VivaTrees Christmas', brand: 'VivaTrees' }] }
    });
    if (url === '/api/campaigns/7/products') return Promise.resolve({
      data: { data: [{ id: 21, product_name: 'Everglow', status: 'active' }] }
    });
    return Promise.resolve({ data: { data: [] } });
  });

  render(
    <MemoryRouter initialEntries={['/campaigns/7/overview']}>
      <Routes><Route path="/campaigns/:campaignId/:tab" element={<CampaignWorkspace />} /></Routes>
    </MemoryRouter>
  );

  expect(await screen.findByText('VivaTrees Christmas')).toBeInTheDocument();
  for (const label of ['项目概览', '产品需求', 'KOL 策略', 'KOL 寻找', 'KOL 合作']) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
  fireEvent.click(screen.getByText('产品需求'));
  await waitFor(() => expect(window.location.pathname).not.toBe('/campaigns/7/overview'));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd client && CI=true npm test -- --runInBand src/pages/CampaignWorkspace.test.js`

Expected: FAIL，提示 `Cannot find module './CampaignWorkspace'`。

- [ ] **Step 3: 实现工作台外壳**

`CampaignWorkspace` 必须：

```js
const { campaignId, tab = 'overview' } = useParams();
const navigate = useNavigate();
const selectedTab = campaignTabs.some((item) => item.key === tab) ? tab : 'overview';

const changeTab = (nextTab) => {
  navigate(`/campaigns/${campaignId}/${nextTab}`);
};
```

并行加载项目列表及项目产品；找不到项目时显示 `Result status="404"`；网络失败时显示可重试 `Alert`；标签只负责路由，不复制业务状态。

`CampaignOverview` 显示项目市场、状态、目标、时间和产品统计。缺失字段显示 `-`，不得编造默认业务值。

- [ ] **Step 4: 运行项目工作台测试**

Run: `cd client && CI=true npm test -- --runInBand src/pages/CampaignWorkspace.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client/src/pages/CampaignWorkspace.js client/src/pages/CampaignWorkspace.test.js client/src/pages/CampaignOverview.js client/src/App.js
git commit -m "feat: add campaign workspace shell"
```

---

### Task 3: 将项目产品管理改为“产品需求”页

**Files:**
- Create: `client/src/pages/CampaignProducts.js`
- Create: `client/src/pages/CampaignProducts.test.js`
- Modify: `client/src/pages/Campaigns.js`
- Modify: `client/src/pages/CampaignWorkspace.js`

**Interfaces:**
- Consumes props: `{campaignId: number, campaign: object, campaignProducts: array, onRefresh: () => Promise<void>}`
- Consumes: `GET /api/products`
- Consumes: `POST /api/products`
- Consumes: `POST /api/campaigns/:campaignId/products`
- Consumes: `PUT /api/campaigns/:campaignId/products/:campaignProductId`
- Consumes: `POST /api/campaigns/:campaignId/products/:campaignProductId/archive`
- Produces: reusable `CampaignProducts` page component。

- [ ] **Step 1: 写产品需求失败测试**

```js
test('shows each campaign product as an independent requirement', async () => {
  render(<CampaignProducts
    campaignId={7}
    campaign={{ id: 7, name: 'VivaTrees Christmas' }}
    campaignProducts={[
      { id: 21, product_name: 'Everglow', role: 'hero', status: 'active', campaign_brief: '主推灯光效果' },
      { id: 22, product_name: 'Evercrest', role: 'secondary', status: 'active', campaign_brief: '强调性价比' }
    ]}
    onRefresh={jest.fn()}
  />);

  expect(screen.getByText('Everglow')).toBeInTheDocument();
  expect(screen.getByText('Evercrest')).toBeInTheDocument();
  expect(screen.getByText('主推灯光效果')).toBeInTheDocument();
  expect(screen.getByText('强调性价比')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd client && CI=true npm test -- --runInBand src/pages/CampaignProducts.test.js`

Expected: FAIL，组件不存在。

- [ ] **Step 3: 抽取现有产品抽屉能力**

将 `Campaigns.js` 中产品加载、添加、编辑和归档 UI 移入 `CampaignProducts.js`。字段名称保持现有 API：

```js
{
  product_id,
  role: 'hero' | 'secondary' | 'test',
  priority: number,
  campaign_brief: string,
  status: 'planned' | 'active' | 'paused' | 'completed' | 'archived'
}
```

`Campaigns.js` 只保留项目列表与新建项目能力，点击项目名称导航到 `/campaigns/:id/overview`，不再打开产品管理 Drawer。

- [ ] **Step 4: 运行产品与原契约测试**

Run: `cd client && CI=true npm test -- --runInBand src/pages/CampaignProducts.test.js src/pages/productCampaignContract.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client/src/pages/CampaignProducts.js client/src/pages/CampaignProducts.test.js client/src/pages/Campaigns.js client/src/pages/CampaignWorkspace.js
git commit -m "feat: move product requirements into campaigns"
```

---

### Task 4: 将 KOL 策略限定到当前项目

**Files:**
- Modify: `client/src/pages/KolStrategy.js`
- Create: `client/src/pages/KolStrategy.campaign.test.js`
- Modify: `client/src/pages/CampaignWorkspace.js`

**Interfaces:**
- Adds props: `KolStrategy({campaignId, embedded = false})`
- When `campaignId` exists, consumes `GET /api/kol-strategies?campaign_id=:campaignId`
- Existing standalone behavior remains callable during migration but is no longer a primary route。

- [ ] **Step 1: 写项目范围测试**

```js
test('requests and renders only strategies for the current campaign', async () => {
  axios.get.mockResolvedValueOnce({ data: { data: [{
    id: 31, campaign_id: 7, campaign_name: 'VivaTrees Christmas',
    product_name: 'Everglow', name: 'Everglow Strategy', status: 'draft'
  }] } });

  render(<KolStrategy campaignId={7} embedded />);

  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(
    '/api/kol-strategies', { params: expect.objectContaining({ campaign_id: 7 }) }
  ));
  expect(await screen.findByText('Everglow Strategy')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd client && CI=true npm test -- --runInBand src/pages/KolStrategy.campaign.test.js`

Expected: FAIL，因为组件尚未接受项目范围参数。

- [ ] **Step 3: 实现项目范围模式**

`campaignId` 存在时：固定请求参数，不显示全局 Campaign 筛选器；创建策略时强制使用当前 `campaignId`；页面标题改为“KOL 策略”；保留按 Campaign Product 展示及发布按钮。

- [ ] **Step 4: 运行策略测试**

Run: `cd client && CI=true npm test -- --runInBand src/pages/KolStrategy.campaign.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client/src/pages/KolStrategy.js client/src/pages/KolStrategy.campaign.test.js client/src/pages/CampaignWorkspace.js
git commit -m "feat: scope strategies to campaign workspace"
```

---

### Task 5: 将 KOL 寻找限定到当前项目

**Files:**
- Modify: `client/src/pages/RawCandidates.js`
- Create: `client/src/pages/RawCandidates.campaign.test.js`
- Modify: `client/src/pages/CampaignWorkspace.js`

**Interfaces:**
- Adds props: `RawCandidates({campaignId, embedded = false})`
- Consumes: `GET /api/kol-strategies?campaign_id=:campaignId`
- Consumes: `GET /api/raw-candidates?campaign_id=:campaignId`
- Preserves existing Finder task, evidence and approval APIs。

- [ ] **Step 1: 写项目范围测试**

```js
test('keeps finder tasks and candidates inside the current campaign', async () => {
  render(<RawCandidates campaignId={7} embedded />);

  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(
    '/api/raw-candidates', { params: expect.objectContaining({ campaign_id: 7 }) }
  ));
  expect(screen.queryByText('选择项目')).not.toBeInTheDocument();
  expect(await screen.findByText('通过')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd client && CI=true npm test -- --runInBand src/pages/RawCandidates.campaign.test.js`

Expected: FAIL，因为全局项目筛选仍存在或请求未固定 `campaign_id`。

- [ ] **Step 3: 实现项目范围模式**

项目模式下隐藏 Campaign 选择器，但保留产品和策略筛选；所有候选加载、审批和 Finder 创建请求必须携带当前 Campaign 与所选 Campaign Product/Strategy 的已有绑定，不能从页面外状态推断其他项目。

- [ ] **Step 4: 运行寻找测试**

Run: `cd client && CI=true npm test -- --runInBand src/pages/RawCandidates.campaign.test.js src/pages/RawCandidates.test.js src/pages/finderTaskContract.test.js`

Expected: PASS，且原有“已有 KOL · 新产品匹配”测试继续通过。

- [ ] **Step 5: 提交**

```bash
git add client/src/pages/RawCandidates.js client/src/pages/RawCandidates.campaign.test.js client/src/pages/CampaignWorkspace.js
git commit -m "feat: scope kol discovery to campaign workspace"
```

---

### Task 6: 将 KOL 合作限定到当前项目

**Files:**
- Modify: `client/src/pages/CampaignKols.js`
- Modify: `client/src/pages/CampaignKols.test.js`
- Modify: `client/src/pages/CampaignWorkspace.js`

**Interfaces:**
- Adds props: `CampaignKols({campaignId, embedded = false})`
- Consumes: `GET /api/campaigns/:campaignId/kols`
- Preserves Campaign KOL Product assignment endpoints and Feishu sync behavior。

- [ ] **Step 1: 增加项目范围失败测试**

```js
test('loads cooperation records from the workspace campaign', async () => {
  render(<CampaignKols campaignId={7} embedded />);

  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/campaigns/7/kols'));
  expect(screen.queryByText('选择项目')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd client && CI=true npm test -- --runInBand src/pages/CampaignKols.test.js`

Expected: 新测试 FAIL，因为组件仍依赖内部项目选择。

- [ ] **Step 3: 实现项目范围模式**

当传入 `campaignId` 时，跳过全局 Campaign 加载与选择器，直接加载当前项目合作记录；产品分配详情、编辑和同步结果继续使用现有逻辑，不改变 API shape。

- [ ] **Step 4: 运行合作测试**

Run: `cd client && CI=true npm test -- --runInBand src/pages/CampaignKols.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client/src/pages/CampaignKols.js client/src/pages/CampaignKols.test.js client/src/pages/CampaignWorkspace.js
git commit -m "feat: scope kol cooperation to campaign workspace"
```

---

### Task 7: 建立内容分析与设置聚合入口

**Files:**
- Create: `client/src/pages/ContentAnalysis.js`
- Create: `client/src/pages/ContentAnalysis.test.js`
- Create: `client/src/pages/SystemSettings.js`
- Create: `client/src/pages/SystemSettings.test.js`
- Modify: `client/src/App.js`

**Interfaces:**
- `ContentAnalysis` composes existing `VideoAnalysis` and `Records` under tabs `分析任务`, `视频库`, `分析结果`；“新建分析”只显示阶段说明，本阶段不实现 AI 意图判断。
- `SystemSettings` composes existing `Settings` and `Templates` under tabs `API 与连接`, `Prompt 规范`。

- [ ] **Step 1: 写聚合入口失败测试**

```js
test('content analysis owns video and result navigation', () => {
  render(<ContentAnalysis />);
  expect(screen.getByText('内容分析')).toBeInTheDocument();
  expect(screen.getByText('分析任务')).toBeInTheDocument();
  expect(screen.getByText('视频库')).toBeInTheDocument();
  expect(screen.getByText('分析结果')).toBeInTheDocument();
});

test('settings owns api and prompt navigation', () => {
  render(<SystemSettings />);
  expect(screen.getByText('API 与连接')).toBeInTheDocument();
  expect(screen.getByText('Prompt 规范')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd client && CI=true npm test -- --runInBand src/pages/ContentAnalysis.test.js src/pages/SystemSettings.test.js`

Expected: FAIL，两个聚合组件不存在。

- [ ] **Step 3: 实现聚合组件**

使用 Ant Design `Tabs` 延迟挂载现有页面：

```js
const items = [
  { key: 'tasks', label: '分析任务', children: <Alert message="研究目标驱动的新建分析将在下一阶段接入外部智能体" /> },
  { key: 'videos', label: '视频库', children: <VideoAnalysis embedded /> },
  { key: 'results', label: '分析结果', children: <Records embedded /> }
];
```

设置以相同方式组合 `Settings` 和 `Templates`。若现有子组件不接受 `embedded`，新增该可选 prop 只隐藏重复页头，不改变请求逻辑。

- [ ] **Step 4: 运行聚合测试**

Run: `cd client && CI=true npm test -- --runInBand src/pages/ContentAnalysis.test.js src/pages/SystemSettings.test.js`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client/src/pages/ContentAnalysis.js client/src/pages/ContentAnalysis.test.js client/src/pages/SystemSettings.js client/src/pages/SystemSettings.test.js client/src/pages/VideoAnalysis.js client/src/pages/Records.js client/src/pages/Settings.js client/src/pages/Templates.js client/src/App.js
git commit -m "feat: consolidate analysis and settings navigation"
```

---

### Task 8: 完整导航回归与生产验证

**Files:**
- Create: `client/src/App.navigation.test.js`
- Modify: `client/src/App.js`

**Interfaces:**
- Verifies every route and component interface produced by Tasks 1–7。

- [ ] **Step 1: 写端到端式路由测试**

```js
test('opens a campaign and moves through all project workflow tabs', async () => {
  render(<App />, { wrapper: BrowserRouter });
  fireEvent.click(await screen.findByText('VivaTrees Christmas'));
  expect(await screen.findByText('项目概览')).toBeInTheDocument();

  for (const tab of ['产品需求', 'KOL 策略', 'KOL 寻找', 'KOL 合作']) {
    fireEvent.click(screen.getByText(tab));
    expect(await screen.findByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
});
```

- [ ] **Step 2: 运行所有客户端测试**

Run: `cd client && CI=true npm test -- --runInBand`

Expected: 所有 Test Suites PASS；允许现有 React `act` deprecation warning，但不得出现未处理 Promise rejection。

- [ ] **Step 3: 运行服务端回归测试**

Run: `cd server && npm test`

Expected: 全部测试 PASS，证明前端重组未要求破坏现有 API。

- [ ] **Step 4: 运行生产构建与补丁检查**

Run: `cd client && npm run build`

Expected: `Compiled successfully.`

Run: `git diff --check`

Expected: 无输出，退出码 0。

- [ ] **Step 5: 提交最终修正**

仅当本任务产生修正时执行：

```bash
git add client/src/App.navigation.test.js client/src
git commit -m "test: verify project-centered navigation"
```

如果没有修正，只记录测试命令、通过数量和非阻塞警告，不创建空提交。

---

## 后续独立计划

本计划完成后，按顺序编写并执行：

1. `external-agent-project-strategy-api`：项目预检、事务式创建、产品匹配、策略草案版本、确认发布、幂等与审计。
2. `goal-driven-content-analysis`：研究目标输入、外部智能体类型判断、分析方案确认、跨项目任务与证据归档。

这两个子系统不得提前混入本计划，以保持每阶段可独立验收和回滚。
