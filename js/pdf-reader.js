// js/pdf-reader.js
// Opens a PDF (fetched as a Blob from Drive) for lazy, page-by-page
// rendering: pages are only rasterized to JPEG when actually requested,
// with the next couple of pages prefetched in the background so turning
// the page usually finds it already rendered.
//
// Also exposes renderThumbnail(), a lightweight standalone render of just
// page 1 at low resolution, used for library cover art.

const PAGE_TARGET_WIDTH = 1600; // render at roughly this pixel width for crisp screens
const THUMB_TARGET_WIDTH = 300; // low-res, just enough for a library card cover
const MIN_SCALE = 1;
const MAX_SCALE = 3;
const PREFETCH_AHEAD = 2; // how many pages beyond the current one to warm in the background

// Renders a single pdf.js page object to a JPEG Blob at roughly targetWidth
// pixels wide (falls back to native scale if targetWidth is falsy).
async function renderPageToBlob(page, targetWidth, quality) {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth
    ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetWidth / baseViewport.width))
    : 1;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function assertPdfEngine() {
  if (!window.pdfjsLib) {
    throw new Error('PDF engine failed to load. Check your connection and reload.');
  }
}

async function loadPdfDocument(blob) {
  assertPdfEngine();
  const buffer = await blob.arrayBuffer();
  try {
    return await window.pdfjsLib.getDocument({ data: buffer }).promise;
  } catch {
    throw new Error("Couldn't read this as a PDF. Double-check the file isn't corrupted or actually some other format.");
  }
}

/**
 * Renders just page 1 at low resolution — cheap enough to run right after
 * a comic is first opened, without holding up the reader.
 * @param {Blob} blob  Raw PDF file bytes
 * @param {number} [targetWidth]
 * @returns {Promise<Blob>} JPEG blob suitable for caching/display as a cover
 */
async function renderThumbnail(blob, targetWidth = THUMB_TARGET_WIDTH) {
  const pdf = await loadPdfDocument(blob);
  try {
    const page = await pdf.getPage(1);
    const thumb = await renderPageToBlob(page, targetWidth, 0.7);
    page.cleanup();
    return thumb;
  } finally {
    pdf.destroy().catch(() => {});
  }
}

/**
 * Opens a PDF for reading without rendering any pages up front — only the
 * document structure is parsed, so this resolves almost instantly even for
 * long/high-res comics. Individual pages are rendered on demand via
 * getPage(), with the next couple of pages prefetched in the background
 * after each call.
 * @param {Blob} blob  Raw PDF file bytes
 * @returns {Promise<{
 *   numPages: number,
 *   getPage: (index:number) => Promise<string>,
 *   revoke: () => void,
 * }>}
 */
async function openPdfSession(blob) {
  const pdf = await loadPdfDocument(blob);

  const numPages = pdf.numPages;
  if (numPages === 0) {
    pdf.destroy().catch(() => {});
    throw new Error('This PDF has no pages.');
  }

  const urlCache = new Array(numPages).fill(null); // index -> object URL, once rendered
  const inFlight = new Map(); // index -> in-progress render promise
  let closed = false;

  // Renders (or returns the already-rendered/in-progress) object URL for a
  // single page index. Shared by both getPage() and the prefetcher so a
  // page is never rendered twice.
  function renderIndex(index) {
    if (urlCache[index]) return Promise.resolve(urlCache[index]);
    if (inFlight.has(index)) return inFlight.get(index);

    const job = (async () => {
      const page = await pdf.getPage(index + 1);
      const imgBlob = await renderPageToBlob(page, PAGE_TARGET_WIDTH, 0.9);
      page.cleanup();
      // The session may have been revoked while this render was in
      // flight (e.g. the reader was closed mid-prefetch) — don't leak an
      // object URL nobody will ever revoke.
      if (closed) return null;
      const url = URL.createObjectURL(imgBlob);
      urlCache[index] = url;
      return url;
    })();

    inFlight.set(index, job);
    job.finally(() => inFlight.delete(index));
    return job;
  }

  // Kicks off background rendering for the next couple of pages so they're
  // usually ready by the time the reader turns to them. Failures here are
  // silent — the page will simply be rendered (and any error surfaced) on
  // demand if/when the reader actually reaches it.
  function prefetch(fromIndex) {
    for (let i = fromIndex + 1; i <= fromIndex + PREFETCH_AHEAD && i < numPages; i++) {
      renderIndex(i).catch(() => {});
    }
  }

  async function getPage(index) {
    if (index < 0 || index >= numPages) {
      throw new Error('Page out of range.');
    }
    const url = await renderIndex(index);
    if (closed) throw new Error('Reader was closed.');
    prefetch(index);
    return url;
  }

  function revoke() {
    closed = true;
    urlCache.forEach((url) => url && URL.revokeObjectURL(url));
    pdf.destroy().catch(() => {});
  }

  return { numPages, getPage, revoke };
}

export { openPdfSession, renderThumbnail };
