// js/app.js
import { fetchFileBlob, fetchFileMeta, DriveApiError } from './drive-api.js';
import {
  loadLibrary, addComic, removeComic,
  getProgress, setProgress,
  loadSettings, saveSettings,
} from './library.js';
import { openPdf } from './pdf-reader.js';
import { getBlob as getCachedBlob, putBlob as cacheBlob, deleteBlob as deleteCachedBlob, hasBlob } from './blob-store.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const screens = {
  library: $('#screen-library'),
  reader: $('#screen-reader'),
};

let settings = loadSettings();
let activeSession = null; // { pages, entryNames, revoke, comic }

// In-memory cache of raw PDF blobs, keyed by Drive file ID — a fast
// first stop before checking the persistent IndexedDB store (blob-store.js).
// Populated whenever a comic is opened or downloaded. Cleared on reload;
// the IndexedDB layer is what survives across sessions.
const blobCache = new Map();

// Resolves a PDF blob for fileId, checking the in-memory cache, then the
// persistent IndexedDB store, and only hitting Drive as a last resort.
// Whatever is fetched from Drive gets written back to both caches so the
// next open/download — even after a full page reload — is instant and
// offline-capable.
async function resolveBlob(fileId, apiKey, onProgress) {
  let blob = blobCache.get(fileId);
  if (blob) return { blob, source: 'memory' };

  blob = await getCachedBlob(fileId);
  if (blob) {
    blobCache.set(fileId, blob);
    return { blob, source: 'disk' };
  }

  blob = await fetchFileBlob(fileId, apiKey, onProgress);
  blobCache.set(fileId, blob);
  cacheBlob(fileId, blob); // fire-and-forget; caching failures shouldn't block reading
  return { blob, source: 'network' };
}

// ---------- boot ----------

function init() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  $('#api-key-input').value = settings.apiKey || '';
  renderLibrary();
  bindLibraryEvents();
  bindReaderEvents();
  showScreen('library');
}

// Accepts either a bare Drive file ID or a full share link and pulls
// the ID out of either — pasting the whole drive.google.com/file/d/.../view
// URL used to fail with "File not found" because the ID field expected
// just the ID segment.
function extractFileId(raw) {
  if (!raw) return '';
  const s = raw.trim();
  const linkMatch = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (linkMatch) return linkMatch[1];
  return s;
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('is-active', key === name);
  });
}

// ---------- library screen ----------

function renderLibrary() {
  const items = loadLibrary();
  const grid = $('#library-grid');
  const empty = $('#library-empty');

  grid.innerHTML = '';
  empty.hidden = items.length > 0;

  items
    .slice()
    .sort((a, b) => b.addedAt - a.addedAt)
    .forEach((comic) => {
      const card = renderComicCard(comic);
      grid.appendChild(card);
      markOfflineBadgeWhenCached(comic.fileId, card);
    });
}

// Checking IndexedDB is async, so the offline badge is added after the
// card is already in the DOM rather than blocking the initial render.
function markOfflineBadgeWhenCached(fileId, card) {
  hasBlob(fileId).then((cached) => {
    if (!cached) return;
    const cover = card.querySelector('.comic-card__cover');
    if (cover && !cover.querySelector('.comic-card__offline')) {
      const badge = document.createElement('span');
      badge.className = 'comic-card__offline';
      badge.title = 'Available offline';
      badge.textContent = '✓';
      cover.appendChild(badge);
    }
  });
}

// Re-checks the offline badge for a single card after a fetch that may
// have just cached the comic for the first time (e.g. after opening or
// downloading it), so the checkmark appears without a full re-render.
function refreshOfflineBadge(fileId) {
  const cover = document.querySelector(`[data-open="${fileId}"]`);
  const card = cover?.closest('.comic-card');
  if (card) markOfflineBadgeWhenCached(fileId, card);
}

