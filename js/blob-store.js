// js/blob-store.js
// Persists raw PDF bytes in IndexedDB, keyed by Drive file ID, so a comic
// that's already been fetched once doesn't need to be re-downloaded from
// Drive on every visit. localStorage can't hold binary blobs of this size
// (and has a ~5MB ceiling); IndexedDB has no such practical limit and is
// built for exactly this.

const DB_NAME = 'comicreader.blobs.v1';
const STORE_NAME = 'pdfs';
const THUMB_STORE_NAME = 'thumbs';
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
        db.createObjectStore(THUMB_STORE_NAME); // small page-1 preview JPEGs, keyed by fileId
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
 * Delete cached blobs in bulk, used by the "Clear cache" control in
 * Settings. Any fileId in `keepIds` is left untouched — this protects
 * locally-imported comics, whose IndexedDB entry is their *only* copy,
 * from being wiped out by a control that's meant to reclaim space from
 * re-fetchable Drive caches.
 * @param {Iterable<string>} [keepIds]
 * @returns {Promise<number>} number of entries actually deleted
 */
async function clearBlobs(keepIds = []) {
  const keep = new Set(keepIds);
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();
      let deleted = 0;
      req.onsuccess = () => {
        (req.result || []).forEach((key) => {
          if (!keep.has(key)) {
            store.delete(key);
            deleted += 1;
          }
        });
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return 0;
  }
}

export { putBlob, getBlob, deleteBlob, totalCachedBytes, hasBlob, clearBlobs, putThumbnail, getThumbnail, deleteThumbnail };

/**
 * Store a small page-1 preview JPEG for a comic's library card. Kept in a
 * separate object store from the full PDF blobs — thumbnails are tiny
 * (tens of KB) and deliberately untouched by clearBlobs()/"Clear cache",
 * so the library stays scannable even right after a cache purge.
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
