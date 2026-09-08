# Safe verification and acceptance boundaries

## Automated, no real user capabilities

```sh
nvm use
npm ci
npm run check
npm run lint
npm test
npm run test:ui
```

If an npm installation policy skips Electron's binary install script, run
`ELECTRON_CACHE="$PWD/.cache/electron" node node_modules/electron/install.js`.
Playwright uses that pinned Electron binary; no separate browser download is
needed. The UI harness imports the real renderer, browser-safe session controller
and production preload, not a lookalike page. Its separate main uses a temporary
userData directory, fake host IPC/media/peers, and denied network/OS permissions.
Do not launch `npm start` for automated preview: production can read Keychain.

Behavioral coverage includes credential save/update/restart/locked storage,
corruption/integrity failure, legacy precedence, cancellation at asynchronous
media/token/SDP stages, transport readiness, route rollback, failed selected
outputs, vanished selections, 50 connection cycles, scoped output/queued action
cancellation, process-group descendant cleanup, bounded buffers/logger queue,
frame coalescing, keyboard approval/deadline/focus, and hidden-window transport.
Existing helper, tool-pairing, display-media and renderer graph regressions remain.

The harness writes reproducible screenshots to `.artifacts/screenshots/` and its
report to `.artifacts/ui-results/`. At 200% zoom, screenshots use Electron native
`capturePage()` (top and scrolled-caption viewports), with bitmap dimensions
checked against CSS viewport width × effective devicePixelRatio. Playwright
`fullPage` can crop a zoomed Electron surface and is not used as zoom evidence.
These outputs, caches and packages are ignored.
A fake-media pass proves lifecycle/UI contracts, not real audio quality/permissions.

## Unsigned packaging (does not launch the app)

```sh
export CSC_IDENTITY_AUTO_DISCOVERY=false
export ELECTRON_CACHE="$PWD/.cache/electron"
export ELECTRON_BUILDER_CACHE="$PWD/.cache/electron-builder"
npm run build:smoke
# Intel directory package:
npx --no-install electron-builder --mac --dir --x64 -c.mac.identity=null
# Both DMG/ZIP architectures (larger downloads/artifacts):
npm run dist:mac
```

Packaging requests macOS 13+ and preserves `com.mitre.codex-voice-bridge`, product
name and userData identity. A cross-built Intel package on an arm64 host is NOT
native Intel runtime proof. CI uses explicit macOS15 arm64/Intel runners; it does
not prove minimum macOS13 support. Signed/notarized release work is not automated
by this change, and unsigned builds cannot prove Keychain identity across upgrades.

## Manual acceptance — separate authorization required

- Native macOS13 on Intel and Apple Silicon, including launch from Finder.
- Signed first save, update, restart and upgrade across signatures/Keychain locks.
- Microphone allow/deny/revoke and cancellation while a real OS prompt remains open.
- Screen/meeting audio capability on each OS; virtual input on older macOS.
- Two interview routes with headphones/virtual output, unplugging each selected
  device, unsupported/rejected output selection, and explicit fallback consent.
- Real Codex/CUA authentication/permissions and output from an owned test workspace.
- Measured baseline/candidate CPU, RSS and startup with the same Electron44 binary,
  visibility state and workload. No percentage improvement is asserted without
  paired measurements. Audio quality/latency requires a real, authorized session.

## Limits (units are intentional)

- Process stdout and stderr: tails of **1,048,576 characters each**, plus marker.
- Log file: **2 MiB**, one `.1` backup; pending logger queue: **2 MiB** in bytes.
- Caption/debug display: **50,000 characters** each, including truncation marker.
- Approval argument preview: **20,000 characters** plus truncation notice; original
  arguments remain subject to the main-process validation and are not rewritten.

## Selective prior work

The voice allowlist/normalization behavior from PR #4 was reused selectively.
PR #1's parallel interview and separate recovery-banner ideas and PR #3's bounded
output/visibility concepts were reimplemented around one resource owner and one
shared tail accumulator. No whole PR was merged, no duplicate buffer pipeline was
added, and the unrelated cloud setup from PR #2 was excluded.
