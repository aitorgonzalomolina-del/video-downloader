const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

const PORT = process.env.PORT || 3000;

// In production (Railway/Linux) ffmpeg is in PATH.
// In local Windows, winget installs it outside PATH so we use FFMPEG_PATH env var.
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const FFMPEG_DIR = process.env.FFMPEG_PATH ||
  (process.platform === 'win32'
    ? 'C:\\Users\\aitor\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin'
    : '');  // empty = use system PATH on Linux

const YTDLP_BASE = FFMPEG_DIR
  ? ['-m', 'yt_dlp', '--ffmpeg-location', FFMPEG_DIR]
  : ['-m', 'yt_dlp'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function cleanOldFiles() {
  const now = Date.now();
  fs.readdir(DOWNLOADS_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(DOWNLOADS_DIR, file);
      fs.stat(filePath, (err, stat) => {
        if (err) return;
        if (now - stat.mtimeMs > 10 * 60 * 1000) fs.unlink(filePath, () => {});
      });
    });
  });
}
setInterval(cleanOldFiles, 5 * 60 * 1000);

// GET /api/info
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL requerida' });

  try { new URL(url); } catch { return res.status(400).json({ error: 'URL no válida' }); }

  const safeUrl = url.replace(/"/g, '');
  const cmd = `${PYTHON} -m yt_dlp --dump-json --no-playlist "${safeUrl}"`;

  exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp error:', stderr);
      const msg = stderr.includes('Unsupported URL') ? 'Sitio no soportado o URL inválida'
        : stderr.includes('Private') ? 'El video es privado'
        : stderr.includes('available') ? 'Video no disponible en tu región'
        : 'No se pudo obtener información del video';
      return res.status(400).json({ error: msg });
    }

    try {
      const info = JSON.parse(stdout);
      const formats = buildFormatList(info);

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader || info.channel,
        platform: info.extractor_key,
        formats,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error procesando información del video' });
    }
  });
});

/**
 * Build a clean format list.
 * hasAudio: whether the format already contains audio stream.
 * If not, ffmpeg will be used to merge with best audio.
 */
function buildFormatList(info) {
  if (!info.formats || info.formats.length === 0) {
    return [
      { id: 'bestvideo+bestaudio/best', label: 'Mejor calidad (MP4)', ext: 'mp4', hasAudio: true, height: 9999 },
      { id: 'bestaudio', label: 'Solo Audio (MP3)', ext: 'mp3', hasAudio: true, height: -1 },
    ];
  }

  const seen = new Set();
  const videoFormats = [];

  // Collect video formats (with or without audio)
  info.formats
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.ext !== 'mhtml')
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .forEach(f => {
      const hasAudio = f.acodec && f.acodec !== 'none';
      const qualityLabel = f.height
        ? `${f.height}p${f.fps && f.fps > 30 ? ` ${Math.round(f.fps)}fps` : ''}`
        : (f.format_note || f.format_id);
      const extLabel = f.ext.toUpperCase();
      const label = `${qualityLabel} (${extLabel})`;

      if (!seen.has(label)) {
        seen.add(label);
        videoFormats.push({
          id: f.format_id,
          label,
          ext: 'mp4', // always output as mp4
          hasAudio,
          height: f.height || 0,
          filesize: f.filesize || f.filesize_approx || null,
        });
      }
    });

  // Audio-only option
  const bestAudio = info.formats
    .filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

  if (bestAudio) {
    videoFormats.push({
      id: 'bestaudio',
      label: 'Solo Audio (MP3)',
      ext: 'mp3',
      hasAudio: true,
      height: -1,
      filesize: bestAudio.filesize || null,
    });
  }

  return videoFormats;
}

/**
 * Build yt-dlp format arguments.
 * For video-only formats: merge with best audio using ffmpeg.
 * For formats with audio already: download directly, recode to mp4.
 */
