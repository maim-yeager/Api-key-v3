const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');

const execPromise = util.promisify(exec);
const router = express.Router();

// Temp directory for downloads
const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

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

// Helper: Check if yt-dlp and ffmpeg exist
async function checkDependencies() {
  try {
    await execPromise('yt-dlp --version');
    await execPromise('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

// ─── POST /api/download - Download specific format (PROBLEM 4 FIXED) ──────────
router.post('/', async (req, res) => {
  const { url, format_id, type = 'video' } = req.body;

  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL is required' 
    });
  }

  const depsOk = await checkDependencies();
  if (!depsOk) {
    return res.status(500).json({ 
      success: false, 
      error: 'yt-dlp or ffmpeg not installed on server' 
    });
  }

  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const outputFile = path.join(TEMP_DIR, `download_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`);

  try {
    console.log(`[download] Processing: ${url} (format: ${format_id || 'best'})`);

    let command;
    
    if (type === 'audio') {
      // Audio extraction (PROBLEM 3 FIXED)
      command = `yt-dlp -x --audio-format mp3 --audio-quality 192k -o "${outputFile}" "${url}"`;
    } else if (format_id) {
      // Specific video format with best audio merged (PROBLEM 1 FIXED)
      command = `yt-dlp -f "${format_id}+bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio" --merge-output-format mp4 -o "${outputFile}" "${url}"`;
    } else {
      // Best quality
      command = `yt-dlp -f "bestvideo+bestaudio" --merge-output-format mp4 -o "${outputFile}" "${url}"`;
    }

    // Execute download with timeout (10 minutes)
    await execPromise(command, { 
      maxBuffer: 500 * 1024 * 1024, 
      timeout: 600000 
    });

    if (!fs.existsSync(outputFile)) {
      throw new Error('Download failed - no output file generated');
    }

    const stat = fs.statSync(outputFile);

    // Set headers for direct download (NO REDIRECT)
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="download.${ext}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

    // Stream file directly
    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);

    // Clean up after streaming
    stream.on('end', () => {
      fs.unlink(outputFile, () => {});
    });

    stream.on('error', (err) => {
      console.error('[download stream error]', err);
      fs.unlink(outputFile, () => {});
      if (!res.headersSent) {
        res.status(500).json({ 
          success: false, 
          error: 'Streaming failed' 
        });
      }
    });

  } catch (error) {
    // Clean up temp file on error
    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }

    console.error('[download error]', error.message);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Download failed' 
      });
    }
  }
});

// ─── GET /api/download/merge - Stream merged video (for video-only formats) ───
router.get('/merge', async (req, res) => {
  const { video_id, audio_id, url } = req.query;

  if (!url || !video_id) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL and video_id are required' 
    });
  }

  const depsOk = await checkDependencies();
  if (!depsOk) {
    return res.status(500).json({ 
      success: false, 
      error: 'yt-dlp or ffmpeg not installed' 
    });
  }

  const outputFile = path.join(TEMP_DIR, `merge_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp4`);

  try {
    console.log(`[merge] Merging video ${video_id} + audio for: ${url}`);

    let command;
    if (audio_id) {
      // Specific video + audio format
      command = `yt-dlp -f "${video_id}+${audio_id}" --merge-output-format mp4 -o "${outputFile}" "${url}"`;
    } else {
      // Video + best audio
      command = `yt-dlp -f "${video_id}+bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio" --merge-output-format mp4 -o "${outputFile}" "${url}"`;
    }

    await execPromise(command, { 
      maxBuffer: 500 * 1024 * 1024, 
      timeout: 600000 
    });

    if (!fs.existsSync(outputFile)) {
      throw new Error('Merge failed - no output file');
    }

    const stat = fs.statSync(outputFile);

    // Headers for streaming (supports seeking)
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Accept-Ranges');

    // Handle range requests for video seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;

      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunksize);
      res.status(206);

      const stream = fs.createReadStream(outputFile, { start, end });
      stream.pipe(res);

      stream.on('end', () => {
        fs.unlink(outputFile, () => {});
      });
    } else {
      const stream = fs.createReadStream(outputFile);
      stream.pipe(res);

      stream.on('end', () => {
        fs.unlink(outputFile, () => {});
      });
    }

  } catch (error) {
    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }

    console.error('[merge error]', error.message);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Merge failed' 
      });
    }
  }
});

// ─── GET /audio - Direct MP3 download (PROBLEM 3 FIXED) ───────────────────────
router.get('/audio', async (req, res) => {
  const { url, quality = '192' } = req.query;

  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'URL is required' 
    });
  }

  const depsOk = await checkDependencies();
  if (!depsOk) {
    return res.status(500).json({ 
      success: false, 
      error: 'yt-dlp not installed' 
    });
  }

  const outputFile = path.join(TEMP_DIR, `audio_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp3`);

  try {
    console.log(`[audio] Extracting audio from: ${url}`);

    await execPromise(
      `yt-dlp -x --audio-format mp3 --audio-quality ${quality}k -o "${outputFile}" "${url}"`,
      { maxBuffer: 200 * 1024 * 1024, timeout: 300000 }
    );

    if (!fs.existsSync(outputFile)) {
      throw new Error('Audio extraction failed');
    }

    const stat = fs.statSync(outputFile);

    // Headers for direct download
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);

    stream.on('end', () => {
      fs.unlink(outputFile, () => {});
    });

  } catch (error) {
    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }

    console.error('[audio error]', error.message);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Audio extraction failed' 
      });
    }
  }
});

// ─── OPTIONS for CORS ─────────────────────────────────────────────────────────
router.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.sendStatus(200);
});

module.exports = router;
