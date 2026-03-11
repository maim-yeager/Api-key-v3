const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../utils/database');
const { COOKIES_DIR } = require('../utils/ytdlp');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.txt') || file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Only .txt cookie files are allowed'));
    }
  },
});

const SUPPORTED_PLATFORMS = ['youtube', 'tiktok', 'facebook', 'instagram'];

/**
 * POST /api/cookies/upload
 * Upload a Netscape-format cookies.txt file for a platform
 * Form data: { platform: string, file: cookies.txt }
 */
router.post('/upload', upload.single('file'), (req, res) => {
  const { platform } = req.body;

  if (!platform) return res.status(400).json({ error: 'platform is required' });
  if (!SUPPORTED_PLATFORMS.includes(platform.toLowerCase())) {
    return res.status(400).json({
      error: 'Invalid platform',
      supported: SUPPORTED_PLATFORMS,
    });
  }
  if (!req.file) return res.status(400).json({ error: 'Cookie file is required' });

  const cookieData = req.file.buffer.toString('utf8');

  // Validate it looks like a Netscape cookie file
  if (!cookieData.includes('# Netscape HTTP Cookie File') &&
      !cookieData.includes('# HTTP Cookie File') &&
      !cookieData.trim().split('\n').some(l => l.split('\t').length >= 7)) {
    return res.status(400).json({
      error: 'Invalid cookie file format. Must be Netscape HTTP Cookie File format.',
    });
  }

  // Save to DB
  const db = getDB();
  db.prepare(`
    INSERT INTO cookies (platform, cookie_data, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(platform) DO UPDATE SET
      cookie_data = excluded.cookie_data,
      updated_at = CURRENT_TIMESTAMP
  `).run(platform.toLowerCase(), cookieData);

  // Also write to file for immediate use
  const cookieFile = path.join(COOKIES_DIR, `${platform.toLowerCase()}.txt`);
  fs.writeFileSync(cookieFile, cookieData, 'utf8');

  res.json({
    success: true,
    message: `Cookies saved for ${platform}`,
    platform: platform.toLowerCase(),
  });
});

/**
 * POST /api/cookies/raw
 * Upload cookies as raw JSON body
 * Body: { platform: string, cookies: string (netscape format) }
 */
router.post('/raw', (req, res) => {
  const { platform, cookies } = req.body;

  if (!platform || !cookies) {
    return res.status(400).json({ error: 'platform and cookies are required' });
  }

  if (!SUPPORTED_PLATFORMS.includes(platform.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid platform', supported: SUPPORTED_PLATFORMS });
  }

  const db = getDB();
  db.prepare(`
    INSERT INTO cookies (platform, cookie_data, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(platform) DO UPDATE SET
      cookie_data = excluded.cookie_data,
      updated_at = CURRENT_TIMESTAMP
  `).run(platform.toLowerCase(), cookies);

  const cookieFile = path.join(COOKIES_DIR, `${platform.toLowerCase()}.txt`);
  fs.writeFileSync(cookieFile, cookies, 'utf8');

  res.json({ success: true, message: `Cookies saved for ${platform}` });
});

/**
 * GET /api/cookies
 * List which platforms have cookies saved
 */
router.get('/', (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT platform, updated_at FROM cookies').all();
  res.json({ success: true, data: rows });
});

/**
 * DELETE /api/cookies/:platform
 * Remove cookies for a platform
 */
router.delete('/:platform', (req, res) => {
  const platform = req.params.platform.toLowerCase();
  const db = getDB();
  db.prepare('DELETE FROM cookies WHERE platform = ?').run(platform);

  const cookieFile = path.join(COOKIES_DIR, `${platform}.txt`);
  if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);

  res.json({ success: true, message: `Cookies removed for ${platform}` });
});

module.exports = router;
