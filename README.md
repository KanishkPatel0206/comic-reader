# Gutter — a Drive-backed PDF comic reader

Static, client-only comic reader. No backend, no build step. It fetches
`.pdf` files straight from Google Drive using `alt=media` and renders each
page in the browser with [pdf.js](https://mozilla.github.io/pdf.js/).

## 1. Get a Drive API key

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) a project and enable the **Google Drive API**.
2. Create an **API key** under *APIs & Services → Credentials*.
3. Restrict it:
   - **API restrictions** → restrict key to **Google Drive API** only.
   - **Application restrictions** → HTTP referrers → add the origin you'll
     serve this app from (e.g. `http://localhost:8080/*`, or your GitHub
     Pages URL).

This is a public browser key by design (that's how `alt=media` works
without OAuth), so the referrer + API restriction is what keeps it from
being abused elsewhere — don't skip it.

## 2. Share your comics

Each PDF file in Drive needs its sharing setting set to **"Anyone with the
link"** (Viewer is enough). The app never signs the user in, so a file that
requires sign-in will fail with a 403.

To add a comic, open it in Drive, "Share → Copy link". You can paste
either the whole link or just the file ID — the app will pull the ID out
of a full link for you:

```
https://drive.google.com/file/d/1AbCDeFGhIJkLmnOPqrsTUVwxyz1234/view
                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ this part
```

## 3. Run it

Any static file server works — Drive's CORS response won't allow
`file://`, so serve it over http:

```bash
cd comic-reader
python3 -m http.server 8080
# open http://localhost:8080
```

Then in the app: paste your API key under "Drive API key", paste a file ID
or share link + optional title, and hit "Add to library".

## Project structure

```
comic-reader/
├── index.html          # library + reader screens
├── manifest.json        # PWA manifest
├── sw.js                 # service worker: precaches app shell for install/offline
├── icons/                 # PWA icons (192/512/maskable/apple-touch)
├── css/
│   └── styles.css
└── js/
    ├── drive-api.js      # fetchFileBlob / fetchFileMeta / listPdfInFolder
    ├── library.js         # localStorage-backed library + settings + progress + series grouping
    ├── blob-store.js       # IndexedDB-backed persistent PDF blob cache
    ├── pdf-reader.js         # pdf.js render -> ordered page object URLs
    └── app.js                 # screen wiring / event handlers
```

## What's implemented so far

- `fetchFileBlob(fileId, apiKey, onProgress)` — streams a file's bytes from
  Drive via `alt=media`, with optional download-progress callback.
- `fetchFileMeta` — validates a file ID and pulls its name/size/mimeType
  before adding it to the library, and warns if Drive doesn't report the
  file as a PDF.
- `listPdfInFolder` — helper to list `.pdf` files in a Drive folder (not
  yet wired into the UI — useful if you want a "browse folder" flow instead
  of pasting file IDs one at a time).
- Library manager: add/remove comics, persisted in `localStorage`, no
  server.
- Reader: client-side PDF rendering via pdf.js, one JPEG per page, tap-
  left/right or arrow-key page turning, remembers last page read per comic.
- Add-comic field accepts a bare file ID or a full `drive.google.com/file/d/.../view`
  link.
- **Persistent PDF cache (`js/blob-store.js`)** — the first time a comic is
  opened or downloaded, its raw PDF bytes are written to IndexedDB, keyed
  by Drive file ID. Every subsequent open/download for that comic reads
  from IndexedDB instead of re-fetching from Drive — this survives page
  reloads and browser restarts, unlike the plain in-memory cache. A small
  green checkmark badge appears on a library card once it's cached this
  way.
- **Download to device** — a download button on each library card (and
  in the reader top bar) fetches the PDF (reusing the IndexedDB cache when
  available) and triggers a native browser download to the device's
  Downloads folder via a blob URL. This is a *separate* copy from the
  IndexedDB cache — it's a plain file on disk that the app can't read back
  in, since browsers don't allow websites to access arbitrary files in the
  Downloads folder. If you want the app itself to avoid re-fetching, that's
  what the IndexedDB cache above is for.
- **Fully offline PDFs, no Drive at all (`Add PDF from this device`)** — a
  file picker on the library screen lets you import a PDF straight from
  your device's storage (e.g. one you already downloaded via the button
  above, or copied over another way). No Drive API key, no network call,
  no file ID — the raw bytes go directly into the IndexedDB cache and the
  comic is readable immediately and on every future visit, fully offline.
  These show an "on device" tag on their card. Because there's no Drive
  copy backing them up, if the browser ever clears its storage (e.g. very
  aggressive private-browsing cleanup, or manually clearing site data) that
  comic is gone and needs to be re-imported — there's no re-fetch fallback,
  unlike Drive-backed comics.
- **Offline indicator** — a small "Offline" badge appears in the library
  header whenever `navigator.onLine` reports no connection, as a reminder
  that adding new Drive comics won't work right now, while already-cached
  and locally-imported comics still read fine.
- **Installable PWA (`sw.js` + `manifest.json` + `icons/`)** — a service
  worker precaches the app shell (HTML/CSS/JS and pdf.js from the CDN) on
  first load. This makes Gutter installable: Chrome/Edge on desktop show
  an install icon in the address bar, and "Add to Home Screen" on
  Android/iOS puts a real app icon on the device that opens in
  `standalone` display mode (no browser chrome). The service worker only
  caches the app's own code — it never touches Drive API responses, so it
  can't cause a stale/expired-file issue when reading comics.

- **Series folders (`js/library.js`: `groupBySeries`)** — comics that
  belong to the same series are automatically combined into one folder on
  the library grid instead of cluttering it as separate cards. Grouping is
  derived from each comic's title by stripping a trailing volume/chapter/
  issue/book/part marker (`Vol. 3`, `Chapter 12`, `Bk 2`, `#7`, `Part III`,
  etc.) — e.g. "Saga Vol. 1", "Saga Vol. 2", and "Saga #10" all fold into
  one **Saga** folder. Opening a folder filters the grid down to *only*
  that series' volumes/chapters, sorted by the number in their title, with
  a breadcrumb back to the full library. A series only becomes a folder
  once it has 2+ comics — a lone issue stays a normal standalone card
  until a second one shows up. If the title-based guess is wrong (or you
  want to combine comics whose titles don't share a common prefix), the 🏷
  button on any card lets you set its series manually, which overrides
  auto-detection and can merge it into an existing folder or split it out
  of one.
- **Storage usage + clear cache** — a "Storage" panel in settings shows
  total bytes cached in IndexedDB and a "Free up space" button. It only
  clears Drive-backed comics (they simply re-download next time they're
  opened) — device-imported comics are left alone since IndexedDB is their
  only copy.

## Not yet done / natural next steps

- `listPdfInFolder` isn't wired to a "browse folder" UI — this would let
  you point Gutter at your Ultimate Spider-man folder instead of adding
  issues one at a time.
- No thumbnail covers — currently a plain initial-letter placeholder;
  a real page-1 thumbnail could be generated client-side from the first
  rendered page and cached.
- Large PDFs render every page up front before the reader opens, which can
  be slow for long runs. A lazy/on-demand render-as-you-go mode would fix
  that but adds complexity.
