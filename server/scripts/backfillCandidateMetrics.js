const { initDatabase, dbOperations } = require('../database');

async function main() {
  await initDatabase();
  const result = await dbOperations.run(
    `UPDATE campaign_kols ck
     JOIN customers c ON c.id = ck.customer_id
     SET ck.posts_30d_snapshot = c.youtube_posts_30d,
         ck.avg_views_30d_snapshot = c.youtube_avg_views_30d,
         ck.median_views_30d_snapshot = c.youtube_median_views_30d,
         ck.engagement_rate_30d_snapshot = c.youtube_engagement_rate_30d,
         ck.youtube_snapshot_updated_at = c.youtube_snapshot_updated_at,
         ck.sync_status = 'sync_pending',
         ck.updated_at = CURRENT_TIMESTAMP
     WHERE ck.campaign_id IN (2, 3)`
  );
  console.log(JSON.stringify({ updated: result.changes || result.affectedRows || 0 }));
  process.exit();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
