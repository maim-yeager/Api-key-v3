const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { downloadVideo, getVideoInfo, detectPlatform, DOWNLOAD_DIR } = require('../utils/ytdlp');
const { getDB } = require('../utils/database');

// ─── Valid output extensions ──────────────────────────────────────────────────
const VALID_VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'avi', 'mov'];
const VALID_AUDIO_EXTS = ['mp3', 'm4a', 'opus', 'wav', 'flac', 'aac'];

/**
 * POST /api/download
 *
 * Body:
 * {
 *   url:        string  (required)
 *   type:       'video' | 'audio'          (default: 'video')
 *   format:     'mp4' | 'mkv' | 'mp3' ... (default: 'mp4')
 *   quality:    'best' | '1080p' | '720p' | '480p' | '360p' | format_id
 *   subtitles:  boolean (default: true)
 *   use_cookies: boolean (default: true)
 * }
 *
 * Returns:
 * - If file is small enough: streams the file directly
 * - Otherwise: returns download URL
 */
router.post('/', async (req, res) => {
  const {
    url,
    type       = 'video',
    format     = type === 'audio' ? 'mp3' : 'mp4',
    quality    = 'best',
    subtitles  = true,
    use_cookies = true,
  } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL' });

  const audioOnly = type === 'audio' || VALID_AUDIO_EXTS.includes(format);
  const outputExt = audioOnly ? (VALID_AUDIO_EXTS.includes(format) ? format : 'mp3')
                              : (VALID_VIDEO_EXTS.includes(format) ? format : 'mp4');

  // Build yt-dlp format selector
  let formatSelector;
  if (audioOnly) {
    formatSelector = 'bestaudio/best';
  } else {
    const heightMap = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
    const h = heightMap[quality];
    if (h) {
      formatSelector = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
    } else if (quality !== 'best' && /^\d+$/.test(quality)) {
      // Raw format_id passed
      formatSelector = quality;
    } else {
      formatSelector = 'bestvideo+bestaudio/best';
    }
  }

  const historyId = uuidv4();
  const db = getDB();
  const platform = detectPlatform(url);

  // Insert pending record
  db.prepare(`
    INSERT INTO download_history (id, url, platform, format_type, quality, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(historyId, url, platform, outputExt, quality);

  try {
    const result = await downloadVideo(url, {
      format: formatSelector,
      outputExt,
      audioOnly,
      subtitles: subtitles && !audioOnly,
      historyId,
      useCookies: use_cookies,
    });

    // Update history record
    db.prepare(`
      UPDATE download_history SET
        title = ?, status = 'completed', file_size = ?,
        duration = ?, thumbnail = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      result.info.title,
      getFileSize(result.file),
      result.info.duration,
      result.info.thumbnail,
      historyId,
    );

    // Build subtitle download links
    const subtitleLinks = result.subtitleFiles.map(sf => ({
      filename: sf.filename,
      download_url: `/api/download/file/${historyId}/${sf.filename}`,
    }));

    // If file exists, provide direct stream option + download URL
    if (result.file && fs.existsSync(result.file)) {
      const filename = path.basename(result.file);
      return res.json({
        success: true,
        history_id: historyId,
        title: result.info.title,
        thumbnail: result.info.thumbnail,
        duration: result.info.duration,
        filesize: getFileSize(result.file),
        format: outputExt,
        quality,
        download_url: `/api/download/file/${historyId}/${filename}`,
        subtitle_files: subtitleLinks,
        info: result.info,
      });
    }

    return res.json({ success: true, history_id: historyId, info: result.info });

  } catch (err) {
    console.error('Download error:', err.message);
    db.prepare(`UPDATE download_history SET status = 'failed', error = ? WHERE id = ?`)
      .run(err.message, historyId);

    return res.status(500).json({
      error: 'Download failed',
      message: err.message,
      history_id: historyId,
    });
  }
});

/**
 * GET /api/download/file/:historyId/:filename
 * Streams or serves a downloaded file
 */
router.get('/file/:historyId/:filename', (req, res) => {
  const { historyId, filename } = req.params;

  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(DOWNLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(filename).toLowerCase().slice(1);
  const mimeTypes = {
    mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', opus: 'audio/ogg',
    wav: 'audio/wav',  flac: 'audio/flac',
    srt: 'text/plain', vtt: 'text/vtt',
  };

  const mime = mimeTypes[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);

  // Support range requests (for video preview/streaming)
  const range = req.headers.range;
  if (range && mime.startsWith('video/')) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
      'Content-Type':   mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
  }
});

/**
 * DELETE /api/download/file/:filename
 * Delete a downloaded file
 */
router.delete('/file/:filename', (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(DOWNLOAD_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true, message: 'File deleted' });
});

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function getFileSize(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.statSync(filePath).size;
}

module.exports = router;
