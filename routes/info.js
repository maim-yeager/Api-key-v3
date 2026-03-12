const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');

const execPromise = util.promisify(exec);
const router = express.Router();

// Helper: Check if yt-dlp exists
async function checkYtDlp() {
  try {
    await execPromise('yt-dlp --version');
    return true;
  } catch {
    return false;
  }
}

// Helper: Format bytes to human readable
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '—';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[Math.min(i, 3)];
}

// Helper: Get all formats with proper merging URLs
async function getVideoInfo(url) {
  const hasYtDlp = await checkYtDlp();
  if (!hasYtDlp) {
    throw new Error('yt-dlp not installed on server');
  }

  try {
    // Step 1: Get basic info
    const { stdout: infoStdout } = await execPromise(
      `yt-dlp -J --no-playlist "${url}"`,
      { maxBuffer: 50 * 1024 * 1024 }
    );
    const basicInfo = JSON.parse(infoStdout);

    // Step 2: Get ALL formats with details
    const { stdout: formatsStdout } = await execPromise(
      `yt-dlp -J --no-playlist --list-formats "${url}"`,
      { maxBuffer: 50 * 1024 * 1024 }
    );
    const formatsData = JSON.parse(formatsStdout);

    // Step 3: Process EACH format (PROBLEM 2 FIXED - ALL formats included)
    const formats = (formatsData.formats || []).map(f => {
      // Calculate filesize if missing
      let filesize = f.filesize || f.filesize_approx;
      if (!filesize && f.tbr && basicInfo.duration) {
        filesize = Math.round((f.tbr * 1000 / 8) * basicInfo.duration);
      }

      // Determine format type
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';
      const isVideoOnly = hasVideo && !hasAudio;
      const isAudioOnly = !hasVideo && hasAudio;

      // Create download URL
      let downloadUrl = f.url;

      // For video-only formats: create merged URL (PROBLEM 1 FIXED)
      if (isVideoOnly) {
        // Find best matching audio format
        const bestAudio = formatsData.formats.find(af => 
          af.acodec && af.acodec !== 'none' && 
          af.vcodec === 'none' && 
          (af.ext === 'm4a' || af.ext === 'webm' || af.ext === 'mp4')
        );

        if (bestAudio) {
          // Generate merge token
          const token = crypto.randomBytes(16).toString('hex');
          downloadUrl = `/api/download/merge?video_id=${f.format_id}&audio_id=${bestAudio.format_id}&url=${encodeURIComponent(url)}&token=${token}`;
        }
      }

      // Quality label
      let quality = '—';
      if (f.height) {
        quality = f.height + 'p';
      } else if (f.format_note) {
        quality = f.format_note;
      } else if (isAudioOnly) {
        quality = f.abr ? f.abr + 'kbps' : 'Audio';
      }

      return {
        format_id: f.format_id,
        ext: f.ext,
        quality: quality,
        filesize: filesize,
        filesize_str: formatBytes(filesize),
        has_video: hasVideo,
        has_audio: hasAudio,
        is_video_only: isVideoOnly,
        is_audio_only: isAudioOnly,
        width: f.width,
        height: f.height,
        fps: f.fps,
        vcodec: f.vcodec,
        acodec: f.acodec,
        tbr: f.tbr,
        vbr: f.vbr,
        abr: f.abr,
        url: downloadUrl,
        // Hide DASH audio from UI (PROBLEM 6 FIXED)
        hide_from_ui: isAudioOnly && f.format_note?.includes('DASH') ? true : false
      };
    }).filter(f => f.url); // Only include formats with URLs

    // Find best play URL for preview (PROBLEM 5 FIXED)
    const bestPlayFormat = formats.find(f => 
      f.height >= 720 && f.has_video && f.has_audio && f.ext === 'mp4'
    ) || formats.find(f => f.has_video && f.has_audio) || formats[0];

    return {
      title: basicInfo.title || basicInfo.fulltitle || 'Untitled',
      thumbnail: basicInfo.thumbnail || '',
      duration: basicInfo.duration || 0,
      duration_str: formatDuration(basicInfo.duration),
      uploader: basicInfo.uploader || basicInfo.channel || basicInfo.uploader_id || 'Unknown',
      view_count: basicInfo.view_count || 0,
      like_count: basicInfo.like_count || 0,
      upload_date: basicInfo.upload_date || null,
      description: basicInfo.description || '',
      formats: formats,
      play_url: bestPlayFormat?.url || '',
      subtitles: basicInfo.subtitles || {},
      automatic_captions: basicInfo.automatic_captions || {},
      webpage_url: basicInfo.webpage_url || url,
      extractor: basicInfo.extractor || basicInfo.extractor_key || 'Unknown'
    };
  } catch (error) {
    console.error('yt-dlp error:', error);
    throw new Error('Failed to fetch video info: ' + error.message);
  }
}

// Helper: Format duration
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// ─── POST /api/info ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL is required' 
    });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid URL format' 
    });
  }

  try {
    console.log(`[info] Fetching: ${url}`);
    const info = await getVideoInfo(url);

    res.json({
      success: true,
      data: info
    });
  } catch (error) {
    console.error('[info error]', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch video information'
    });
  }
});

// ─── OPTIONS for CORS ─────────────────────────────────────────────────────────
router.options('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.sendStatus(200);
});

module.exports = router;
