// js/reader.js
// Client-side CBZ unzipping. A CBZ is just a ZIP of images in read order,
// so we sort entries naturally (page2 before page10) and hand back a list
// of object URLs the <img> can point straight at.

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

/**
 * @param {Blob} blob  Raw CBZ file bytes
 * @returns {Promise<{pages: string[], entryNames: string[], revoke: () => void}>}
 */
async function openCbz(blob) {
  // JSZip is loaded globally via CDN script tag (see index.html)
  const zip = await JSZip.loadAsync(blob);

  const imageEntries = Object.values(zip.files)
    .filter((f) => !f.dir && IMAGE_EXT.test(f.name) && !isJunkPath(f.name))
    .sort((a, b) => naturalCompare(a.name, b.name));

  if (imageEntries.length === 0) {
    throw new Error('No image pages found inside this CBZ.');
  }

  const pages = [];
  const entryNames = [];
  for (const entry of imageEntries) {
    const data = await entry.async('blob');
    pages.push(URL.createObjectURL(data));
    entryNames.push(entry.name);
  }

  return {
    pages,
    entryNames,
    revoke() {
      pages.forEach((url) => URL.revokeObjectURL(url));
    },
  };
}

function isJunkPath(name) {
  return name.startsWith('__MACOSX/') || name.split('/').pop().startsWith('.');
}

// Natural sort so "page2.jpg" comes before "page10.jpg"
function naturalCompare(a, b) {
  const chunk = (s) => s.match(/(\d+|\D+)/g) || [];
  const ac = chunk(a);
  const bc = chunk(b);
  const len = Math.max(ac.length, bc.length);
  for (let i = 0; i < len; i++) {
    const x = ac[i] ?? '';
    const y = bc[i] ?? '';
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export { openCbz };
