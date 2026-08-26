## Install

Download **`File Warper-<version>-arm64.dmg`** below, open it, and drag File Warper to Applications.

Apple Silicon only (M1 and newer), macOS 12 or later.

### First launch: macOS will block it

This app is **ad-hoc signed but not notarized**, because notarization requires a
paid Apple Developer account. macOS therefore refuses to open it on first launch
with a message like *"Apple could not verify File Warper is free of malware."*

That warning is about the absence of an Apple-issued signature, not about
anything found in the app. To open it anyway:

1. Try to open File Warper once (it will be blocked).
2. Go to **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to the File Warper message.
3. Confirm. macOS remembers the choice — you only do this once.

If that entry does not appear, remove the download quarantine flag from
Terminal instead:

```bash
xattr -dr com.apple.quarantine "/Applications/File Warper.app"
```

> On macOS 15 (Sequoia) and later, right-click → Open no longer bypasses this.
> Use System Settings, or the `xattr` command above.

Don't want to trust a stranger's binary? Fair. Build it yourself:

```bash
git clone https://github.com/lucamanuel06/file-warper
cd file-warper && npm ci && npm run dist
```

### What's in the box

Conversions run entirely on your machine. No account, no upload, no telemetry —
your files never leave the Mac. It bundles its own `ffmpeg`, `ffprobe` and
`7za`, which is why the download is around 220 MB.

The one exception: if *Check for updates automatically* is on (it is by
default), the app asks GitHub once a day whether a newer release exists. That
request carries nothing about you or your files, and the setting turns it off
completely.

Every release is cut from a tagged commit and only goes out after the packaged
app has passed lint, typecheck, the full test suite, and an end-to-end test
that converts a real file using the bundled binaries. The GitHub Actions
workflow does this automatically; when a macOS runner is unavailable the same
gates are run locally before publishing.
