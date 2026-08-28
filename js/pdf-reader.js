// js/pdf-reader.js
// Opens a PDF (fetched as a Blob from Drive, or from a local import) and
// renders pages to JPEG on demand rather than all at once up front. On a
// long or high-res comic, rendering every page before the reader opens
// could take a long time; lazy rendering means the reader opens as soon
// as the PDF document itself is parsed, and each page renders the moment
// it's actually needed (plus a couple pages of read-ahead prefetch).

const PAGE_TARGET_WIDTH = 1600; // render at roughly this pixel width for crisp screens
const MIN_SCALE = 1;
const MAX_SCALE = 3;

/**
 * @param {Blob} blob  Raw PDF file bytes
 * @returns {Promise<{
 *   numPages: number,
 *   entryNames: string[],
 *   getPage: (pageNum: number) => Promise<string>,
 *   prefetch: (pageNum: number) => void,
 *   revoke: () => void,
 * }>}
 */
async function openPdf(blob) {
  if (!window.pdfjsLib) {
    throw new Error('PDF engine failed to load. Check your connection and reload.');
  }

  const buffer = await blob.arrayBuffer();
  let pdf;
  try {
    pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  } catch {
    throw new Error("Couldn't read this as a PDF. Double-check the file isn't corrupted or actually some other format.");
  }

  const numPages = pdf.numPages;
  if (numPages === 0) {
    throw new Error('This PDF has no pages.');
  }

  const entryNames = Array.from({ length: numPages }, (_, i) => `page-${String(i + 1).padStart(3, '0')}`);

  // Object URLs for pages already rendered, keyed by 1-based page number.
  const urlCache = new Map();
  // In-flight render promises, so a prefetch and an on-screen request for
  // the same page share one render instead of racing to render it twice.
  const pending = new Map();

  async function renderPage(pageNum) {
    if (urlCache.has(pageNum)) return urlCache.get(pageNum);
    if (pending.has(pageNum)) return pending.get(pageNum);

    const job = (async () => {
      const page = await pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, PAGE_TARGET_WIDTH / baseViewport.width));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;
      const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      const url = URL.createObjectURL(imageBlob);

      urlCache.set(pageNum, url);
      page.cleanup();
      return url;
    })();

    pending.set(pageNum, job);
    try {
      return await job;
    } finally {
      pending.delete(pageNum);
    }
  }

  /**
   * Render a page in the background without making the caller wait —
   * used for read-ahead. Out-of-range page numbers and errors are
   * silently ignored, since a failed prefetch just means the page
   * renders on-demand instead when the reader actually reaches it.
   */
  function prefetch(pageNum) {
    if (pageNum < 1 || pageNum > numPages) return;
    renderPage(pageNum).catch(() => {});
  }

  /**
   * Render page 1 at low resolution for use as a library-card preview.
   * Independent of the full-res urlCache above — this returns a Blob
   * (not an object URL) so the caller can persist it to IndexedDB, and
   * uses a much smaller target width since it's just a thumbnail.
   * @param {number} [maxWidth]
   * @returns {Promise<Blob|null>}
   */
  async function renderThumbnail(maxWidth = 320) {
    try {
      const page = await pdf.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(1, maxWidth / baseViewport.width);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
      page.cleanup();
      return blob;
    } catch {
      return null;
    }
  }

  return {
    numPages,
    entryNames,
    getPage: renderPage,
    prefetch,
    renderThumbnail,
    revoke() {
      urlCache.forEach((url) => URL.revokeObjectURL(url));
      urlCache.clear();
      pending.clear();
    },
  };
}

export { openPdf };
