## Install

Pick the download for your platform below.

### macOS — `.dmg`

Download **`File Warper-<version>-arm64.dmg`** (Apple Silicon) or the `x64`
build (Intel), open it, and drag File Warper to Applications. macOS 12 or
later.

**First launch: macOS will block it.** This app is **ad-hoc signed but not
notarized**, because notarization requires a paid Apple Developer account.
macOS therefore refuses to open it on first launch with a message like *"Apple
could not verify File Warper is free of malware."*

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

### Windows — `.exe`

Download the **`File Warper Setup <version>.exe`** installer and run it. A
**portable** `.exe` is also provided if you'd rather not install anything —
just download and double-click it to run.

**SmartScreen will warn you.** Windows will show *"Windows protected your
PC"* because this build is **not signed with a paid Authenticode
certificate**, not because anything was detected. Click **More info → Run
anyway** to continue.

### Linux — `.AppImage` or `.deb`

**AppImage** (works on most distros):

```bash
chmod +x File-Warper-<version>.AppImage
./File-Warper-<version>.AppImage
```

Some distros need `libfuse2` installed for AppImages to run — if it fails to
launch, install FUSE for your distro and try again.

**Debian/Ubuntu package:**

```bash
sudo dpkg -i file-warper_<version>_amd64.deb
```

### Don't want to trust a stranger's binary?

Fair. Build it yourself:

```bash
git clone https://github.com/lucamanuel06/file-warper
cd file-warper && npm ci && npm run dist
```

### What's in the box

Conversions run entirely on your machine. No account, no upload, no telemetry —
your files never leave your computer. It bundles its own `ffmpeg`, `ffprobe`
and `7za`.

The one exception: if *Check for updates automatically* is on (it is by
default), the app asks GitHub once a day whether a newer release exists. That
request carries nothing about you or your files, and the setting turns it off
completely.

Every release is cut from a tagged commit and only goes out after the packaged
app has passed lint, typecheck, the full test suite, and an end-to-end test
that converts a real file using the bundled binaries, on macOS, Windows and
Linux. The GitHub Actions workflow does this automatically.
