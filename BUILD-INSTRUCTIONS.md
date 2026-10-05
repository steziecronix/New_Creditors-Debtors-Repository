# Building the Windows installer

Run these on an actual Windows machine (or a Windows CI runner) with internet
access — better-sqlite3 needs to compile/fetch a native Windows binary, and
that can't be cross-built from Linux reliably.

## 1. Prerequisites
- Node.js 20 or 22 (match what's in package.json's engines if you add one)
- Windows Build Tools for native modules:
    npm install --global windows-build-tools
  (or install Visual Studio Build Tools with the "Desktop development with C++" workload)

## 2. Install & build
    npm install
    npm run dist

electron-builder will:
  - download the Electron binary + winCodeSign/nsis tooling (first run only, needs internet)
  - compile better-sqlite3's native addon for win32/x64
  - package main.js, preload.js, renderer/, licensing/, db/ per the "files" list in package.json
  - produce release/Paul Enterprises POS Setup 1.0.0.exe (per build.directories.output)

## 3. Sanity-check before shipping
    npm test
  runs test-main.js + licensing/test-machine-id.js + licensing/test-validate-key.js.

## Code signing (before reselling)

electron-builder auto-signs when it finds these environment variables — no
extra package.json config needed beyond what's already there:

    set CSC_LINK=C:\path\to\your-cert.pfx
    set CSC_KEY_PASSWORD=your-cert-password
    npm run dist

What you need to get first:
  - A code-signing certificate from a CA (Sectigo, DigiCert, SSL.com, etc.),
    issued to "Paul Enterprises" (or your registered business name).
  - A standard OV cert works but new Windows installs will still show a
    SmartScreen warning until the cert builds up reputation. An EV
    (Extended Validation) cert avoids that immediately but costs more and
    requires a hardware token / HSM.
  - Self-signed certs will NOT remove the SmartScreen warning for end users
    — they only help if you separately distribute your own root cert, which
    isn't practical for reselling.

Once signed, run `signtool verify /pa` (from the Windows SDK) on the .exe to
confirm the signature is valid before shipping.
