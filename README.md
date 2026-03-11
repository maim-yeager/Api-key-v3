# 🎬 Video Downloader API

Social media video downloader API powered by **yt-dlp** + **ffmpeg**.

Supports: **YouTube, TikTok, Facebook, Instagram** + 1000+ other platforms.

---

## 🚀 Quick Start

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Copy env file
cp .env.example .env

# 3. Make sure yt-dlp & ffmpeg are installed
# Ubuntu/Debian:
sudo apt install ffmpeg
sudo wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp

# 4. Start server
npm run dev
```

### Deploy to Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Create app (first time only)
flyctl launch --no-deploy

# Create persistent volumes
flyctl volumes create video_dl_data      --size 1
flyctl volumes create video_dl_downloads --size 5
flyctl volumes create video_dl_cookies   --size 1

# Set secrets (optional API key protection)
flyctl secrets set API_KEY=your-secret-key

# Deploy
flyctl deploy
```

---

## 🔐 Authentication

If `API_KEY` is set in environment, pass it with every request:

```
Header: X-API-Key: your-secret-key
# OR
Query:  ?api_key=your-secret-key
```

---

## 📡 API Endpoints

### 1. `POST /api/info` — Get Video Info

Get full metadata, all available formats, subtitles, and thumbnail.

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "use_cookies": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up",
    "description": "...",
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    "duration": 213,
    "duration_string": "3:33",
    "uploader": "Rick Astley",
    "uploader_url": "https://www.youtube.com/@RickAstleyYT",
    "channel": "Rick Astley",
    "channel_follower_count": 4200000,
    "view_count": 1400000000,
    "like_count": 16000000,
    "upload_date": "20091025",
    "platform": "youtube",

    "formats": [
      {
        "format_id": "137",
        "ext": "mp4",
        "resolution": "1920x1080",
        "height": 1080,
        "fps": 25,
        "has_video": true,
        "has_audio": false,
        "filesize": 85234567,
        "url": "https://..."
      }
    ],

    "subtitles": {
      "en": [{ "ext": "vtt", "url": "https://..." }],
      "bn": [{ "ext": "vtt", "url": "https://..." }]
    },

    "suggested_formats": {
      "1080p": "137",
      "720p":  "22",
      "480p":  "135",
      "best":  "bestvideo",
      "audio": "140"
    }
  }
}
```

---

### 2. `POST /api/download` — Download Video/Audio

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "type": "video",
  "format": "mp4",
  "quality": "720p",
  "subtitles": true,
  "use_cookies": true
}
```

| Field | Values | Default |
|-------|--------|---------|
| `type` | `video` \| `audio` | `video` |
| `format` | `mp4` `mkv` `webm` \| `mp3` `m4a` `opus` `flac` | `mp4` |
| `quality` | `best` `1080p` `720p` `480p` `360p` or format_id | `best` |
| `subtitles` | `true` \| `false` | `true` |

**Response:**
```json
{
  "success": true,
  "history_id": "abc-123",
  "title": "Rick Astley - Never Gonna Give You Up",
  "thumbnail": "https://i.ytimg.com/...",
  "duration": 213,
  "filesize": 45678901,
  "format": "mp4",
  "quality": "720p",
  "download_url": "/api/download/file/abc-123/abc-123.mp4",
  "subtitle_files": [
    { "filename": "abc-123.en.srt", "download_url": "/api/download/file/abc-123/abc-123.en.srt" }
  ],
  "info": { ... }
}
```

**Download the file:**
```
GET /api/download/file/{history_id}/{filename}
```
Supports HTTP range requests for video streaming/preview.

---

### 3. `GET /api/history` — Download History

```
GET /api/history?page=1&limit=20&platform=youtube&status=completed
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "abc-123",
      "url": "https://...",
      "title": "Video Title",
      "platform": "youtube",
      "format_type": "mp4",
      "quality": "720p",
      "file_size": 45678901,
      "duration": 213,
      "thumbnail": "https://...",
      "status": "completed",
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 150, "pages": 8 }
}
```

---

### 4. `POST /api/cookies` — Upload Private Video Cookies

For downloading private videos (YouTube private, Instagram stories, etc.).

**Option A: File upload**
```
POST /api/cookies/upload
Content-Type: multipart/form-data

platform: youtube
file: cookies.txt   (Netscape format)
```

**Option B: Raw text**
```json
POST /api/cookies/raw
{
  "platform": "youtube",
  "cookies": "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\t..."
}
```

**Get cookie status:**
```
GET /api/cookies
```

**Delete cookies:**
```
DELETE /api/cookies/{platform}
```

---

## 🍪 How to Get Cookies

### Method 1: Browser Extension
Install **"Get cookies.txt LOCALLY"** extension for Chrome/Firefox.
1. Login to YouTube/TikTok/etc.
2. Click extension → Export cookies → Save as `cookies.txt`
3. Upload via `/api/cookies/upload`

### Method 2: yt-dlp (from browser)
```bash
yt-dlp --cookies-from-browser chrome --cookies cookies.txt <URL>
```

---

## 📦 Supported Formats

| Format | Type | Description |
|--------|------|-------------|
| `mp4` | Video+Audio | Most compatible |
| `mkv` | Video+Audio | Best quality, all codecs |
| `webm` | Video+Audio | Web optimized |
| `mp3` | Audio only | Universal audio |
| `m4a` | Audio only | High quality AAC |
| `opus` | Audio only | Best compression |
| `flac` | Audio only | Lossless |

---

## 🌐 Supported Platforms

YouTube, TikTok, Facebook, Instagram, Twitter/X, Reddit, Twitch, Vimeo, Dailymotion, and [1000+ more via yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).

---

## 🔧 Web App Integration Example

```javascript
// 1. Get video info for preview
const infoRes = await fetch('https://your-api.fly.dev/api/info', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': 'your-key' },
  body: JSON.stringify({ url: videoUrl }),
});
const { data } = await infoRes.json();

// Show thumbnail preview
document.querySelector('#thumbnail').src = data.thumbnail;
document.querySelector('#title').textContent = data.title;

// 2. Download
const dlRes = await fetch('https://your-api.fly.dev/api/download', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': 'your-key' },
  body: JSON.stringify({ url: videoUrl, format: 'mp4', quality: '720p' }),
});
const { download_url } = await dlRes.json();

// 3. Trigger file download
window.location.href = `https://your-api.fly.dev${download_url}`;
```
