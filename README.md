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
├── css/
│   └── styles.css
└── js/
    ├── drive-api.js      # fetchFileBlob / fetchFileMeta / listPdfInFolder
    ├── library.js         # localStorage-backed library + settings + progress
    ├── pdf-reader.js       # pdf.js render -> ordered page object URLs
    └── app.js               # screen wiring / event handlers
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

## Not yet done / natural next steps

- Service worker (offline shell caching) — manifest is in place but there's
  no `sw.js` yet.
- `listPdfInFolder` isn't wired to a "browse folder" UI — this would let
  you point Gutter at your Ultimate Spider-man folder instead of adding
  issues one at a time.
- No thumbnail covers — currently a plain initial-letter placeholder;
  a real page-1 thumbnail could be generated client-side from the first
  rendered page and cached.
- Large PDFs render every page up front before the reader opens, which can
  be slow for long runs. A lazy/on-demand render-as-you-go mode would fix
  that but adds complexity.
