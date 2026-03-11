require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./utils/database');

const infoRoutes = require('./routes/info');
const downloadRoutes = require('./routes/download');
const historyRoutes = require('./routes/history');
const cookieRoutes = require('./routes/cookies');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(morgan('combined'));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.RATE_LIMIT || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─── Optional API Key Auth ────────────────────────────────────────────────────
app.use('/api/', (req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next(); // No key set = open access
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== apiKey) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/info', infoRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/cookies', cookieRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'Video Downloader API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      info:     'POST /api/info       - Get video info & available formats',
      download: 'POST /api/download   - Download video/audio',
      history:  'GET  /api/history    - Download history',
      cookies:  'POST /api/cookies    - Upload cookies for private videos',
    },
    supported_platforms: ['YouTube', 'TikTok', 'Facebook', 'Instagram', '1000+ more via yt-dlp'],
  });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Video DL API running on port ${PORT}`);
});

module.exports = app;
