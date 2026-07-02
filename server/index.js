const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const customerRoutes = require('./routes/customers');
const promptTemplateRoutes = require('./routes/promptTemplates');
const settingsRoutes = require('./routes/settings');
const groupRoutes = require('./routes/groups');
const videoRoutes = require('./routes/videos');
const campaignRoutes = require('./routes/campaigns');
const rawCandidateRoutes = require('./routes/rawCandidates');
const campaignKolRoutes = require('./routes/campaignKols');
const syncRoutes = require('./routes/sync');
const kolStrategyRoutes = require('./routes/kolStrategies');
const finderTaskRoutes = require('./routes/finderTasks');

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
app.use('/uploads', express.static(uploadsDir));

app.locals.uploadsDir = uploadsDir;

app.use('/api/customers', customerRoutes);
app.use('/api/prompt-templates', promptTemplateRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/raw-candidates', rawCandidateRoutes);
app.use('/api/campaign-kols', campaignKolRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/kol-strategies', kolStrategyRoutes);
app.use('/api/finder-tasks', finderTaskRoutes);

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

app.listen(PORT, () => {
  console.log(`KOL Campaign OS server is running on http://localhost:${PORT}`);
});
