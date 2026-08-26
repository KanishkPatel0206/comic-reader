// js/library.js
// Client-side library: maps Drive File IDs -> comic metadata.
// Persisted in localStorage so nothing server-side is needed.

const LIB_KEY = 'comicreader.library.v1';
const SETTINGS_KEY = 'comicreader.settings.v1';
const PROGRESS_KEY = 'comicreader.progress.v1';

function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLibrary(items) {
  localStorage.setItem(LIB_KEY, JSON.stringify(items));
}

function addComic({ fileId, title, size = null, thumbnailLink = null }) {
  const items = loadLibrary();
  if (items.some((c) => c.fileId === fileId)) {
    throw new Error('This file ID is already in your library.');
  }
  const comic = {
    fileId,
    title: title?.trim() || fileId,
    size,
    thumbnailLink,
    addedAt: Date.now(),
  };
  items.push(comic);
  saveLibrary(items);
  return comic;
}

function removeComic(fileId) {
  const items = loadLibrary().filter((c) => c.fileId !== fileId);
  saveLibrary(items);
  clearProgress(fileId);
}

function updateComic(fileId, patch) {
  const items = loadLibrary();
  const idx = items.findIndex((c) => c.fileId === fileId);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  saveLibrary(items);
  return items[idx];
}

// --- reading progress: which page a comic was left on ---

function loadProgressMap() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getProgress(fileId) {
  return loadProgressMap()[fileId] || 0;
}

function setProgress(fileId, pageIndex) {
  const map = loadProgressMap();
  map[fileId] = pageIndex;
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
}

function clearProgress(fileId) {
  const map = loadProgressMap();
  delete map[fileId];
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
}

// --- settings: API key lives here, restricted to this browser's storage ---

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { apiKey: '' };
  } catch {
    return { apiKey: '' };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export {
  loadLibrary,
  saveLibrary,
  addComic,
  removeComic,
  updateComic,
  getProgress,
  setProgress,
  clearProgress,
  loadSettings,
  saveSettings,
};