function renderComicCard(comic) {
  const progress = getProgress(comic.fileId);

  const card = document.createElement('article');
  card.className = 'comic-card';
  card.innerHTML = `
    <button class="comic-card__cover" data-open="${comic.fileId}" aria-label="Open ${escapeHtml(comic.title)}">
      <span class="comic-card__spine"></span>
      <span class="comic-card__initial">${escapeHtml(comic.title.slice(0, 1).toUpperCase())}</span>
      ${progress > 0 ? `<span class="comic-card__badge">p.${progress + 1}</span>` : ''}
    </button>
    <div class="comic-card__meta">
      <p class="comic-card__title">${escapeHtml(comic.title)}</p>
      <div class="comic-card__actions">
        <button class="comic-card__icon-btn" data-download="${comic.fileId}" aria-label="Download ${escapeHtml(comic.title)}" title="Download to device">⬇</button>
        <button class="comic-card__remove" data-remove="${comic.fileId}" aria-label="Remove ${escapeHtml(comic.title)}">Remove</button>
      </div>
    </div>
    <p class="comic-card__status" data-status="${comic.fileId}"></p>
  `;
  return card;
}

function bindLibraryEvents() {
  $('#add-comic-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileId = extractFileId($('#add-file-id').value);
    const titleInput = $('#add-title').value.trim();
    const status = $('#add-status');

    if (!fileId) return;
    if (!settings.apiKey) {
      status.textContent = 'Add your Drive API key first (below).';
      return;
    }

    status.textContent = 'Checking file…';
    try {
      const meta = await fetchFileMeta(fileId, settings.apiKey);
      const isPdf = meta.mimeType === 'application/pdf';
      const comic = addComic({
        fileId,
        title: titleInput || meta.name.replace(/\.pdf$/i, ''),
        size: Number(meta.size) || null,
      });
      status.textContent = isPdf
        ? `Added "${comic.title}".`
        : `Added "${comic.title}" — heads up, Drive reports this as ${meta.mimeType || 'an unknown type'}, not a PDF. It may not open.`;
      $('#add-comic-form').reset();
      renderLibrary();
    } catch (err) {
      status.textContent = err instanceof DriveApiError ? err.message : err.message;
    }
  });

  $('#library-grid').addEventListener('click', (e) => {
    const openId = e.target.closest('[data-open]')?.dataset.open;
    const removeId = e.target.closest('[data-remove]')?.dataset.remove;
    const downloadId = e.target.closest('[data-download]')?.dataset.download;

    if (openId) openComic(openId);
    if (downloadId) downloadComic(downloadId);
    if (removeId) {
      const comic = loadLibrary().find((c) => c.fileId === removeId);
      if (confirm(`Remove "${comic?.title ?? removeId}" from your library?`)) {
        removeComic(removeId);
        blobCache.delete(removeId);
        deleteCachedBlob(removeId);
        renderLibrary();
      }
    }
  });

  $('#save-key-btn').addEventListener('click', () => {
    settings.apiKey = $('#api-key-input').value.trim();
    saveSettings(settings);
    $('#key-status').textContent = settings.apiKey ? 'Saved.' : 'Cleared.';
    setTimeout(() => ($('#key-status').textContent = ''), 2000);
  });
}

// ---------- opening + reading a comic ----------

async function openComic(fileId) {
  const comic = loadLibrary().find((c) => c.fileId === fileId);
  if (!comic) return;
  if (!settings.apiKey) {
    alert('Add your Drive API key first.');
    return;
  }

  showScreen('reader');
  setLoading(true, `Downloading "${comic.title}"…`);

  try {
    const { blob } = await resolveBlob(fileId, settings.apiKey, (loaded, total) => {
      const pct = total ? Math.round((loaded / total) * 100) : null;
      setLoading(true, pct != null
        ? `Downloading "${comic.title}"… ${pct}%`
        : `Downloading "${comic.title}"…`);
    });

    setLoading(true, 'Rendering pages…');
    const { pages, entryNames, revoke } = await openPdf(blob, (rendered, total) => {
      setLoading(true, `Rendering page ${rendered} of ${total}…`);
    });

    if (activeSession) activeSession.revoke();
    activeSession = { pages, entryNames, revoke, comic };

    $('#reader-title').textContent = comic.title;
    goToPage(getProgress(fileId));
    setLoading(false);
    refreshOfflineBadge(fileId);
  } catch (err) {
    setLoading(false);
    const msg = err instanceof DriveApiError || err instanceof Error ? err.message : 'Something went wrong opening this file.';
    $('#reader-error').textContent = msg;
    $('#reader-error').hidden = false;
  }
}

