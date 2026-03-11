const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getDB } = require('./database');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '..', 'downloads');
const COOKIES_DIR  = path.join(__dirname, '..', 'cookies');

// Ensure dirs exist
[DOWNLOAD_DIR, COOKIES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

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

// ─── VIDEO INFO ───────────────────────────────────────────────────────────────
async function getVideoInfo(url, useCookies = true) {
  const platform = detectPlatform(url);
  const cookieFile = useCookies ? getCookieFile(platform) : null;

  const args = [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--no-write-thumbnail',  // don't write file, we get URL from metadata
  ];

  if (cookieFile) {
    args.push('--cookies', cookieFile);
  }

  args.push(url);

  const raw = await runYtDlp(args);
  const info = JSON.parse(raw);

  return extractVideoInfo(info);
}

// ─── Extract only the fields we need ─────────────────────────────────────────
function extractVideoInfo(info) {
  const formats = (info.formats || []).map(f => ({
    format_id:   f.format_id,
    format_note: f.format_note,
    ext:         f.ext,
    resolution:  f.resolution || (f.width && f.height ? `${f.width}x${f.height}` : null),
    width:       f.width,
    height:      f.height,
    fps:         f.fps,
    vcodec:      f.vcodec,
    acodec:      f.acodec,
    filesize:    f.filesize || f.filesize_approx,
    tbr:         f.tbr,
    abr:         f.abr,
    vbr:         f.vbr,
    has_video:   f.vcodec && f.vcodec !== 'none',
    has_audio:   f.acodec && f.acodec !== 'none',
    url:         f.url, // direct stream URL for preview
    protocol:    f.protocol,
  }));

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
    duration_string:     info.duration_string,
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

    // ── Formats & Subtitles ──
    formats,
    subtitles,
    automatic_captions:  info.automatic_captions ? Object.keys(info.automatic_captions) : [],

    // ── Suggested download options ──
    suggested_formats: suggestFormats(formats),
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
    'best':  videoFormats[videoFormats.length - 1]?.format_id,
    'audio': bestAudio?.format_id,
  };
}

// ─── DOWNLOAD VIDEO ───────────────────────────────────────────────────────────
async function downloadVideo(url, options = {}) {
  const {
    format    = 'bestvideo+bestaudio/best',
    outputExt = 'mp4',   // mp4 | mp3 | mkv | webm
    audioOnly = false,
    subtitles = true,
    historyId,
  } = options;

  const platform   = detectPlatform(url);
  const cookieFile = getCookieFile(platform);

  const outputTemplate = path.join(DOWNLOAD_DIR, `${historyId || '%(id)s'}.%(ext)s`);

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-write-thumbnail',
    '--print-json',          // print final JSON after download
    '-o', outputTemplate,
  ];

  // ── Format Selection ──
  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', format);
    if (outputExt === 'mp4') {
      args.push('--merge-output-format', 'mp4',
                '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac');
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
    DOWNLOAD_DIR,
    `${historyId || info.id}.${audioOnly ? 'mp3' : outputExt}`
  );

  return {
    file: fs.existsSync(downloadedFile) ? downloadedFile : null,
    info: extractVideoInfo(info),
    subtitleFiles: getSubtitleFiles(historyId || info.id),
  };
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
  detectPlatform,
  DOWNLOAD_DIR,
  COOKIES_DIR,
};
