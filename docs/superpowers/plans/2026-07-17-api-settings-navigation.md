# API Settings Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 API 设置页重构为顶部吸顶分区标签、紧凑 Provider 卡片和右侧配置抽屉，同时保持现有设置接口与用户数据不变。

**Architecture:** `Settings` 继续拥有完整设置对象和唯一保存入口；纯函数契约负责默认值深度合并、配置完整度和局部更新，UI 组件只消费这些结果。桌面端显示顶部标签，窄屏显示分类下拉；Provider 字段在 Drawer 中编辑，保存时仍提交完整 `{ settings }`。

**Tech Stack:** React 18、Ant Design 5、Axios、Create React App/Jest、Testing Library、CSS。

## Global Constraints

- 不改变 `GET /api/settings` 与 `POST /api/settings` 的请求或响应结构。
- 不删除、迁移或重写任何已有用户设置数据。
- 密钥值 `••••••••` 不得作为真实新密钥处理；留空或遮罩值保持后端现有保留语义。
- 不新增前端依赖。
- 页面使用顶部吸顶分区标签，不新增第二层左侧导航。
- 预留 Provider 默认隐藏；已有历史配置的预留 Provider 必须显示。
- 每次右侧只显示一个设置分区。

## File Structure

- Create `client/src/pages/settings/settingsContract.js`: Provider 元数据、默认值、深度合并、配置状态和不可变局部更新。
- Create `client/src/pages/settings/settingsContract.test.js`: 纯函数契约测试。
- Create `client/src/pages/settings/SettingsProviderComponents.js`: Provider 卡片、Provider Drawer、字段渲染。
- Create `client/src/pages/Settings.test.js`: 页面导航、抽屉、局部保存和错误状态测试。
- Create `client/src/pages/Settings.css`: 设置页布局、吸顶标签、卡片、状态和响应式样式。
- Modify `client/src/pages/Settings.js`: 页面容器、七个分区、数据加载、未保存状态和完整设置保存。

---

### Task 1: Settings 数据契约与 Provider 状态

**Files:**
- Create: `client/src/pages/settings/settingsContract.js`
- Test: `client/src/pages/settings/settingsContract.test.js`

**Interfaces:**
- Produces: `SETTINGS_SECTIONS`, `PLATFORM_META`, `AI_PROVIDERS`, `AGENT_PROVIDERS`, `DEFAULT_SETTINGS`。
- Produces: `mergeSettings(defaults, remote) -> Settings`，数组按远端值替换、对象递归合并。
- Produces: `hasProviderHistory(provider) -> boolean`。
- Produces: `getProviderState(meta, value, active) -> { configured, partial, visible, status, summary }`。
- Produces: `updateAtPath(source, path, value) -> Settings`，不修改原对象。

- [ ] **Step 1: 写深度合并和不可变更新的失败测试**

```js
import { DEFAULT_SETTINGS, mergeSettings, updateAtPath } from './settingsContract';

test('mergeSettings preserves nested defaults while accepting server values', () => {
  const result = mergeSettings(DEFAULT_SETTINGS, {
    platforms: { youtube: { primary: 'maton_gateway' } }
  });
  expect(result.platforms.youtube.primary).toBe('maton_gateway');
  expect(result.platforms.instagram.primary).toBe('scrapecreators');
  expect(result.cloudStorage.feishu.base_url).toBe('https://open.feishu.cn');
});

test('updateAtPath returns a new tree without mutating the loaded settings', () => {
  const loaded = mergeSettings(DEFAULT_SETTINGS, {});
  const next = updateAtPath(loaded, ['aiModels', 'active'], 'openai');
  expect(next.aiModels.active).toBe('openai');
  expect(loaded.aiModels.active).toBe('deepseek');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `CI=true npm test -- --runInBand settingsContract.test.js`

Expected: FAIL，提示无法解析 `./settingsContract`。

- [ ] **Step 3: 实现默认值、递归合并和路径更新**

```js
export const SECRET_MASK = '••••••••';

