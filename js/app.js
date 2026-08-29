// js/app.js
import { fetchFileBlob, fetchFileMeta, DriveApiError } from './drive-api.js';
import {
  loadLibrary, addComic, removeComic,
  getProgress, setProgress,
  loadSettings, saveSettings,
} from './library.js';
import { openPdfSession, renderThumbnail } from './pdf-reader.js';
import {
  getBlob as getCachedBlob, putBlob as cacheBlob, deleteBlob as deleteCachedBlob, hasBlob,
  getThumbnail, putThumbnail, deleteThumbnail, totalCachedBytes,
} from './blob-store.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const screens = {
  library: $('#screen-library'),
  reader: $('#screen-reader'),
};

let settings = loadSettings();
let activeSession = null; // { session, comic, currentIndex, loadToken }

// In-memory cache of raw PDF blobs, keyed by Drive file ID — a fast
// first stop before checking the persistent IndexedDB store (blob-store.js).
// Populated whenever a comic is opened or downloaded. Cleared on reload;
// the IndexedDB layer is what survives across sessions.
const blobCache = new Map();

// Resolves a PDF blob for a comic, checking the in-memory cache, then the
// persistent IndexedDB store, and — for Drive-backed comics only — Drive
// itself as a last resort. Locally-imported comics (comic.source ===
// 'local') have no network fallback: their only copy is IndexedDB, since
// they were never fetched from anywhere in the first place.
async function resolveBlob(comic, apiKey, onProgress) {
  const fileId = comic.fileId;
  let blob = blobCache.get(fileId);
  if (blob) return { blob, source: 'memory' };

  blob = await getCachedBlob(fileId);
  if (blob) {
    blobCache.set(fileId, blob);
    return { blob, source: 'disk' };
  }

  if (comic.source === 'local') {
    throw new Error(
      'This PDF was imported from your device and its local copy is no longer available ' +
      '(the browser may have cleared storage). Re-add it from your device to read it again.'
    );
  }

  blob = await fetchFileBlob(fileId, apiKey, onProgress);
  blobCache.set(fileId, blob);
  cacheBlob(fileId, blob).catch(() => {
    // Opportunistic cache of a Drive fetch — losing it just means the next
    // open re-fetches from Drive, so failures here are silently ignored.
  });
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
  bindConnectivityBadge();
  bindStoragePanel();
  showScreen('library');
}

// ---------- storage usage panel ----------

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// Refreshes the "N MB cached" line in the storage settings panel. Called
// on boot and after anything that adds/removes a cached PDF, so the
// number stays accurate without the user needing to reopen the panel.
function refreshStorageUsed() {
  const el = $('#storage-used');
  if (!el) return;
  totalCachedBytes().then((bytes) => {
    const items = loadLibrary();
    const localCount = items.filter((c) => c.source === 'local').length;
    el.textContent = localCount > 0
      ? `${formatBytes(bytes)} cached on this device (includes ${localCount} device-only ${localCount === 1 ? 'comic' : 'comics'}).`
      : `${formatBytes(bytes)} cached on this device.`;
  });
}

// "Free up space" only clears the cached PDF bytes for Drive-backed
// comics — those can always be re-fetched from Drive on next open.
// Locally-imported comics are deliberately skipped: IndexedDB is their
// only copy, so clearing it would delete the comic for good.
function bindStoragePanel() {
  refreshStorageUsed();
  $('#clear-cache-btn').addEventListener('click', async () => {
    const status = $('#clear-cache-status');
    const driveComics = loadLibrary().filter((c) => c.source !== 'local');
    if (driveComics.length === 0) {
      status.textContent = 'Nothing to clear.';
      setTimeout(() => (status.textContent = ''), 2000);
      return;
    }
    if (!confirm(`Remove downloaded copies of ${driveComics.length} Drive-backed comic(s)? They'll re-download next time you open them.`)) {
      return;
    }
    status.textContent = 'Clearing…';
    await Promise.all(driveComics.map((c) => {
      blobCache.delete(c.fileId);
      return deleteCachedBlob(c.fileId);
    }));
    status.textContent = 'Cleared.';
    setTimeout(() => (status.textContent = ''), 2000);
    refreshStorageUsed();
    renderLibrary();
  });
}

