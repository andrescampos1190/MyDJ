# MyDJ backend — FastAPI + yt-dlp + ffmpeg. Built for Render's "Docker" environment
# (the native Python runtime has no ffmpeg, which the downloader + analyzer require).
FROM python:3.12-slim

# ffmpeg + ffprobe: yt-dlp's audio extraction and analyzer._decode both shell out to them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so the layer caches across code changes.
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code (backend/.env and downloads/ are excluded via .dockerignore).
COPY backend/ ./

# Render injects $PORT; default to 8000 for a local `docker run -p 8000:8000`.
ENV PORT=8000
# Vocal separation needs ~1.5 GB RAM and real CPU — off on small cloud instances.
# Set MYDJ_STEMS=1 on a machine with the headroom.
ENV MYDJ_STEMS=0
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