export const mergeSettings = (defaults, remote) => {
  if (Array.isArray(defaults)) return Array.isArray(remote) ? [...remote] : [...defaults];
  if (!defaults || typeof defaults !== 'object') return remote === undefined ? defaults : remote;
  const source = remote && typeof remote === 'object' ? remote : {};
  return Object.keys({ ...defaults, ...source }).reduce((result, key) => {
    result[key] = key in source ? mergeSettings(defaults[key], source[key]) : mergeSettings(defaults[key], undefined);
    return result;
  }, {});
};

export const updateAtPath = (source, path, value) => {
  if (!path.length) return value;
  const [head, ...tail] = path;
  return { ...source, [head]: updateAtPath(source?.[head] || {}, tail, value) };
};
```

在同一文件迁移现有 `PLATFORM_OPTIONS`、`AI_OPTIONS`、`AGENT_OPTIONS`、labels 和 `DEFAULT_SETTINGS`，把每个 Provider 统一为：

```js
{
  value: 'maton_gateway',
  label: 'Maton Gateway',
  reserved: false,
  fields: ['api_key', 'base_url', 'connection_id'],
  required: ['api_key']
}
```

- [ ] **Step 4: 写 Provider 可见性和状态的失败测试**

```js
test('reserved providers stay hidden unless configured or explicitly shown', () => {
  const reserved = { value: 'browseract', reserved: true, required: ['api_key'] };
  expect(getProviderState(reserved, {}, false).visible).toBe(false);
  expect(getProviderState(reserved, { base_url: 'http://localhost:3001' }, false).visible).toBe(true);
});

test('provider status distinguishes configured and partial values', () => {
  const meta = { value: 'maton_gateway', reserved: false, required: ['api_key', 'connection_id'] };
  expect(getProviderState(meta, { api_key: SECRET_MASK }, true).status).toBe('partial');
  expect(getProviderState(meta, { api_key: SECRET_MASK, connection_id: 'conn-1' }, true).status).toBe('configured');
});
```

- [ ] **Step 5: 实现配置状态函数并通过测试**

`hasProviderHistory` 将非空字符串、布尔值或数组视为历史配置，但忽略 `provider` 标识字段。`getProviderState` 使用 `required` 字段判定 `configured/partial/unconfigured`，并将 `active` 和 `reserved` 作为独立标签，不用单一颜色混淆含义。

Run: `CI=true npm test -- --runInBand settingsContract.test.js`

Expected: PASS。

- [ ] **Step 6: 提交契约层**

```bash
git add client/src/pages/settings/settingsContract.js client/src/pages/settings/settingsContract.test.js
git commit -m "test: define API settings presentation contract"
```

### Task 2: Provider 卡片与配置抽屉

**Files:**
- Create: `client/src/pages/settings/SettingsProviderComponents.js`
- Modify: `client/src/pages/Settings.css`
- Test: `client/src/pages/Settings.test.js`

**Interfaces:**
- Consumes: Task 1 的 Provider meta 与 `getProviderState`。
- Produces: `ProviderCard({ meta, value, active, onConfigure })`。
- Produces: `ProviderDrawer({ open, contextLabel, meta, initialValue, saving, error, onCancel, onSave })`。

- [ ] **Step 1: 写卡片与抽屉的失败测试**

```js
test('opens a provider drawer with only the selected provider fields', async () => {
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: '平台数据源' }));
  await userEvent.click(screen.getByRole('button', { name: /配置 Maton Gateway/ }));
  expect(screen.getByRole('dialog', { name: /配置 Maton Gateway/ })).toBeInTheDocument();
  expect(screen.getByLabelText('Maton Connection ID')).toBeInTheDocument();
  expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `CI=true npm test -- --runInBand Settings.test.js`

Expected: FAIL，当前页面不存在分区标签和 Provider Drawer。

- [ ] **Step 3: 实现卡片**

卡片使用语义按钮打开配置，显示 Provider 名称、用途、当前启用标签、配置状态和摘要。按钮必须提供 `aria-label="配置 Maton Gateway"`，当前启用卡片添加 `settings-provider-card--active` 类。

