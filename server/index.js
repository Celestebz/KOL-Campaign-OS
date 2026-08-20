const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { initDatabase } = require('./database');
const { createAuthRouter, authGuard } = require('./middleware/auth');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

const customerRoutes = require('./routes/customers');
const promptTemplateRoutes = require('./routes/promptTemplates');
const settingsRoutes = require('./routes/settings');
const groupRoutes = require('./routes/groups');
const videoRoutes = require('./routes/videos');
const campaignRoutes = require('./routes/campaigns');
const productRoutes = require('./routes/products');
const rawCandidateRoutes = require('./routes/rawCandidates');
const campaignKolRoutes = require('./routes/campaignKols');
const syncRoutes = require('./routes/sync');
const feishuSheetSyncRoutes = require('./routes/feishuSheetSync');
const kolStrategyRoutes = require('./routes/kolStrategies');
const finderTaskRoutes = require('./routes/finderTasks');
const agentRoutes = require('./routes/agent');
const finderSubtaskRoutes = require('./routes/finderSubtasks');
const emailRoutes = require('./routes/emails');
const workbenchRoutes = require('./routes/workbench');
const approvalRoutes = require('./routes/approvals');
const automationRunRoutes = require('./routes/automationRuns');
const { startEmailSync } = require('./services/emailLiveSync');
const { startFollowUpTimer } = require('./services/emailFollowUp');

const app = express();
const PORT = process.env.PORT || 5001;

const getDataDir = () => {
  if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
  return path.join(__dirname, '..', 'data');
};

const dataDir = getDataDir();
const uploadsDir = path.join(dataDir, 'uploads');
const imagesDir = path.join(uploadsDir, 'images');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth', createAuthRouter());
app.use(authGuard);

app.use('/uploads', express.static(uploadsDir));

app.locals.uploadsDir = uploadsDir;

app.use('/api/customers', customerRoutes);
app.use('/api/prompt-templates', promptTemplateRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/products', productRoutes);
app.use('/api/raw-candidates', rawCandidateRoutes.router);
app.use('/api/campaign-kols', campaignKolRoutes);
app.use('/api/sync/feishu-sheet', feishuSheetSyncRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/kol-strategies', kolStrategyRoutes);
app.use('/api/finder-tasks', finderTaskRoutes);
app.use('/api/finder-subtasks', finderSubtaskRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/workbench', workbenchRoutes);
app.use('/api/approvals', approvalRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'KOL Campaign OS service is running' });
});

const getClientBuildPath = () => {
  if (process.pkg) return path.resolve(path.dirname(process.execPath), 'client_build');
  return path.join(__dirname, '..', 'client', 'build');
};

const clientBuildPath = getClientBuildPath();
console.log(`Client build path: ${clientBuildPath}`);

if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
} else {
  app.get('*', (req, res) => {
    res.status(404).json({
      error: 'Frontend build not found',
      message: `Client build path: ${clientBuildPath}`,
      tip: 'Run npm run build for production, or npm run dev for local development.'
    });
  });
}

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Server error',
    message: err.message
  });
});

async function startServer() {
  try {
    if (!process.env.SESSION_SECRET && !process.env.APP_ACCESS_PASSWORD && process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set in production');
    }
    await initDatabase();
    // 测试环境（NODE_ENV=test）不启动真实 IMAP 轮询与跟进定时器
    if (process.env.NODE_ENV !== 'test') {
      // 阶段 D 任务失败恢复：遗留 running 的后台任务/ Finder 任务标记为“服务重启中断”，
      // 工作台异常队列可见，retry 从 checkpoint 断点续跑
      const automationRuns = require('./services/automationRuns');
      const interruptedRuns = await automationRuns.resumeInterruptedRuns();
      const interruptedFinderTasks = await finderTaskRoutes.markInterruptedFinderTasks();
      if (interruptedRuns || interruptedFinderTasks) {
        console.log(`[recovery] 服务重启中断标记：automation_runs ${interruptedRuns} 条，finder_tasks ${interruptedFinderTasks} 条`);
      }
      await startEmailSync();
      startFollowUpTimer();
    }
    app.listen(PORT, () => {
      console.log(`KOL Campaign OS server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start KOL Campaign OS server:', error);
    process.exit(1);
  }
}

startServer();
