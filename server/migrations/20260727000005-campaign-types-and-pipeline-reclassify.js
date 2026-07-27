// 项目体系整理：campaigns 增加 campaign_type/status/period，区分当前项目、
// 历史归档与系统默认项目；campaign_kols 依据 Campaign 类型重新划分
// candidate / historical；TSA-0512 项目框架；(customer_id, campaign_id) 唯一约束；
// 飞书统一候选池映射。全程事务：数量不符、SKU 不符、重复记录、无法归类的
// 记录都会抛错回滚，由调用方汇报差异明细。
const UNIFIED_POOL_TABLE_ID = 'tblhk2nDkERA6jM4';
const EXPECTED = {
  total: 104,
  candidate: 60,
  confirmed: 0,
  heroSku: { 2: 'TMB-1401', 3: 'TRA-0429' },
  names: { 2: 'TMB-1401｜Finishing Mower', 3: 'TRA-0429｜Wood Chipper' }
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    const query = (sql, replacements) => sequelize.query(sql, { replacements, transaction });
    const rows = async (sql, replacements) => {
      const [result] = await query(sql, replacements);
      return result;
    };

    try {
      // 1. campaigns 新字段（默认值兼容旧数据）
      const campaignColumns = await queryInterface.describeTable('campaigns', { transaction });
      if (!campaignColumns.campaign_type) {
        await queryInterface.addColumn('campaigns', 'campaign_type', {
          type: Sequelize.STRING(30), allowNull: false, defaultValue: 'active_project',
          comment: 'active_project=当前项目；historical_archive=历史归档；system_default=系统默认'
        }, { transaction });
      }
      if (!campaignColumns.status) {
        await queryInterface.addColumn('campaigns', 'status', {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'active',
          comment: 'active=启用；archived=归档'
        }, { transaction });
      }
      if (!campaignColumns.period) {
        await queryInterface.addColumn('campaigns', 'period', {
          type: Sequelize.STRING(50), allowNull: true, comment: '项目周期，如 2026 Q3'
        }, { transaction });
      }

      // 2. (customer_id, campaign_id) 唯一索引：无重复数据才添加；
      // 有重复的环境跳过并输出重复报告，不让迁移失败。
      const duplicatePairs = await rows(
        `SELECT customer_id, campaign_id, COUNT(*) AS c FROM campaign_kols
         GROUP BY customer_id, campaign_id HAVING c > 1`
      );
      const existingIndexes = await rows(`SHOW INDEX FROM campaign_kols WHERE Key_name = 'uniq_campaign_kols_customer_campaign'`);
      if (!existingIndexes.length) {
        if (duplicatePairs.length) {
          console.warn(`[migration] 存在重复 customer_id+campaign_id，跳过唯一索引: ${JSON.stringify(duplicatePairs.slice(0, 10))}`);
        } else {
          await queryInterface.addIndex('campaign_kols', ['customer_id', 'campaign_id'], {
            unique: true, name: 'uniq_campaign_kols_customer_campaign', transaction
          });
        }
      }

      // 3. 数据分类只在匹配生产数据特征时执行；空库/测试库只做 schema 变更。
      const campaigns = await rows('SELECT id, name FROM campaigns');
      const campaignIds = new Set(campaigns.map((c) => c.id));
      const productionSignature = [1, 2, 3].every((id) => campaignIds.has(id))
        && campaigns.some((c) => String(c.name).startsWith('BILTHARD 历史合作｜'));
      if (!productionSignature) {
        await transaction.commit();
        console.log('[migration] 非生产数据集（空库或测试库），已完成 schema 变更，跳过数据分类');
        return;
      }

      // 4. 安全校验：Campaign 2/3 的 hero SKU 必须与预期一致
      const heroRows = await rows(
        `SELECT cp.campaign_id, p.sku FROM campaign_products cp
         JOIN products p ON p.id = cp.product_id
         WHERE cp.campaign_id IN (2, 3) AND cp.role = 'hero'`
      );
      for (const [campaignId, expectedSku] of Object.entries(EXPECTED.heroSku)) {
        const actual = heroRows.filter((r) => String(r.campaign_id) === String(campaignId)).map((r) => r.sku);
        if (!actual.includes(expectedSku)) {
          throw new Error(`安全校验失败：Campaign ${campaignId} 预期 SKU ${expectedSku}，实际 ${JSON.stringify(actual)}，已回滚`);
        }
      }

      // 4. Campaign 分类
      await query(
        `UPDATE campaigns SET campaign_type = 'system_default', status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = 1`
      );
      await query(
        `UPDATE campaigns SET campaign_type = 'active_project', status = 'active', period = '2026 Q3', name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 2`,
        [EXPECTED.names[2]]
      );
      await query(
        `UPDATE campaigns SET campaign_type = 'active_project', status = 'active', period = '2026 Q3', name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 3`,
        [EXPECTED.names[3]]
      );
      await query(
        `UPDATE campaigns SET campaign_type = 'historical_archive', status = 'archived', updated_at = CURRENT_TIMESTAMP
         WHERE name LIKE 'BILTHARD 历史合作｜%'`
      );

      // 5. 安全校验：除 1/2/3 与历史归档外不应有其他 Campaign
      const unclassified = await rows(
        `SELECT id, name FROM campaigns WHERE id NOT IN (1, 2, 3) AND campaign_type <> 'historical_archive'`
      );
      if (unclassified.length) {
        throw new Error(`安全校验失败：存在无法归类的 Campaign ${JSON.stringify(unclassified)}，已回滚`);
      }

      // 6. TSA-0512 项目框架（产品库没有 TSA-0512 时不虚构产品，只建项目）
      const tsaProduct = await rows('SELECT id FROM products WHERE sku = ?', ['TSA-0512']);
      let tsaCampaign = await rows('SELECT id FROM campaigns WHERE name = ?', ['TSA-0512']);
      let tsaCampaignId;
      if (tsaCampaign.length) {
        tsaCampaignId = tsaCampaign[0].id;
        await query(
          `UPDATE campaigns SET campaign_type = 'active_project', status = 'active', period = '2026 Q3', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [tsaCampaignId]
        );
      } else {
        const [result] = await sequelize.query(
          `INSERT INTO campaigns (name, brand, campaign_type, status, period, created_at, updated_at)
           VALUES ('TSA-0512', 'BILT HARD', 'active_project', 'active', '2026 Q3', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          { transaction }
        );
        tsaCampaignId = result;
      }
      if (tsaProduct.length) {
        const bound = await rows('SELECT id FROM campaign_products WHERE campaign_id = ? AND product_id = ?', [tsaCampaignId, tsaProduct[0].id]);
        if (!bound.length) {
          await query(
            `INSERT INTO campaign_products (campaign_id, product_id, role, priority, status, created_at, updated_at)
             VALUES (?, ?, 'hero', 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [tsaCampaignId, tsaProduct[0].id]
          );
        }
      }

      // 7. 安全校验：campaign_kols 总数与重复对
      const totalRow = await rows('SELECT COUNT(*) AS c FROM campaign_kols');
      const total = Number(totalRow[0].c);
      if (total !== EXPECTED.total) {
        throw new Error(`安全校验失败：campaign_kols 总数预期 ${EXPECTED.total}，实际 ${total}，已回滚`);
      }
      const duplicates = await rows(
        `SELECT customer_id, campaign_id, COUNT(*) AS c FROM campaign_kols
         GROUP BY customer_id, campaign_id HAVING c > 1`
      );
      if (duplicates.length) {
        throw new Error(`安全校验失败：存在重复 customer_id+campaign_id ${JSON.stringify(duplicates.slice(0, 20))}，已回滚`);
      }

      // 8. 重新划分 campaign_kols（依据 Campaign 类型，不依据名称）
      await query(
        `UPDATE campaign_kols ck JOIN campaigns c ON c.id = ck.campaign_id
         SET ck.pipeline_stage = 'historical', ck.sync_status = 'sync_disabled', ck.updated_at = CURRENT_TIMESTAMP
         WHERE c.campaign_type = 'historical_archive' AND ck.pipeline_stage <> 'historical'`
      );
      await query(
        `UPDATE campaign_kols ck JOIN campaigns c ON c.id = ck.campaign_id
         SET ck.pipeline_stage = 'candidate', ck.project_status = 'pending_confirmation',
             ck.confirmed_at = NULL, ck.updated_at = CURRENT_TIMESTAMP
         WHERE c.campaign_type = 'active_project' AND ck.pipeline_stage <> 'confirmed'`
      );

      // 9. 安全校验：不应有归属未归类 Campaign 的 campaign_kols
      const orphaned = await rows(
        `SELECT ck.id, ck.campaign_id FROM campaign_kols ck
         JOIN campaigns c ON c.id = ck.campaign_id
         WHERE c.campaign_type NOT IN ('active_project', 'historical_archive')`
      );
      if (orphaned.length) {
        throw new Error(`安全校验失败：存在归属未归类 Campaign 的 campaign_kols ${JSON.stringify(orphaned.slice(0, 20))}，已回滚`);
      }

      // 10. 安全校验：最终统计必须吻合
      const stageCounts = await rows('SELECT pipeline_stage, COUNT(*) AS c FROM campaign_kols GROUP BY pipeline_stage');
      const counts = Object.fromEntries(stageCounts.map((r) => [r.pipeline_stage, Number(r.c)]));
      const candidate = counts.candidate || 0;
      const confirmed = counts.confirmed || 0;
      const historical = counts.historical || 0;
      if (candidate !== EXPECTED.candidate || confirmed !== EXPECTED.confirmed || historical !== EXPECTED.total - EXPECTED.candidate) {
        throw new Error(
          `安全校验失败：最终统计 candidate=${candidate}（预期 ${EXPECTED.candidate}）、` +
          `confirmed=${confirmed}（预期 ${EXPECTED.confirmed}）、historical=${historical}（预期 ${EXPECTED.total - EXPECTED.candidate}），已回滚`
        );
      }

      // 11. (customer_id, campaign_id) 唯一索引（前面已确认无重复）
      const indexes = await rows(`SHOW INDEX FROM campaign_kols WHERE Key_name = 'uniq_campaign_kols_customer_campaign'`);
      if (!indexes.length) {
        await queryInterface.addIndex('campaign_kols', ['customer_id', 'campaign_id'], {
          unique: true, name: 'uniq_campaign_kols_customer_campaign', transaction
        });
      }

      // 12. 飞书统一候选池映射：当前项目全部指向同一张表。
      // 注意：campaign_subtable_map 在配置里可能是 JSON 字符串而非对象，
      // 直接展开字符串会产生字符索引垃圾键，必须先解析。
      const configRows = await rows(`SELECT extra_config FROM api_settings WHERE provider = 'cloud.feishu_bitable'`);
      if (configRows.length) {
        const extra = JSON.parse(configRows[0].extra_config || '{}');
        let existingMap = extra.campaign_subtable_map;
        if (typeof existingMap === 'string') {
          try { existingMap = JSON.parse(existingMap); } catch (error) { existingMap = {}; }
        }
        if (!existingMap || typeof existingMap !== 'object' || Array.isArray(existingMap)) existingMap = {};
        const map = { ...existingMap };
        map['2'] = UNIFIED_POOL_TABLE_ID;
        map['3'] = UNIFIED_POOL_TABLE_ID;
        map[String(tsaCampaignId)] = UNIFIED_POOL_TABLE_ID;
        extra.campaign_subtable_map = map;
        await query(
          `UPDATE api_settings SET extra_config = ? WHERE provider = 'cloud.feishu_bitable'`,
          [JSON.stringify(extra)]
        );
      }

      await transaction.commit();
      console.log(`[migration] campaign 分类完成；TSA-0512 campaign_id=${tsaCampaignId}；` +
        `campaign_kols: candidate=${candidate}, confirmed=${confirmed}, historical=${historical}`);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    const rows = async (sql, replacements) => {
      const [result] = await sequelize.query(sql, { replacements, transaction });
      return result;
    };

    try {
      const indexes = await rows(`SHOW INDEX FROM campaign_kols WHERE Key_name = 'uniq_campaign_kols_customer_campaign'`);
      if (indexes.length) {
        await queryInterface.removeIndex('campaign_kols', 'uniq_campaign_kols_customer_campaign', { transaction });
      }

      await sequelize.query(
        `UPDATE campaign_kols SET pipeline_stage = 'candidate', sync_status = 'sync_pending', updated_at = CURRENT_TIMESTAMP
         WHERE pipeline_stage = 'historical'`,
        { transaction }
      );
      await sequelize.query(
        `UPDATE campaigns SET name = 'BILT HARD TMB-1401 割草机 2026 Q3', updated_at = CURRENT_TIMESTAMP WHERE id = 2`,
        { transaction }
      );
      await sequelize.query(
        `UPDATE campaigns SET name = 'BILT HARD TRA-0429 碎枝机 2026 Q3', updated_at = CURRENT_TIMESTAMP WHERE id = 3`,
        { transaction }
      );
      const tsa = await rows(
        `SELECT c.id FROM campaigns c
         LEFT JOIN campaign_kols ck ON ck.campaign_id = c.id
         WHERE c.name = 'TSA-0512' GROUP BY c.id HAVING COUNT(ck.id) = 0`
      );
      for (const row of tsa) {
        await sequelize.query('DELETE FROM campaign_products WHERE campaign_id = ?', { replacements: [row.id], transaction });
        await sequelize.query('DELETE FROM campaigns WHERE id = ?', { replacements: [row.id], transaction });
      }

      const campaignColumns = await queryInterface.describeTable('campaigns', { transaction });
      for (const name of ['period', 'status', 'campaign_type']) {
        if (campaignColumns[name]) await queryInterface.removeColumn('campaigns', name, { transaction });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
