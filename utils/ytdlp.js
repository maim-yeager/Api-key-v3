const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDB } = require('./database');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '..', 'downloads');
const COOKIES_DIR  = path.join(__dirname, '..', 'cookies');
const TEMP_DIR     = path.join(__dirname, '..', 'temp');

// Ensure dirs exist
[DOWNLOAD_DIR, COOKIES_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Clean temp files older than 1 hour
setInterval(() => {
  const now = Date.now();
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > 3600000) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 3600000);

// ─── Helper: Format bytes ───────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '—';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[Math.min(i, 3)];
}

// ─── Helper: Format duration ────────────────────────────────────────────────
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

// ─── Detect yt-dlp binary ────────────────────────────────────────────────────
function getYtDlpBin() {
  const custom = process.env.YTDLP_PATH;
  if (custom && fs.existsSync(custom)) return custom;
  return 'yt-dlp'; // assume in PATH
}

// ─── Get cookie file for platform ────────────────────────────────────────────
// Priority: 1) Fly.io env secret  2) DB  3) local file
function getCookieFile(platform) {
  if (!platform) return null;
  const p = platform.toLowerCase();
  const cookieFile = path.join(COOKIES_DIR, `${p}.txt`);

  // 1. Check environment variable (Fly.io Secrets via GitHub Actions)
  const envKey = `${p.toUpperCase()}_COOKIES`;
  const envCookies = process.env[envKey];
  if (envCookies && envCookies.trim()) {
    // Write to file so yt-dlp can use it
    fs.writeFileSync(cookieFile, envCookies, 'utf8');
    return cookieFile;
  }

  // 2. Check already-written local file
  if (fs.existsSync(cookieFile)) return cookieFile;

  // 3. Check DB (uploaded via API)
  try {
    const db = getDB();
    const row = db.prepare('SELECT cookie_data FROM cookies WHERE platform = ?').get(p);
    if (row) {
      fs.writeFileSync(cookieFile, row.cookie_data, 'utf8');
      return cookieFile;
    }
  } catch (_) {}

  return null;
}

// ─── Detect platform from URL ────────────────────────────────────────────────
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url))  return 'youtube';
  if (/tiktok\.com/.test(url))             return 'tiktok';
  if (/facebook\.com|fb\.watch/.test(url)) return 'facebook';
  if (/instagram\.com/.test(url))          return 'instagram';
  return 'other';
}

