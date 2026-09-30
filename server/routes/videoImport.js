const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { HEADERS, readImportFile, previewImport, saveImportRow } = require('../services/videoImport');

module.exports = function createVideoImportRouter({ dbOperations, sequelize }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  router.get('/template', (req, res) => {
    const workbook = xlsx.utils.book_new();
    const sheet = xlsx.utils.aoa_to_sheet([HEADERS]);
    sheet['!cols'] = [{ wch: 65 }, { wch: 28 }, { wch: 22 }, { wch: 24 }, { wch: 45 }];
    xlsx.utils.book_append_sheet(workbook, sheet, '导入模板');
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([
      ['填写说明'], ['仅视频链接必填，每行一条，每批最多 500 行，仅读取第一个工作表。'],
      ['合作报价示例：USD 500、500美元、3000元；只填数字时使用弹窗中的默认币种。'],
      ['标题和平台由抓取补充；达人名称只作记录，不绑定系统达人。'],
      ['所属项目填写系统中的项目名称；留空使用弹窗默认项目，两处都留空则不关联项目。'],
      ['项目不存在或重名时，请在预览中手动选择；不会自动新建项目。'],
      ['同一链接可关联多个项目；同一链接与同一项目的重复行跳过。'],
      ['已有视频默认保留信息，仅补充缺少的项目关联；选择更新时覆盖非空报价、达人名称和备注。']
    ]), '填写说明');
    res.setHeader('Content-Disposition', 'attachment; filename="video-import-template.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  });
  router.post('/preview', upload.single('file'), async (req, res, next) => {
    try { res.json({ success: true, data: await previewImport(readImportFile(req.file), req.body, dbOperations) }); }
    catch (error) { next(error); }
  });
  router.post('/validate', async (req, res, next) => {
    try { res.json({ success: true, data: await previewImport(req.body.rows, req.body, dbOperations) }); }
    catch (error) { next(error); }
  });
  router.post('/confirm', async (req, res, next) => {
    try {
      // Revalidate on submission, including duplicates that appeared after preview.
      const preview = await previewImport(req.body.rows, req.body, dbOperations);
      const options = { ...req.body, campaign_id: preview.campaign_id };
      const result = { imported: 0, linked: 0, updated: 0, skipped: 0, failed: 0, ids: [], rows: [] };
      for (const row of preview.rows) {
        let outcome;
        if (row.status === 'invalid') outcome = { status: 'failed', reason: row.reason };
        else if (row.status === 'skip') outcome = { status: 'skipped', reason: row.reason };
        else {
          try {
            outcome = await saveImportRow(row, options, sequelize);
            if (outcome.status === 'skip') outcome.status = 'skipped';
          } catch (error) { outcome = { status: 'failed', reason: '保存失败，请重试；如持续失败请联系管理员' }; }
        }
        result[outcome.status] += 1;
        if (['imported', 'updated', 'linked'].includes(outcome.status) && !result.ids.includes(outcome.id)) result.ids.push(outcome.id);
        result.rows.push({ ...row, ...outcome });
      }
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  });
  router.use((error, req, res, next) => res.status(400).json({ success: false, error: error.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 5 MB' : error.message }));
  return router;
};
