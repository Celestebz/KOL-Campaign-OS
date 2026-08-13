const test = require('node:test');
const assert = require('node:assert/strict');
const {
  syncConfirmedToFeishu,
  syncOrdinarySheetTarget,
  syncBitableTarget
} = require('./confirmCooperationSync');

test('syncOrdinarySheetTarget pushes a confirmed row to the configured ordinary sheet', async () => {
  const runtime = {
    getSheetConfig: async () => ({ sheetId: 'uSIrMc' }),
    pushToSheet: async () => ({ created: 1, updated: 0, skipped: 0 })
  };
  const target = await syncOrdinarySheetTarget({ id: 7, campaign_id: 61 }, runtime);
  assert.equal(target.success, true);
  assert.equal(target.type, 'sheet');
  assert.equal(target.created, 1);
});

test('syncOrdinarySheetTarget skips projects without an ordinary sheet mapping', async () => {
  const runtime = {
    getSheetConfig: async () => {
      throw new Error('飞书普通表格配置不完整：sheetId');
    },
    pushToSheet: async () => ({ created: 1 })
  };
  const target = await syncOrdinarySheetTarget({ id: 7, campaign_id: 2 }, runtime);
  assert.equal(target, null);
});

test('syncOrdinarySheetTarget reports push failures without throwing', async () => {
  const runtime = {
    getSheetConfig: async () => ({ sheetId: 'uSIrMc' }),
    pushToSheet: async () => {
      throw new Error('飞书连接超时');
    }
  };
  const target = await syncOrdinarySheetTarget({ id: 7, campaign_id: 61 }, runtime);
  assert.equal(target.success, false);
  assert.match(target.error, /飞书连接超时/);
});

test('syncBitableTarget pushes to the configured bitable tracking table', async () => {
  const runtime = {
    syncRoutes: {
      getFeishuConfig: async () => ({ campaign_tracking_map: { 2: 'tblProjectTracking' } }),
      getTenantAccessToken: async () => 'token',
      syncCampaignKols: async () => [{ success: true }]
    }
  };
  const target = await syncBitableTarget({ id: 7, campaign_id: 2 }, runtime);
  assert.equal(target.success, true);
  assert.equal(target.type, 'bitable');
});

test('syncBitableTarget skips projects without a bitable tracking mapping', async () => {
  const runtime = {
    syncRoutes: {
      getFeishuConfig: async () => ({ campaign_tracking_map: {} }),
      getTenantAccessToken: async () => 'token',
      syncCampaignKols: async () => [{ success: true }]
    }
  };
  const target = await syncBitableTarget({ id: 7, campaign_id: 2 }, runtime);
  assert.equal(target, null);
});

test('syncConfirmedToFeishu returns one target per configured export', async () => {
  const runtime = {
    loadRow: async () => ({ id: 7, campaign_id: 61 }),
    getSheetConfig: async () => ({ sheetId: 'uSIrMc' }),
    pushToSheet: async () => ({ created: 1 }),
    syncRoutes: {
      getFeishuConfig: async () => ({ campaign_tracking_map: { 61: 'tblProjectTracking' } }),
      getTenantAccessToken: async () => 'token',
      syncCampaignKols: async () => [{ success: true }]
    }
  };
  const result = await syncConfirmedToFeishu(7, runtime);
  assert.deepEqual(result.targets.map((item) => item.type), ['sheet', 'bitable']);
  assert.ok(result.targets.every((item) => item.success));
});

test('syncConfirmedToFeishu returns no targets when no export is configured', async () => {
  const runtime = {
    loadRow: async () => ({ id: 7, campaign_id: 2 }),
    getSheetConfig: async () => {
      throw new Error('飞书普通表格配置不完整：sheetId');
    },
    syncRoutes: {
      getFeishuConfig: async () => ({ campaign_tracking_map: {} }),
      getTenantAccessToken: async () => 'token',
      syncCampaignKols: async () => [{ success: true }]
    }
  };
  const result = await syncConfirmedToFeishu(7, runtime);
  assert.deepEqual(result.targets, []);
});
