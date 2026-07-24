const { initDatabase, dbOperations } = require('../database');

const CURATED = {
  'TMB-1401': {
    campaignId: 2,
    ids: [751, 487, 906, 451, 469, 178, 1089, 319, 685, 1404, 568, 518, 269, 321, 767, 315, 320, 322, 815, 573, 887, 672, 988, 202, 1411, 787, 402, 169, 340, 336, 396, 668, 376, 314, 533],
    pattern: /tractor|mower|mowing|pto|implement|brush hog|bush hog|pasture/gi
  },
  'TRA-0429': {
    campaignId: 3,
    ids: [644, 661, 153, 691, 1359, 833, 1410, 865, 1345, 1038],
    pattern: /chipper|wood|tree|forestry|logging|firewood|sawmill|chainsaw|brush/gi
  }
};

function gradeBonus(row) {
  const posts = Number(row.youtube_posts_30d || 0);
  const median = Number(row.youtube_median_views_30d || 0);
  const engagement = Number(row.youtube_engagement_rate_30d || 0);
  if (posts < 3) return 0;
  if (median >= 50000 && engagement >= 0.03) return 8;
  if (median >= 15000 && engagement >= 0.015) return 5;
  return 2;
}

async function main() {
  await initDatabase();
  const summary = { created: [], existing: [], failed: [] };
  const globallyAssigned = new Set((await dbOperations.query(
    'SELECT customer_id FROM campaign_kols WHERE campaign_id IN (2, 3)'
  )).map((row) => Number(row.customer_id)));

  for (const [sku, config] of Object.entries(CURATED)) {
    const campaignProduct = await dbOperations.get(
      `SELECT cp.id FROM campaign_products cp JOIN products p ON p.id = cp.product_id
       WHERE cp.campaign_id = ? AND p.sku = ? ORDER BY cp.id LIMIT 1`,
      [config.campaignId, sku]
    );
    if (!campaignProduct) throw new Error(`Missing campaign product for ${sku}`);

    for (const customerId of config.ids) {
      try {
        if (globallyAssigned.has(customerId)) {
          summary.existing.push({ customerId, sku });
          continue;
        }
        const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
        if (!customer || customer.cooperation_status === 'do_not_contact') throw new Error('KOL unavailable or not recommended');
        const account = await dbOperations.get(
          "SELECT * FROM kol_platform_accounts WHERE customer_id = ? AND LOWER(platform) = 'youtube' ORDER BY id LIMIT 1",
          [customerId]
        );
        const videos = await dbOperations.query(
          `SELECT title, video_url FROM kol_youtube_snapshot_videos
           WHERE customer_id = ? AND included_in_aggregate = 1 ORDER BY published_at DESC`,
          [customerId]
        );
        const titleText = videos.map((video) => video.title).join(' | ');
        const hits = (titleText.match(config.pattern) || []).length;
        const score = Math.min(95, 62 + Math.min(25, hits * 4) + gradeBonus(customer));
        const evidenceTitles = videos.filter((video) => (video.title.match(config.pattern) || []).length > 0).slice(0, 3);
        const evidence = evidenceTitles.length
          ? evidenceTitles.map((video) => video.title).join('；')
          : `频道画像与${sku === 'TMB-1401' ? '农场/拖拉机作业' : '林地/木材处理'}场景匹配，近期直接题材待继续补证`;
        const reason = `KOL总表深度复核；近期长视频关键词命中 ${hits} 次；${evidence}`;
        const result = await dbOperations.run(
          `INSERT INTO campaign_kols
           (campaign_id, customer_id, platform_account_id, target_platform, source, project_status,
            priority_level, candidate_priority_score, evidence_summary, best_evidence_url, project_notes,
            sync_status, created_at, updated_at)
           VALUES (?, ?, ?, 'youtube', ?, 'pending_confirmation', ?, ?, ?, ?, ?, 'sync_pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [config.campaignId, customerId, account?.id || null, `kol_master_deep_mining:${sku}`,
            score >= 85 ? 'T1' : score >= 75 ? 'T2' : 'T3', score,
            JSON.stringify({ summary: reason }), evidenceTitles[0]?.video_url || null, reason]
        );
        await dbOperations.run(
          `INSERT INTO campaign_kol_products
           (campaign_kol_id, campaign_product_id, fit_score, fit_status, evidence_summary, assignment_status, created_at, updated_at)
           VALUES (?, ?, ?, 'approved', ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [result.id, campaignProduct.id, score, JSON.stringify({ summary: reason })]
        );
        globallyAssigned.add(customerId);
        summary.created.push({ id: result.id, customerId, name: customer.name, sku, score, hits });
      } catch (error) {
        summary.failed.push({ customerId, sku, error: error.message });
      }
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