// ─── Run yt-dlp and return parsed JSON ───────────────────────────────────────
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpBin();
    const proc = spawn(bin, args, { maxBuffer: 50 * 1024 * 1024 });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      resolve(stdout.trim());
    });

    proc.on('error', err => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}. Make sure yt-dlp is installed.`));
    });
  });
}

// ─── Get ALL formats with filesize (PROBLEM 2 FIXED) ─────────────────────────
async function getAllFormats(url, cookieFile) {
  const args = [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--list-formats'  // This gives ALL formats
  ];

  if (cookieFile) {
    args.push('--cookies', cookieFile);
  }

  args.push(url);

  const raw = await runYtDlp(args);
  const data = JSON.parse(raw);
  
  return data.formats || [];
}

// ─── PROCESS EACH FORMAT (PROBLEM 1, 5, 6 FIXED) ────────────────────────────
function processFormats(formats, videoUrl, duration) {
  const processed = [];
  const audioFormats = formats.filter(f => 
    f.acodec && f.acodec !== 'none' && 
    (!f.vcodec || f.vcodec === 'none')
  );

  formats.forEach(f => {
    // Calculate filesize if missing
    let filesize = f.filesize || f.filesize_approx;
    if (!filesize && f.tbr && duration) {
      filesize = Math.round((f.tbr * 1000 / 8) * duration);
    }

    // Determine format type
    const hasVideo = f.vcodec && f.vcodec !== 'none';
    const hasAudio = f.acodec && f.acodec !== 'none';
    const isVideoOnly = hasVideo && !hasAudio;
    const isAudioOnly = !hasVideo && hasAudio;
    const isDASHAudio = isAudioOnly && f.format_note?.includes('DASH');

    // Quality label
    let quality = '—';
    if (f.height) {
      quality = f.height + 'p';
    } else if (f.format_note) {
      quality = f.format_note;
    } else if (isAudioOnly) {
      quality = f.abr ? f.abr + 'kbps' : 'Audio';
    }

    // Create download URL
    let downloadUrl = f.url;

    // For video-only formats: create merged URL (PROBLEM 1 FIXED)
    if (isVideoOnly) {
      // Find best matching audio format
      const bestAudio = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
      
      if (bestAudio) {
        // Generate merge token
        const token = crypto.randomBytes(16).toString('hex');
        downloadUrl = `/api/download/merge?video_id=${f.format_id}&audio_id=${bestAudio.format_id}&url=${encodeURIComponent(videoUrl)}&token=${token}`;
      }
    }

    // Add to processed list (PROBLEM 2 FIXED - ALL formats included)
    processed.push({
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
      format_note: f.format_note,
      url: downloadUrl,
      // Hide DASH audio from UI (PROBLEM 6 FIXED)
      hide_from_ui: isDASHAudio ? true : false
    });
  });

  return processed;
}

// ─── VIDEO INFO (PROBLEM 2, 5, 6 FIXED) ─────────────────────────────────────
async function getVideoInfo(url, useCookies = true) {
  const platform = detectPlatform(url);
  const cookieFile = useCookies ? getCookieFile(platform) : null;

  // Get basic info first
  const args = [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
  ];

  if (cookieFile) {
    args.push('--cookies', cookieFile);
  }

  args.push(url);

  const raw = await runYtDlp(args);
  const info = JSON.parse(raw);

  // Get ALL formats separately (to ensure we have everything)
  const allFormats = await getAllFormats(url, cookieFile);

  // Process formats with our enhanced logic
  const processedFormats = processFormats(allFormats, url, info.duration);

  // Find best play URL for preview (PROBLEM 5 FIXED)
  const bestPlayFormat = processedFormats.find(f => 
    f.height >= 720 && f.has_video && f.has_audio && f.ext === 'mp4'
  ) || processedFormats.find(f => f.has_video && f.has_audio) || processedFormats[0];

  // Extract only the fields we need for response
  return extractVideoInfo(info, processedFormats, bestPlayFormat?.url);
}

// ─── Extract only the fields we need ─────────────────────────────────────────
function extractVideoInfo(info, processedFormats, playUrl) {
  // Group subtitles
  const subtitles = {};
  if (info.subtitles) {
    for (const [lang, subs] of Object.entries(info.subtitles)) {
      subtitles[lang] = subs.map(s => ({ ext: s.ext, url: s.url, name: s.name }));
    }
  }

  return {
    // ── Identifiers ──
    id:                  info.id,
    display_id:          info.display_id,

    // ── Titles & Description ──
    title:               info.title,
    fulltitle:           info.fulltitle,
    alt_title:           info.alt_title,
    description:         info.description,

    // ── Media Info ──
    ext:                 info.ext,
    duration:            info.duration,
    duration_string:     formatDuration(info.duration),
    thumbnail:           info.thumbnail,
    thumbnails:          (info.thumbnails || []).slice(-5), // last 5 (best quality)

    // ── Uploader / Channel ──
    uploader:            info.uploader,
    uploader_url:        info.uploader_url,
    uploader_id:         info.uploader_id,
    channel:             info.channel,
    channel_id:          info.channel_id,
    channel_url:         info.channel_url,
    channel_follower_count: info.channel_follower_count,
    creators:            info.creators,
    creator:             info.creator,
    license:             info.license,

    // ── Dates & Timestamps ──
    timestamp:           info.timestamp,
    upload_date:         info.upload_date,
    release_timestamp:   info.release_timestamp,
    release_date:        info.release_date,
    release_year:        info.release_year,
    modified_timestamp:  info.modified_timestamp,
    modified_date:       info.modified_date,

    // ── Stats ──
    view_count:          info.view_count,
    like_count:          info.like_count,
    comment_count:       info.comment_count,
    repost_count:        info.repost_count,

    // ── Timing ──
    start_time:          info.start_time,
    end_time:            info.end_time,

    // ── Platform ──
    platform:            detectPlatform(info.webpage_url || ''),
    webpage_url:         info.webpage_url,
    webpage_url_domain:  info.webpage_url_domain,
    age_limit:           info.age_limit,
    is_live:             info.is_live,
    was_live:            info.was_live,
    live_status:         info.live_status,

    // ── Categories / Tags ──
    categories:          info.categories,
    tags:                info.tags,

    // ── Formats & Subtitles (PROBLEM 2 FIXED) ──
    formats:             processedFormats,
    subtitles,
    automatic_captions:  info.automatic_captions ? Object.keys(info.automatic_captions) : [],

    // ── Play URL for preview (PROBLEM 5 FIXED) ──
    play_url:            playUrl,

    // ── Suggested download options ──
    suggested_formats: suggestFormats(processedFormats),
  };
}

// ─── Suggest best formats per type ───────────────────────────────────────────
function suggestFormats(formats) {
  const videoFormats = formats.filter(f => f.has_video && f.has_audio);
  const audioFormats = formats.filter(f => f.has_audio && !f.has_video);

  const best1080 = videoFormats.find(f => f.height === 1080);
  const best720  = videoFormats.find(f => f.height === 720);
  const best480  = videoFormats.find(f => f.height === 480);
  const bestAudio = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

  return {
    '1080p': best1080?.format_id,
    '720p':  best720?.format_id,
    '480p':  best480?.format_id,
    'best':  videoFormats[0]?.format_id,
    'audio': bestAudio?.format_id,
  };
}

// ─── DOWNLOAD VIDEO (PROBLEM 1, 3, 4 FIXED) ───────────────────────────────────
async function downloadVideo(url, options = {}) {
  const {
    format    = 'bestvideo+bestaudio/best',
    outputExt = 'mp4',   // mp4 | mp3 | mkv | webm
    audioOnly = false,
    subtitles = true,
    historyId,
    directStream = false, // If true, return file path for streaming
  } = options;

  const platform   = detectPlatform(url);
  const cookieFile = getCookieFile(platform);

  // For direct streaming, use temp directory
  const targetDir = directStream ? TEMP_DIR : DOWNLOAD_DIR;
  const fileId = historyId || `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const outputTemplate = path.join(targetDir, `${fileId}.%(ext)s`);

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-write-thumbnail',
    '--print-json',          // print final JSON after download
    '-o', outputTemplate,
  ];

  // ── Format Selection (PROBLEM 1 FIXED - merging enabled) ──
  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', format);
    if (outputExt === 'mp4') {
      args.push('--merge-output-format', 'mp4');
    } else if (outputExt === 'mkv') {
      args.push('--merge-output-format', 'mkv');
    }
  }

  // ── Subtitles ──
  if (subtitles) {
    args.push('--write-subs', '--write-auto-subs', '--sub-format', 'srt/vtt/best');
  }

  // ── Cookies ──
  if (cookieFile) args.push('--cookies', cookieFile);

  // ── Embed metadata ──
  args.push('--embed-metadata');

  args.push(url);

  const raw = await runYtDlp(args);

  // yt-dlp prints JSON per fragment — take last complete JSON line
  const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
  const lastJson = lines[lines.length - 1];
  const info = JSON.parse(lastJson);

  // Find downloaded file
  const downloadedFile = path.join(
    targetDir,
    `${fileId}.${audioOnly ? 'mp3' : outputExt}`
  );

  return {
    file: fs.existsSync(downloadedFile) ? downloadedFile : null,
    fileId: fileId,
    info: extractVideoInfo(info, [], null),
    subtitleFiles: getSubtitleFiles(fileId),
  };
}

// ─── AUDIO ONLY EXTRACTION (PROBLEM 3 FIXED) ─────────────────────────────────
async function extractAudio(url, options = {}) {
  const {
    quality = '192',
    historyId,
    directStream = true
  } = options;

  return downloadVideo(url, {
    audioOnly: true,
    outputExt: 'mp3',
    format: 'bestaudio/best',
    historyId,
    directStream
  });
}

// ─── MERGE VIDEO + AUDIO (PROBLEM 1 FIXED) ───────────────────────────────────
async function mergeFormats(url, videoId, audioId, options = {}) {
  const format = `${videoId}+${audioId}`;
  return downloadVideo(url, {
    format: format,
    outputExt: 'mp4',
    directStream: true,
    ...options
  });
}

function getSubtitleFiles(id) {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.startsWith(id) && (f.endsWith('.srt') || f.endsWith('.vtt')))
    .map(f => ({ filename: f, path: path.join(DOWNLOAD_DIR, f) }));
}

module.exports = {
  getVideoInfo,
  downloadVideo,
  extractAudio,
  mergeFormats,
  detectPlatform,
  DOWNLOAD_DIR,
  COOKIES_DIR,
  TEMP_DIR,
  formatBytes,
  formatDuration
};