// Shows a small "Offline" badge in the header when the browser reports no
// network connection — mainly so it's clear that locally-imported comics
// and already-cached ones still work fine, while adding a *new* comic via
// Drive won't.
function bindConnectivityBadge() {
  const badge = $('#connectivity-badge');
  const update = () => { badge.hidden = navigator.onLine; };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
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
      applyThumbnailWhenCached(comic.fileId, card);
    });
}

// Swaps the placeholder initial for a real cover image if a thumbnail has
// already been cached for this comic (rendered the first time it was
// opened — see ensureThumbnailCached). Checking IndexedDB is async, so
// this runs after the card is already in the DOM, same as the offline
// badge above.
function applyThumbnailWhenCached(fileId, card) {
  getThumbnail(fileId).then((blob) => {
    if (!blob) return;
    const cover = card.querySelector('.comic-card__cover');
    const img = cover?.querySelector('.comic-card__thumb');
    const initial = cover?.querySelector('.comic-card__initial');
    if (!img) return;
    const url = URL.createObjectURL(blob);
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    img.src = url;
    img.hidden = false;
    if (initial) initial.hidden = true;
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

// Re-checks the offline badge and cover thumbnail for a single card after
// a fetch/render that may have just cached something for the first time
// (e.g. after opening or downloading a comic), so the checkmark/cover
// appears without a full re-render. No-op if the card isn't currently in
// the DOM (e.g. we're still on the reader screen).
function refreshOfflineBadge(fileId) {
  const cover = document.querySelector(`[data-open="${fileId}"]`);
  const card = cover?.closest('.comic-card');
  if (!card) return;
  markOfflineBadgeWhenCached(fileId, card);
  applyThumbnailWhenCached(fileId, card);
}

function renderComicCard(comic) {
  const progress = getProgress(comic.fileId);

  const card = document.createElement('article');
  card.className = 'comic-card';
  card.innerHTML = `
    <button class="comic-card__cover" data-open="${comic.fileId}" aria-label="Open ${escapeHtml(comic.title)}">
      <span class="comic-card__spine"></span>
      <img class="comic-card__thumb" alt="" draggable="false" hidden />
      <span class="comic-card__initial">${escapeHtml(comic.title.slice(0, 1).toUpperCase())}</span>
      ${progress > 0 ? `<span class="comic-card__badge">p.${progress + 1}</span>` : ''}
    </button>
    <div class="comic-card__meta">
      <p class="comic-card__title">${escapeHtml(comic.title)}${comic.source === 'local' ? ' <span class="comic-card__local-tag">on device</span>' : ''}</p>
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
        deleteThumbnail(removeId);
        renderLibrary();
        refreshStorageUsed();
      }
    }
  });

  $('#save-key-btn').addEventListener('click', () => {
    settings.apiKey = $('#api-key-input').value.trim();
    saveSettings(settings);
    $('#key-status').textContent = settings.apiKey ? 'Saved.' : 'Cleared.';
    setTimeout(() => ($('#key-status').textContent = ''), 2000);
  });

  $('#add-local-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file again still fires 'change'
    if (!file) return;

    const status = $('#add-local-status');
    const looksLikePdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!looksLikePdf) {
      status.textContent = "That doesn't look like a PDF.";
      return;
    }

    status.textContent = 'Saving to this device…';
    const fileId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = file.name.replace(/\.pdf$/i, '');

    try {
      // Await this — for a local import, IndexedDB IS the only copy, so we
      // need to know it actually persisted before listing it in the library.
      await cacheBlob(fileId, file);
      blobCache.set(fileId, file);
      const comic = addComic({ fileId, title, size: file.size, source: 'local' });
      status.textContent = `Added "${comic.title}" — stored on this device, reads fully offline.`;
      setTimeout(() => {
        if (status.textContent.startsWith('Added')) status.textContent = '';
      }, 3000);
      renderLibrary();
      refreshStorageUsed();
    } catch {
      status.textContent = "Couldn't save that file — your device storage may be full.";
    }
  });
}

// ---------- opening + reading a comic ----------

// Renders and caches a low-res cover thumbnail the first time a comic is
// opened, if one isn't cached already. Runs in the background — it never
// blocks or delays the reader, and failures are silently ignored since a
// missing thumbnail just means the library card keeps its placeholder
// initial. Once cached, refreshes the card in case the library grid is
// (or later becomes) visible.
async function ensureThumbnailCached(fileId, blob) {
  try {
    const existing = await getThumbnail(fileId);
    if (existing) return;
    const thumbBlob = await renderThumbnail(blob);
    if (!thumbBlob) return;
    await putThumbnail(fileId, thumbBlob);
    refreshOfflineBadge(fileId);
  } catch {
    // best-effort; the card just keeps showing its initial letter
  }
}

async function openComic(fileId) {
  const comic = loadLibrary().find((c) => c.fileId === fileId);
  if (!comic) return;
  const isLocal = comic.source === 'local';
  if (!isLocal && !settings.apiKey) {
    alert('Add your Drive API key first.');
    return;
  }

  showScreen('reader');
  setLoading(true, isLocal ? 'Loading…' : `Downloading "${comic.title}"…`);

  try {
    const { blob } = await resolveBlob(comic, settings.apiKey, (loaded, total) => {
      const pct = total ? Math.round((loaded / total) * 100) : null;
      setLoading(true, pct != null
        ? `Downloading "${comic.title}"… ${pct}%`
        : `Downloading "${comic.title}"…`);
    });

    // Only the document structure is parsed here — no pages are rendered
    // yet, so this resolves quickly even for long/high-res comics. Pages
    // are rendered on demand as goToPage() below requests them.
    setLoading(true, 'Opening…');
    const session = await openPdfSession(blob);

    if (activeSession) activeSession.session.revoke();
    activeSession = { session, comic, currentIndex: 0, loadToken: 0 };

    $('#reader-title').textContent = comic.title;
    $('#reader-page-img').removeAttribute('src'); // old page's blob URL is now revoked; clear before it flashes as a broken image
    setLoading(false);
    await goToPage(getProgress(fileId));
    refreshOfflineBadge(fileId);
    refreshStorageUsed();

    ensureThumbnailCached(fileId, blob);
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
  if (comic.source !== 'local' && !settings.apiKey) {
    alert('Add your Drive API key first.');
    return;
  }

  const statusEl = document.querySelector(`[data-status="${fileId}"]`);
  const btn = document.querySelector(`[data-download="${fileId}"]`);
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = '';

  try {
    const { blob, source } = await resolveBlob(comic, settings.apiKey, (loaded, total) => {
      if (!statusEl) return;
      const pct = total ? Math.round((loaded / total) * 100) : null;
      statusEl.textContent = pct != null ? `Downloading… ${pct}%` : 'Downloading…';
    });
    if (statusEl && source !== 'network') statusEl.textContent = 'Saving…';

    triggerDownload(blob, `${sanitizeFilename(comic.title)}.pdf`);
    refreshOfflineBadge(fileId);
    refreshStorageUsed();
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

// Renders (or grabs from cache/prefetch) the page at `index` and displays
// it. Async because pages are now rendered lazily — a small spinner shows
// over the page area while this particular page hasn't been rendered yet
// (usually only noticeable on the very first page, or after jumping far
// ahead of the prefetch window).
async function goToPage(index) {
  if (!activeSession) return;
  const { session, comic } = activeSession;
  const clamped = Math.max(0, Math.min(index, session.numPages - 1));

  activeSession.currentIndex = clamped;
  setProgress(comic.fileId, clamped);
  $('#reader-page-count').textContent = `${clamped + 1} / ${session.numPages}`;

  // Guards against a fast page-turn superseding an in-flight render: if
  // the user has since moved on to a different page, this older render's
  // result is discarded rather than flashing onto the screen out of order.
  const token = ++activeSession.loadToken;
  const spinner = $('#reader-page-spinner');
  const img = $('#reader-page-img');
  spinner.hidden = false;
  $('#reader-error').hidden = true;

  try {
    const url = await session.getPage(clamped);
    if (activeSession?.loadToken !== token) return;
    img.src = url;
    spinner.hidden = true;
  } catch {
    if (activeSession?.loadToken !== token) return;
    spinner.hidden = true;
    $('#reader-error').textContent = 'Could not render this page.';
    $('#reader-error').hidden = false;
  }
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
  if (activeSession) activeSession.session.revoke();
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