function buildFormatArgs(formatId, ext, hasAudio) {
  if (formatId === 'bestaudio' || ext === 'mp3') {
    return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  }

  // Build format selector
  const formatStr = formatId === 'bestvideo+bestaudio/best'
    ? 'bestvideo+bestaudio/best'
    : hasAudio
      ? formatId
      : `${formatId}+bestaudio/best`;

  // Always merge to MP4 and re-encode audio to AAC (192k).
  // YouTube audio is opus (webm), which is not compatible with MP4 containers.
  // -c:v copy keeps the original video codec, -c:a aac converts audio.
  return [
    '-f', formatStr,
    '--merge-output-format', 'mp4',
    '--postprocessor-args', 'Merger+ffmpeg:-c:v copy -c:a aac -b:a 192k',
  ];
}

// POST /api/download (fallback, not used by frontend progress flow)
app.post('/api/download', (req, res) => {
  const { url, formatId, ext, hasAudio } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'URL no válida' }); }

  const safeUrl = url.replace(/"/g, '');
  const fileId = uuidv4();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${fileId}.%(ext)s`);
  const formatArgs = buildFormatArgs(formatId, ext, hasAudio);

  const args = [...YTDLP_BASE, ...formatArgs, '--no-playlist', '-o', outputTemplate, safeUrl];
  console.log('Running:', PYTHON, args.join(' '));

  const proc = spawn(PYTHON, args, { timeout: 120000 });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('close', code => {
    if (code !== 0) {
      console.error('yt-dlp failed:', stderr);
      return res.status(500).json({ error: 'Error al descargar. Intenta con otro formato.' });
    }
    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(fileId));
    if (!files.length) return res.status(500).json({ error: 'Archivo no encontrado' });

    const filePath = path.join(DOWNLOADS_DIR, files[0]);
    const outExt = files[0].split('.').pop();
    res.download(filePath, `video.${outExt}`, err => {
      fs.unlink(filePath, () => {});
    });
  });
});

// GET /api/progress (SSE with real-time progress)
app.get('/api/progress', (req, res) => {
  const { url, formatId, ext, hasAudio } = req.query;
  if (!url) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const safeUrl = url.replace(/"/g, '');
  const fileId = uuidv4();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${fileId}.%(ext)s`);
  const formatArgs = buildFormatArgs(formatId, ext, hasAudio === 'true');

  const args = [
    ...YTDLP_BASE,
    ...formatArgs,
    '--no-playlist',
    '--newline',
    '-o', outputTemplate,
    safeUrl,
  ];

  console.log('SSE download:', PYTHON, args.join(' '));
  const proc = spawn(PYTHON, args);
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  proc.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    lines.forEach(line => {
      // Progress percentage
      const pct = line.match(/\[download\]\s+([\d.]+)%/);
      if (pct) return send({ type: 'progress', percent: parseFloat(pct[1]) });

      // Merging stage
      if (line.includes('[Merger]') || line.includes('Merging')) {
        send({ type: 'progress', percent: 95, label: 'Fusionando streams...' });
      }
    });
  });

  proc.stderr.on('data', chunk => console.error('stderr:', chunk.toString()));

  proc.on('close', code => {
    if (code !== 0) {
      send({ type: 'error', message: 'Error al descargar. Intenta con otro formato.' });
      return res.end();
    }
    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(fileId));
    if (!files.length) {
      send({ type: 'error', message: 'Archivo no encontrado tras la descarga' });
      return res.end();
    }
    send({ type: 'done', fileId, filename: files[0] });
    res.end();
  });

  req.on('close', () => proc.kill());
});

// GET /api/file/:filename
app.get('/api/file/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado o expirado' });
  }

  const outExt = filename.split('.').pop();
  res.download(filePath, `video.${outExt}`, () => {
    fs.unlink(filePath, () => {});
  });
});

app.listen(PORT, () => {
  console.log(`\nVideo Downloader corriendo en http://localhost:${PORT}`);
  console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`ffmpeg: ${FFMPEG_DIR || 'sistema PATH'}\n`);
});
