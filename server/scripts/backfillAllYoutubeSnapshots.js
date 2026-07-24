const { initDatabase, dbOperations } = require('../database');
const { runYoutubeIntakeSnapshot } = require('../services/youtubeIntakeSnapshot');

const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='));
const concurrency = Math.max(1, Math.min(10, Number(concurrencyArg?.split('=')[1] || 5)));

async function postJson(path, body) {
  const response = await fetch(`http://localhost:5001${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
  return data.data;
}

async function main() {
  await initDatabase();
  const rows = await dbOperations.query(
    `SELECT DISTINCT c.id, c.name
     FROM customers c
     LEFT JOIN kol_platform_accounts kpa
       ON kpa.customer_id = c.id AND LOWER(kpa.platform) = 'youtube'
     WHERE (c.youtube_snapshot_status IS NULL OR c.youtube_snapshot_status = 'failed')
       AND COALESCE(kpa.profile_url, c.youtube_url, '') <> ''
     ORDER BY c.id`
  );
  const queue = [...rows];
  const successIds = [];
  const failures = [];
  let completed = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      try {
        await runYoutubeIntakeSnapshot(row.id);
        successIds.push(row.id);
      } catch (error) {
        failures.push({ id: row.id, name: row.name, error: error.message });
      }
      completed += 1;
      if (completed % 25 === 0 || completed === rows.length) {
        console.log(JSON.stringify({
          progress: completed,
          total: rows.length,
          success: successIds.length,
          failed: failures.length
        }));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  let kolSync = { success_count: 0, failed_count: 0 };
  let candidateSync = { success_count: 0, failed_count: 0 };
  if (successIds.length) {
    kolSync = await postJson('/api/sync/feishu/push-kols-bulk', { ids: successIds });
    const candidateRows = await dbOperations.query(
      `SELECT id FROM campaign_kols
       WHERE customer_id IN (${successIds.map(() => '?').join(',')})
         AND project_status IN ('candidate', 'pending_confirmation')`,
      successIds
    );
    if (candidateRows.length) {
      candidateSync = await postJson('/api/sync/feishu/push', {
        scope: 'campaign_kols',
        ids: candidateRows.map((row) => row.id)
      });
    }
  }
  console.log(JSON.stringify({
    done: true,
    attempted: rows.length,
    succeeded: successIds.length,
    failed: failures.length,
    kolSync,
    candidateSync,
    failures
  }, null, 2));
  process.exit(failures.length ? 2 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
