/* =====================
   STATE
   ===================== */
let currentInfo = null;
let selectedFormat = null;

/* =====================
   DOM REFS
   ===================== */
const urlInput    = document.getElementById('urlInput');
const searchBtn   = document.getElementById('searchBtn');
const errorMsg    = document.getElementById('errorMsg');
const loadingCard = document.getElementById('loadingCard');
const videoCard   = document.getElementById('videoCard');

/* =====================
   ENTER KEY
   ===================== */
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchInfo();
});

/* =====================
   FETCH VIDEO INFO
   ===================== */
async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) return showError('Por favor pega un enlace de video.');

  hideError();
  hideVideoCard();
  showLoading();
  setSearching(true);

  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Error desconocido');

    currentInfo = data;
    renderVideoCard(data, url);
  } catch (err) {
    showError(err.message);
  } finally {
    hideLoading();
    setSearching(false);
  }
}

/* =====================
   RENDER VIDEO CARD
   ===================== */
function renderVideoCard(info, url) {
  document.getElementById('thumbnail').src = info.thumbnail || '';
  document.getElementById('videoTitle').textContent = info.title || 'Sin título';
  document.getElementById('uploader').textContent = info.uploader || '';
  document.getElementById('platform').textContent = info.platform || 'Video';
  document.getElementById('duration').textContent = info.duration ? formatDuration(info.duration) : '';

  // Build format buttons
  const list = document.getElementById('formatList');
  list.innerHTML = '';
  selectedFormat = null;

  // Sort: best quality first, audio last
  const sorted = [...info.formats].sort((a, b) => b.height - a.height);

  sorted.forEach((fmt, i) => {
    const btn = document.createElement('button');
    btn.className = 'format-btn';
    btn.textContent = fmt.label;
    const tips = [];
    if (fmt.filesize) tips.push(formatBytes(fmt.filesize));
    if (!fmt.hasAudio && fmt.ext !== 'mp3') tips.push('requiere fusión con ffmpeg');
    if (tips.length) btn.title = tips.join(' · ');
    btn.addEventListener('click', () => selectFormat(fmt, btn));
    list.appendChild(btn);

    // Auto-select first (best video)
    if (i === 0) {
      selectFormat(fmt, btn);
    }
  });

  videoCard.classList.remove('hidden');
  videoCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectFormat(fmt, btn) {
  selectedFormat = fmt;
  document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

/* =====================
   DOWNLOAD
   ===================== */
async function startDownload() {
  if (!currentInfo || !selectedFormat) return;

  const url = urlInput.value.trim();
  const downloadBtn = document.getElementById('downloadBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');
  const progressPercent = document.getElementById('progressPercent');

  downloadBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Iniciando descarga...';
  progressPercent.textContent = '0%';

  try {
    // Use SSE for progress, then download the file
    const params = new URLSearchParams({
      url,
      formatId: selectedFormat.id,
      ext: selectedFormat.ext,
      hasAudio: selectedFormat.hasAudio ? 'true' : 'false',
    });

    const evtSource = new EventSource(`/api/progress?${params}`);

    evtSource.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.type === 'progress') {
        const pct = Math.round(data.percent);
        progressFill.style.width = pct + '%';
        progressPercent.textContent = pct + '%';
        progressLabel.textContent = data.label
          || (pct < 50 ? 'Descargando...' : pct < 90 ? 'Descargando...' : pct < 98 ? 'Fusionando audio y video...' : 'Finalizando...');
      }

      if (data.type === 'done') {
        evtSource.close();
        progressFill.style.width = '100%';
        progressPercent.textContent = '100%';
        progressLabel.textContent = 'Listo! Guardando archivo...';

        // Trigger browser download
        const a = document.createElement('a');
        a.href = `/api/file/${encodeURIComponent(data.filename)}`;
        a.download = data.filename.replace(/^[a-f0-9-]+\./, 'video.');
        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => {
          progressWrap.classList.add('hidden');
          downloadBtn.disabled = false;
          progressLabel.textContent = 'Descargando...';
          progressPercent.textContent = '0%';
          progressFill.style.width = '0%';
        }, 3000);
      }

      if (data.type === 'error') {
        evtSource.close();
        showError(data.message || 'Error al descargar');
        progressWrap.classList.add('hidden');
        downloadBtn.disabled = false;
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      showError('Se perdió la conexión con el servidor');
      progressWrap.classList.add('hidden');
      downloadBtn.disabled = false;
    };

  } catch (err) {
    showError(err.message);
    progressWrap.classList.add('hidden');
    downloadBtn.disabled = false;
  }
}

/* =====================
   HELPERS
   ===================== */
function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}
function hideError() { errorMsg.classList.add('hidden'); }

function showLoading() { loadingCard.classList.remove('hidden'); }
function hideLoading() { loadingCard.classList.add('hidden'); }

function hideVideoCard() { videoCard.classList.add('hidden'); }

function setSearching(on) {
  searchBtn.disabled = on;
  searchBtn.innerHTML = on
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 1s linear infinite;width:18px;height:18px"><circle cx="12" cy="12" r="10" stroke-dasharray="30 60"/></svg> Analizando...`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Analizar`;
}

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* Spinning animation for loading */
const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