- [ ] **Step 4: 实现抽屉与字段映射**

```jsx
<Drawer
  title={`配置 ${meta.label}`}
  open={open}
  width={420}
  onClose={onCancel}
  destroyOnClose
  footer={<Space><Button onClick={onCancel}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存此配置</Button></Space>}
>
  <Text type="secondary">{contextLabel}</Text>
  <Form form={form} layout="vertical" onFinish={onSave} initialValues={initialValue}>
    {meta.fields.includes('api_key') && <Form.Item name="api_key" label="API Key"><Input.Password placeholder="留空保留现有密钥；输入新值则更新" /></Form.Item>}
    {meta.fields.includes('base_url') && <Form.Item name="base_url" label="Base URL"><Input placeholder="可留空使用默认值" /></Form.Item>}
    {meta.fields.includes('model') && <Form.Item name="model" label="Model"><Input /></Form.Item>}
    {meta.fields.includes('connection_id') && <Form.Item name="connection_id" label="Maton Connection ID"><Input /></Form.Item>}
  </Form>
</Drawer>
```

Custom Provider 同时渲染 `custom_provider_name`、`auth_header_name`、`auth_scheme`、`notes`。错误使用抽屉内 `Alert`，不清空表单。

- [ ] **Step 5: 添加设置页专属样式并通过测试**

在 `Settings.css` 定义 `.settings-section-nav` 吸顶标签、`.settings-provider-grid`、`.settings-provider-card` 和状态修饰类；`@media (max-width: 768px)` 下隐藏 Tabs、显示分类 Select、卡片单列。只使用 Ant Design 现有颜色变量或当前蓝灰色系。

Run: `CI=true npm test -- --runInBand Settings.test.js`

Expected: Provider 抽屉测试 PASS。

- [ ] **Step 6: 提交 Provider 组件**

```bash
git add client/src/pages/settings/SettingsProviderComponents.js client/src/pages/Settings.css client/src/pages/Settings.test.js
git commit -m "feat: add provider cards and settings drawer"
```

### Task 3: 七分区 Settings 页面与局部保存

**Files:**
- Modify: `client/src/pages/Settings.js`
- Modify: `client/src/pages/Settings.test.js`

**Interfaces:**
- Consumes: Task 1 契约和 Task 2 Provider 组件。
- Produces: 七个分区 UI、完整设置加载、局部更新与保存。

- [ ] **Step 1: 写分区显示和预留项行为的失败测试**

```js
test('shows one named settings section at a time and hides untouched reserved providers', async () => {
  render(<Settings />);
  expect(await screen.findByText('配置概览')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Agent 自动化' }));
  expect(screen.getByText('默认 Agent Provider')).toBeInTheDocument();
  expect(screen.queryByText('BrowserAct')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('switch', { name: '显示预留项' }));
  expect(screen.getByText('BrowserAct')).toBeInTheDocument();
});
```

- [ ] **Step 2: 写局部保存合并完整 Settings 的失败测试**

```js
test('saving one provider posts the complete settings tree and refreshes the page', async () => {
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: 'AI 模型' }));
  await userEvent.click(screen.getByRole('button', { name: /配置 DeepSeek/ }));
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
  expect(axios.get).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 3: 实现页面加载、错误和分区导航**

`fetchSettings` 使用 `mergeSettings(DEFAULT_SETTINGS, response.data.data || {})`。加载失败时在内容区展示带“重试”按钮的 `Alert`。`activeSection` 初始为 `overview`；桌面使用 Ant Design `Tabs`，窄屏渲染同一 `SETTINGS_SECTIONS` 的 Select。

- [ ] **Step 4: 实现平台、AI 和 Agent 分区**

平台分区使用二级平台 Tabs、主源 Select、备用源 Select、Provider 卡片网格和“显示预留项”Switch。AI 与 Agent 分区使用当前项 Select、卡片网格和同一预留项规则。

- [ ] **Step 5: 实现其余四个分区**

把现有 External Agent、Feishu 和 Fallback 字段移动到对应分区，字段 `name` 路径保持原样。概览通过当前 Settings 计算状态并提供 `setActiveSection(sectionKey)` 快捷入口，不进行网络健康推断。

- [ ] **Step 6: 实现完整对象局部保存**

Provider Drawer 保存时：

```js
const saveProvider = async (providerValues) => {
  const nextSettings = updateAtPath(settings, drawer.path, providerValues);
  await persistSettings(nextSettings);
  setDrawer(null);
};

