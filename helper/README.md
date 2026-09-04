# BFF Booth Helper

The printer-side desktop app. It does exactly what `npm run agent` does
(`../server/agent.js`), but wrapped so the operator never opens a terminal:

1. Download and open it on the computer with the printer.
2. Enter the booth's web address and the **pairing code** shown on the host
   screen (Printer ▸ *Connect a printer*).
3. Click **Connect**. It prints the queue as guests submit, and lives in the
   menu bar / tray.

It makes only outbound HTTPS calls to the relay — no open ports on the printer
computer — and reuses the same pairing + printing code as the CLI agent, so
there is one source of truth.

## Develop

```bash
cd helper
npm install
RELAY_URL=… npm start        # opens the app against a dev relay
```

The app forks `../server/agent.js` as a Node child with the right env; in a
packaged build those files are bundled under the app's resources.

## Build installers

CI does this on tag `helper-v*` (see `.github/workflows/helper-release.yml`) —
GitHub's macOS and Windows runners produce **unsigned** installers named
`BFF-Booth-Helper.dmg` and `BFF-Booth-Helper-Setup.exe` (the names the host
screen links to) and attach them to the matching Release.

Locally:

```bash
cd helper
npm install
npm run dist:mac    # or dist:win on Windows
```

## Signing (later)

Unsigned apps show a one-time warning on first launch (macOS: right-click ▸
Open; Windows: More info ▸ Run anyway). To remove it, add an Apple Developer ID
certificate (macOS notarization) and/or a Windows Authenticode certificate as CI
secrets and drop `CSC_IDENTITY_AUTO_DISCOVERY=false`. No code changes needed.

## Platform note

Printing uses CUPS (`lp`/`lpstat`), so macOS works out of the box. Windows needs
a different print backend in `../server/cups.js` before the Windows build prints;
the app builds and connects on Windows today but the print path is macOS-first.