// ---------- downloading a comic to the device ----------

// Triggers a native browser download by clicking a temporary, hidden <a>
// with a blob: URL. This works cross-platform, including Android mobile
// browsers that don't support the File System Access API — the browser's
// own download manager takes it from there and saves to the device's
// shared Downloads folder (or prompts for a location, per browser/OS
// settings), no extra permissions or APIs needed on our end.
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a moment to pick up the blob before revoking it.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function sanitizeFilename(title) {
  const cleaned = (title || 'comic')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'comic';
}

async function downloadComic(fileId) {
  const comic = loadLibrary().find((c) => c.fileId === fileId);
  if (!comic) return;
  if (!settings.apiKey) {
    alert('Add your Drive API key first.');
    return;
  }

  const statusEl = document.querySelector(`[data-status="${fileId}"]`);
  const btn = document.querySelector(`[data-download="${fileId}"]`);
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = '';

  try {
    const { blob, source } = await resolveBlob(fileId, settings.apiKey, (loaded, total) => {
      if (!statusEl) return;
      const pct = total ? Math.round((loaded / total) * 100) : null;
      statusEl.textContent = pct != null ? `Downloading… ${pct}%` : 'Downloading…';
    });
    if (statusEl && source !== 'network') statusEl.textContent = 'Saving…';

    triggerDownload(blob, `${sanitizeFilename(comic.title)}.pdf`);
    refreshOfflineBadge(fileId);
    if (statusEl) {
      statusEl.textContent = 'Saved to Downloads.';
      setTimeout(() => {
        if (statusEl.textContent === 'Saved to Downloads.') statusEl.textContent = '';
      }, 2500);
    }
  } catch (err) {
    const msg = err instanceof DriveApiError ? err.message : 'Download failed. Try again.';
    if (statusEl) statusEl.textContent = msg;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setLoading(isLoading, message = '') {
  $('#reader-loading').hidden = !isLoading;
  $('#reader-loading-text').textContent = message;
  $('#reader-error').hidden = true;
  $('#reader-page-wrap').hidden = isLoading;
}

function goToPage(index) {
  if (!activeSession) return;
  const { pages, comic } = activeSession;
  const clamped = Math.max(0, Math.min(index, pages.length - 1));

  $('#reader-page-img').src = pages[clamped];
  $('#reader-page-count').textContent = `${clamped + 1} / ${pages.length}`;
  activeSession.currentIndex = clamped;
  setProgress(comic.fileId, clamped);
}

function bindReaderEvents() {
  $('#reader-back').addEventListener('click', closeReader);

  $('#reader-download').addEventListener('click', () => {
    if (activeSession?.comic) downloadComic(activeSession.comic.fileId);
  });

  $('#reader-prev').addEventListener('click', () => stepPage(-1));
  $('#reader-next').addEventListener('click', () => stepPage(1));

  // tap left/right half of the page image to turn pages, like a real reader
  $('#reader-page-wrap').addEventListener('click', (e) => {
    if (e.target.closest('.reader-nav-btn')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    stepPage(clickX < rect.width / 2 ? -1 : 1);
  });

  document.addEventListener('keydown', (e) => {
    if (!screens.reader.classList.contains('is-active')) return;
    if (e.key === 'ArrowLeft') stepPage(-1);
    if (e.key === 'ArrowRight') stepPage(1);
    if (e.key === 'Escape') closeReader();
  });
}

function stepPage(delta) {
  if (!activeSession) return;
  goToPage((activeSession.currentIndex ?? 0) + delta);
}

function closeReader() {
  if (activeSession) activeSession.revoke();
  activeSession = null;
  showScreen('library');
  renderLibrary();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
