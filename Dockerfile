FROM node:20-slim

# ─── Install system dependencies ─────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    wget \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ─── Install yt-dlp ──────────────────────────────────────────────────────────
RUN wget -O /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Verify yt-dlp works
RUN yt-dlp --version

# ─── App setup ───────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Create necessary directories
RUN mkdir -p downloads data cookies

# ─── Runtime ─────────────────────────────────────────────────────────────────
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Keep yt-dlp updated on startup
CMD sh -c "yt-dlp -U 2>/dev/null || true && node server.js"
