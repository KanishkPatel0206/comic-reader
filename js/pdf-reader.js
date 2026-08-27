// js/pdf-reader.js
// Renders each page of a PDF (fetched as a Blob from Drive) to a JPEG,
// so the rest of the app can treat it exactly like a CBZ's unpacked pages —
// same {pages, entryNames, revoke} shape as the old reader.js.

const PAGE_TARGET_WIDTH = 1600; // render at roughly this pixel width for crisp screens
const MIN_SCALE = 1;
const MAX_SCALE = 3;

/**
 * @param {Blob} blob  Raw PDF file bytes
 * @param {(rendered:number, total:number)=>void} [onProgress]
 * @returns {Promise<{pages: string[], entryNames: string[], revoke: () => void}>}
 */
async function openPdf(blob, onProgress) {
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

  const total = pdf.numPages;
  if (total === 0) {
    throw new Error('This PDF has no pages.');
  }

  const pages = [];
  const entryNames = [];

  for (let i = 1; i <= total; i++) {
    const page = await pdf.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, PAGE_TARGET_WIDTH / baseViewport.width));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    pages.push(URL.createObjectURL(imageBlob));
    entryNames.push(`page-${String(i).padStart(3, '0')}`);

    page.cleanup();
    onProgress?.(i, total);
  }

  return {
    pages,
    entryNames,
    revoke() {
      pages.forEach((url) => URL.revokeObjectURL(url));
    },
  };
}

export { openPdf };