const persistSettings = async (nextSettings) => {
  setSaving(true);
  try {
    await axios.post('/api/settings', { settings: nextSettings });
    await fetchSettings();
    message.success('API 设置已保存');
  } catch (error) {
    throw new Error(error.response?.data?.error || '保存失败');
  } finally {
    setSaving(false);
  }
};
```

分区级选择和开关通过所属分区的“保存更改”按钮提交 `form.getFieldsValue(true).settings`。任何保存失败必须保留当前输入。

- [ ] **Step 7: 运行页面测试**

Run: `CI=true npm test -- --runInBand Settings.test.js settingsContract.test.js`

Expected: PASS，无未处理 Promise 或 act warning。

- [ ] **Step 8: 提交页面重构**

```bash
git add client/src/pages/Settings.js client/src/pages/Settings.test.js
git commit -m "feat: reorganize API settings into focused sections"
```

### Task 4: 未保存保护、响应式验收与回归验证

**Files:**
- Modify: `client/src/pages/Settings.js`
- Modify: `client/src/pages/Settings.test.js`
- Modify: `client/src/pages/Settings.css`

**Interfaces:**
- Consumes: Task 3 页面状态和保存入口。
- Produces: 浏览器离开保护、稳定响应式布局和完整回归验证。

- [ ] **Step 1: 写未保存离开保护的失败测试**

```js
test('registers beforeunload only while settings contain unsaved changes', async () => {
  const addSpy = jest.spyOn(window, 'addEventListener');
  const removeSpy = jest.spyOn(window, 'removeEventListener');
  render(<Settings />);
  await screen.findByText('配置概览');
  await userEvent.click(screen.getByRole('tab', { name: '运行与备用策略' }));
  await userEvent.click(screen.getByRole('switch', { name: '主源失败后尝试备用源' }));
  expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  await userEvent.click(screen.getByRole('button', { name: '保存更改' }));
  await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function)));
});
```

- [ ] **Step 2: 实现 dirty 状态和浏览器离开保护**

使用 `Form` 的 `onValuesChange` 标记 `dirty`；保存成功和重新加载后清除。仅在 `dirty === true` 时注册 `beforeunload`，handler 调用 `event.preventDefault()` 并设置 `event.returnValue = ''`。抽屉关闭只清除抽屉临时值，不将页面状态错误标记为已保存。

- [ ] **Step 3: 完善响应式与焦点恢复**

抽屉宽度使用 `min(420px, 100vw)`；关闭时依赖 Ant Design Drawer 的焦点管理并验证触发按钮仍存在。顶部标签容器允许横向滚动，窄屏分类 Select 使用完整宽度。

- [ ] **Step 4: 运行全部相关测试**

Run: `CI=true npm test -- --runInBand Settings.test.js settingsContract.test.js finderTaskContract.test.js RawCandidates.test.js`

Expected: PASS。

- [ ] **Step 5: 运行生产构建**

Run: `npm run build`

Expected: `Compiled successfully.`，无 ESLint error。

- [ ] **Step 6: 检查差异与用户数据边界**

Run: `git diff --check`

Expected: 无输出。确认 `server/routes/settings.js`、数据库迁移和用户数据文件均未修改。

- [ ] **Step 7: 提交最终完善**

```bash
git add client/src/pages/Settings.js client/src/pages/Settings.test.js client/src/pages/Settings.css
git commit -m "fix: protect unsaved API settings changes"
```
