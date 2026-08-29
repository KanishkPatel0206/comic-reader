// js/blob-store.js
// Persists raw PDF bytes in IndexedDB, keyed by Drive file ID, so a comic
// that's already been fetched once doesn't need to be re-downloaded from
// Drive on every visit. localStorage can't hold binary blobs of this size
// (and has a ~5MB ceiling); IndexedDB has no such practical limit and is
// built for exactly this.
//
// A second object store holds small low-res cover thumbnails (rendered
// from each comic's first page, the first time it's opened) so the library
// grid can show real cover art instead of a placeholder initial.

const DB_NAME = 'comicreader.blobs.v1';
const STORE_NAME = 'pdfs';
const THUMB_STORE_NAME = 'thumbnails';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not available in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME); // keyPath: none, key passed explicitly
      }
      if (!db.objectStoreNames.contains(THUMB_STORE_NAME)) {
        db.createObjectStore(THUMB_STORE_NAME); // keyPath: none, key passed explicitly
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * Store a PDF blob for a given file ID, along with a timestamp so a future
 * "clear old cache" feature has something to sort on. Throws on failure
 * (quota exceeded, private browsing, etc.) — callers that treat caching as
 * a nice-to-have (e.g. opportunistically caching a Drive fetch) should
 * catch and ignore; callers where this IS the only copy of the data (e.g.
 * a locally-imported PDF) should catch and surface the failure to the user.
 * @param {string} fileId
 * @param {Blob} blob
 */
async function putBlob(fileId, blob) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ blob, size: blob.size, cachedAt: Date.now() }, fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieve a previously cached PDF blob, or null if not present / on error.
 * @param {string} fileId
 * @returns {Promise<Blob|null>}
 */
async function getBlob(fileId) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(fileId);
      req.onsuccess = () => resolve(req.result?.blob ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Remove a cached blob, e.g. when the comic is removed from the library.
 * @param {string} fileId
 */
async function deleteBlob(fileId) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(fileId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort cleanup; ignore failures
  }
}

/**
 * Total bytes currently cached, across all comics — useful for a future
 * "storage used" indicator in settings.
 * @returns {Promise<number>}
 */
async function totalCachedBytes() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const total = (req.result || []).reduce((sum, entry) => sum + (entry.size || 0), 0);
        resolve(total);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return 0;
  }
}

/**
 * Check whether a blob is cached for fileId without loading the blob
 * itself — used for a lightweight "available offline" indicator.
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
async function hasBlob(fileId) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getKey(fileId);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return false;
  }
}

/**
 * Store a low-res cover thumbnail (JPEG Blob) for a comic, so it doesn't
 * need to be re-rendered from the PDF on every library visit. Best-effort:
 * callers should treat failures as non-fatal, since the worst case is just
 * falling back to the placeholder initial on the library card.
 * @param {string} fileId
 * @param {Blob} blob
 */
async function putThumbnail(fileId, blob) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(THUMB_STORE_NAME, 'readwrite');
    tx.objectStore(THUMB_STORE_NAME).put(blob, fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieve a previously cached cover thumbnail, or null if none exists yet
 * (e.g. the comic hasn't been opened for the first time) / on error.
 * @param {string} fileId
 * @returns {Promise<Blob|null>}
 */
async function getThumbnail(fileId) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE_NAME, 'readonly');
      const req = tx.objectStore(THUMB_STORE_NAME).get(fileId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Remove a cached thumbnail, e.g. when the comic is removed from the
 * library.
 * @param {string} fileId
 */
async function deleteThumbnail(fileId) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE_NAME, 'readwrite');
      tx.objectStore(THUMB_STORE_NAME).delete(fileId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort cleanup; ignore failures
  }
}

export {
  putBlob, getBlob, deleteBlob, totalCachedBytes, hasBlob,
  putThumbnail, getThumbnail, deleteThumbnail,
};
