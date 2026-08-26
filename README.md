# Gutter — a Drive-backed CBZ reader

Static, client-only comic reader. No backend, no build step. It fetches
`.cbz` files straight from Google Drive using `alt=media` and unzips /
renders them in the browser with JSZip.

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

Each CBZ file in Drive needs its sharing setting set to **"Anyone with the
link"** (Viewer is enough). The app never signs the user in, so a file that
requires sign-in will fail with a 403.

To add a comic, open it in Drive, "Share → Copy link", and pull the file ID
out of the URL:

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
+ optional title, and hit "Add to library".

## Project structure

```
comic-reader/
├── index.html          # library + reader screens
├── manifest.json        # PWA manifest
├── css/
│   └── styles.css
└── js/
    ├── drive-api.js      # fetchFileBlob / fetchFileMeta / listCbzInFolder
    ├── library.js         # localStorage-backed library + settings + progress
    ├── reader.js           # JSZip unzip -> ordered page object URLs
    └── app.js               # screen wiring / event handlers
```

## What's implemented so far

- `fetchFileBlob(fileId, apiKey, onProgress)` — streams a file's bytes from
  Drive via `alt=media`, with optional download-progress callback.
- `fetchFileMeta` — validates a file ID and pulls its name/size before
  adding it to the library.
- `listCbzInFolder` — helper to list `.cbz` files in a Drive folder (not
  yet wired into the UI — useful if you want a "browse folder" flow instead
  of pasting file IDs one at a time).
- Library manager: add/remove comics, persisted in `localStorage`, no
  server.
- Reader: client-side unzip via JSZip, natural page sort (`page2` before
  `page10`), tap-left/right or arrow-key page turning, remembers last page
  read per comic.

## Not yet done / natural next steps

- Service worker (offline shell caching) — manifest is in place but there's
  no `sw.js` yet.
- `listCbzInFolder` isn't wired to a "browse folder" UI.
- No thumbnail covers — currently a plain initial-letter placeholder;
  Drive's `thumbnailLink` needs OAuth (not a bare API key) so this would
  need either an `<img>` with the key appended where Drive allows it, or a
  first-page-of-the-CBZ thumbnail generated client-side instead.
- No RAR/CBR support (by design — CBZ/ZIP only, per your constraint).
