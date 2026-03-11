const express = require('express');
const router = express.Router();
const { getVideoInfo } = require('../utils/ytdlp');

/**
 * POST /api/info
 * Body: { url: string, use_cookies?: boolean }
 *
 * Returns full video info including:
 * - All metadata fields
 * - Available formats (video+audio, video-only, audio-only)
 * - Subtitles list
 * - Thumbnail URL for preview
 * - Suggested format IDs for 1080p/720p/480p/audio
 */
router.post('/', async (req, res) => {
  const { url, use_cookies = true } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  try {
    const info = await getVideoInfo(url, use_cookies);
    return res.json({ success: true, data: info });
  } catch (err) {
    console.error('Info error:', err.message);
    return res.status(500).json({
      error: 'Failed to fetch video info',
      message: err.message,
    });
  }
});

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

module.exports = router;
