# Codex Voice Bridge

```
 ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗   ██╗   ██╗ ██████╗ ██╗ ██████╗ ███████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝   ██║   ██║██╔═══██╗██║██╔═══██╗██╔════╝
██║     ██║   ██║██║  ██║█████╗   ╚███╔╝    ██║   ██║██║   ██║██║██║   ██║███████╗
██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗    ╚██╗ ██╔╝██║   ██║██║██║   ██║╚════██║
╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗    ╚████╔╝ ╚██████╔╝██║╚██████╔╝███████║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝     ╚═══╝   ╚═════╝ ╚═╝ ╚═════╝ ╚══════╝
 ██████╗ ██████╗ ██╗   ██╗██╗██████╗  ██████╗ ███████╗    ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
██╔════╝ ██╔══██╗██║   ██║██║██╔══██╗██╔════╝ ██╔════╝    ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
██║  ███╗██████╔╝██║   ██║██║██║  ██║██║  ███╗█████╗      ██████╔╝██████╔╝██║██████╔╝██║  ███╗█████╗
██║   ██║██╔══██╗██║   ██║██║██║  ██║██║   ██║██╔══╝      ██╔══██╗██╔══██╗██║██╔═══╝ ██║   ██║██╔══╝
╚██████╔╝██████╔╝╚██████╔╝██║██████╔╝╚██████╔╝███████╗    ██████╔╝██║  ██║██║██║     ╚██████╔╝███████╗
 ╚═════╝ ╚═════╝  ╚═════╝ ╚═╝╚═════╝  ╚═════╝ ╚══════╝    ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝     ╚═════╝ ╚══════╝
```

**Local macOS voice layer for OpenAI Realtime, Codex CLI, CUA Driver, and live interview translation.**

Talk to your Mac. It listens, speaks, inspects your code with Codex CLI, operates your apps through CUA Driver, and translates English interviews in real time — in a local desktop app, with your own OpenAI API key. Audio and selected tool output are sent to OpenAI; inference is not on-device.

> Named after Samantha — the AI from *Her*. The assistant speaks through OpenAI Realtime with reasoning, tool calls, and a voice you can choose.

---

## Features

| Mode | What it does |
|------|--------------|
| **Assistant** | Conversational voice agent (`gpt-realtime-2`) with reasoning and local tool calls |
| **Interview** | Bidirectional live interpreter — interviewer English → Spanish to you, your Spanish mic → English to the call |
| **Live translate** | One-way real-time speech translation (`gpt-realtime-translate`) |
| **Live captions** | Low-latency speech-to-text captions (`gpt-realtime-whisper`) |

### Voice agent tools

- `run_codex` — ask **Codex CLI** to inspect, summarize, or plan from a local project (read-only by default)
- `run_cua_driver` — inspect and operate macOS apps through **CUA Driver**
- `open_app` — visibly open or focus Safari, Chrome, Finder, Mail, Calendar, Messages, Slack, Spotify, Terminal and more; a bare http/https URL opens in the default browser
- `type_text_in_front_app` — type into the focused macOS app
- `press_key_in_front_app` — press keys in the focused macOS app

### Privacy & security first

- API key encrypted by **Electron async safeStorage**, with its encryption key protected by macOS Keychain; only ciphertext is written to the app data directory
- Codex CLI runs in a **read-only sandbox** by default
- CUA Driver tools are intentionally limited; unsafe tools are blocked
- Logs stay local at `~/Library/Logs/codex-voice-bridge/bridge.log` and rotate at 2 MiB (`bridge.log.1`); development uses `bridge-dev.log`

---

## Quick start

```bash
git clone https://github.com/mitre88/codex-voice-bridge.git
cd codex-voice-bridge
nvm use  # Node 24 (or activate Node 24 with your preferred manager)
npm ci
npm start
```

On first launch, paste your OpenAI API key into the app. A successful save is encrypted, read back, decrypted and compared before atomic replacement. If secure storage is locked or fails, the key remains usable in memory for this launch and a visible warning explains that it was **not saved**. Use **Change key** for an explicit replacement. Development and packaged builds use separate credential directories.

You can also provide the key via environment:

```bash
export OPENAI_API_KEY="sk-proj-..."
npm start
```

## Requirements

- macOS **13 or later**, Apple Silicon or Intel (separate arm64/x64 packages)
- Node.js **24** recommended for development; CI covers 22, 24 and 26
- npm
- An OpenAI API key with Realtime API access
- Optional: Codex CLI installed and authenticated — only for local coding-agent actions
- Optional: CUA Driver with the permissions needed for its requested action — only for app control; diagnostics never force a permission prompt
- Optional but recommended for Interview mode: **BlackHole 2ch** or **Loopback** for virtual audio routing

## Configuration

Environment variables (all optional):

```bash
export OPENAI_REALTIME_MODEL="gpt-realtime-2"               # assistant model
export OPENAI_REALTIME_TRANSLATE_MODEL="gpt-realtime-translate"
export OPENAI_REALTIME_TRANSCRIBE_MODEL="gpt-realtime-whisper"
export OPENAI_REALTIME_VOICE="marin"                        # assistant voice
export OPENAI_REALTIME_TONE="calm"                          # calm | direct | energetic
export OPENAI_REALTIME_REASONING_EFFORT="low"               # low | minimal | medium | high | xhigh
export OPENAI_REALTIME_TARGET_LANGUAGE="es"                 # es en fr de pt ja ko zh
# Optional absolute executable overrides (no login shell is evaluated):
export CODEX_VOICE_CODEX_PATH="/absolute/path/to/codex"
export CODEX_VOICE_CUA_DRIVER_PATH="/absolute/path/to/cua-driver"
export CODEX_VOICE_WORKDIR="/path/to/your/workspace"
export CODEX_VOICE_SHORTCUT="CommandOrControl+Shift+Space"   # global toggle shortcut
export CODEX_VOICE_TIMEOUT_MS="120000"                       # codex CLI timeout
export CODEX_VOICE_CUA_TIMEOUT_MS="60000"                    # cua-driver timeout
export CODEX_VOICE_OPENAI_TIMEOUT_MS="60000"                 # OpenAI HTTP timeout
export CODEX_VOICE_ACTION_TIMEOUT_MS="120000"                # auto-reject pending Run/Reject after N ms
export CODEX_VOICE_ALWAYS_ON_TOP="1"                         # "0" = window does not float above other apps
export CODEX_VOICE_ENV_FILE="/path/to/your/.env"             # load .env from a custom location (default: <cwd>/.env)
```

You can also put these in a `.env` file in the directory you launch from (see `.env.example`); it is loaded automatically on start. Variables already set in your shell always take precedence, and `CODEX_VOICE_ENV_FILE` can point to a `.env` elsewhere. Timeout values are validated — an invalid value falls back to the default instead of misbehaving.

---

## Voice modes

### Assistant

The main Samantha-style assistant. Uses `gpt-realtime-2`, speaks naturally, and can call local tools (`run_codex`, `run_cua_driver`, `open_app`, `type_text_in_front_app`, `press_key_in_front_app`). Codex runs in read-only mode by default.

### Interview

Bidirectional live interpreter for English job interviews. Recommended setup:

1. Use headphones.
2. Install BlackHole 2ch or Loopback.
3. In the app, choose `Interview`.
4. Set `Your mic` to your real microphone.
5. Set **Route 1 · Their English input** to an audio input device, or choose `Capture meeting audio` on a compatible OS. On macOS 13/14, use a virtual audio input; native meeting-audio capture depends on OS/runtime support and permissions.
6. Set **Route 1 · Spanish to your ears** to your headphones/default output.
7. Set **Route 2 · Your Spanish → English to call** to `BlackHole 2ch`.
8. In Zoom, Google Meet, Teams, or the interview app, select `BlackHole 2ch` as your microphone.

Both routes are prepared together and become active only when both peers and data channels are ready. A failed route rolls back both. A missing or rejected selected output never silently falls back to speakers; choose **Default output** explicitly if that is what you want. Without a virtual audio device the meeting cannot receive a digital English route. Speaker fallback can create feedback and compromise privacy.

**Cancel** immediately releases acquired tracks and peers, drops queued actions, and stops any later media grant before use. macOS may leave a permission prompt or picker open: the Web media APIs do not support cancelling that OS prompt. Disconnection, ended tracks and failed channels require an explicit **Retry**; the app never reopens the microphone automatically.

### Live Translate

One-way live translation using `gpt-realtime-translate`. Choose a target language (`es`, `en`, `fr`, `de`, `pt`, `ja`, `ko`, `zh`) and connect.

### Live Captions

Low-latency speech-to-text captions using `gpt-realtime-whisper`.

---

## CUA Driver setup

Install CUA Driver, grant Accessibility + Screen Recording, then verify:

```bash
npm run smoke:cua
```

The app searches validated trusted executable locations (including Homebrew and `~/.local/bin`), not arbitrary login-shell startup files. Use the absolute overrides above for other installations. Open **Advanced & diagnostics** to check microphone/accessibility state and optional executable availability. Finding an executable does not prove authentication or driver readiness. Missing Codex/CUA never blocks standalone voice.

The positive CUA registry is `list_apps`, `launch_app`, `type_text_chars`, `press_key`, and `check_permissions` with `forceprompt: false`. Unknown names and unapproved arguments are refused in the main process. Local actions require approval by default; auto-run is an explicit opt-in.

## Development

```bash
npm ci
npm run check     # syntax check for all source files
npm run lint      # ESLint
npm test          # injected behavior tests + existing regressions (node:test)
npm run test:ui   # isolated Electron harness, fake media/IPC, no real key or API
npm run build:smoke # unsigned arm64 directory package; does not launch the app
# npm run smoke:cua and npm start access real local capabilities: run manually only.
```

CI checks Node 22/24/26 and runs isolated UI + unsigned directory packaging on `macos-15` (arm64) and `macos-15-intel` (x64). These jobs are configured, not evidence of a completed CI run. They do not establish macOS 13 acceptance. See [verification](docs/VERIFICATION.md) for safe commands and outstanding manual gates.

---

## Security notes

- Never commit `.env` files or real API keys.
- Credentials use `app.getPath("userData")/credentials/openai-api-key.v1.enc` (development: `credentials-dev`), directory mode 0700/file mode 0600. The app ID, product name and user-data identity are unchanged.
- Key precedence: entered runtime key → encrypted saved key → valid legacy record **only when the ciphertext file is absent** → environment. An unreadable existing file never resurrects a stale legacy key. Environment keys are never automatically persisted; a 401 never cycles credentials.
- The old `codex-voice-bridge.openai-api-key` generic-password record is read at most once per packaged launch and migrated only through a verified encrypted save. Invalid values, including the historical literal `-U`, are ignored. The old record is never modified or deleted automatically. Development does not read production legacy records.
- Stable code signing is required for reliable Keychain identity across releases. Unsigned development packages cannot prove upgrade/migration acceptance.
- Logs are written to `~/Library/Logs/codex-voice-bridge/bridge.log` and rotate at 2 MiB with one backup. A 2 MiB logger queue bounds backpressure; dropped entries are counted and marked.
- Tool calls are intentionally limited; some CUA Driver tools are blocked for safety.
- Codex CLI runs with a read-only sandbox by default.

## Project structure

```
codex-voice-bridge/
├── src/
│   ├── main.js          # Electron composition, guarded IPC and tools
│   ├── credentials.js   # Async verified ciphertext storage
│   ├── operations.js    # Session/request/webContents ownership and action queue
│   ├── process-runner.js# Owned process groups and 1048576-character output tails
│   ├── session-controller.js # Injectable media/peer/data-channel lifecycle
│   ├── logger.js        # Byte-bounded asynchronous log writer
│   ├── tail-buffer.js   # Character-bounded chunk accumulator
│   ├── visible-renderer.js # Frame-coalesced visible DOM updates
│   ├── capabilities.js  # Trusted executable resolution, no prompting
│   ├── openai-request.js# Cancellable token HTTP boundary
│   ├── preload.cjs      # Context bridge (secure IPC)
│   ├── renderer.html    # UI — modes, voices, tones, reasoning, languages
│   ├── renderer.js      # UI logic — WebRTC, audio routing, mode switching
│   ├── renderer-utils.js# Browser-safe helpers for the sandboxed renderer (zero imports)
│   ├── lib.js           # Pure, unit-tested helpers for the main process (re-exports renderer-utils)
│   └── styles.css       # Dark theme (#070808 / #f7f7f2)
├── scripts/
│   └── smoke-cua.sh     # CUA Driver connectivity check
├── test/
│   ├── lib.test.js          # Unit tests for lib.js helpers (node:test)
│   ├── main-process.test.js # Main-process behavior: runProcess, tool dispatch, IPC guards
│   ├── main-media.test.js   # Static guard: display-media handler pairing for interview mode
│   ├── renderer-graph.test.js  # Static guard: renderer stays free of node: imports
│   └── tool-pairing.test.js # Static guard: KNOWN_TOOLS matches the declared assistant tools
├── .github/workflows/   # CI: npm run lint + npm test + npm run check
├── package.json
└── .env.example
```

## Roadmap

- [ ] Demo video + walkthrough
- [x] Validated assistant voice selector, locked while active
- [ ] Custom tool registration for user projects
- [ ] Windows/Linux support (audio routing differs)
- [ ] Multi-language interview mode

## FAQ

**Does it send my code anywhere?** Only what you ask Codex CLI to inspect — and Codex runs read-only by default. Audio goes to OpenAI Realtime only while a session is active.

**Which models does it use?** `gpt-realtime-2` (assistant), `gpt-realtime-translate` (translation), `gpt-realtime-whisper` (captions). All configurable via environment variables.

**How is my API key protected?** Only encrypted bytes are saved; macOS Keychain protects the encryption key. Secure-save failures are visible and retain no plaintext fallback. This does not protect against a compromised signed app, administrator-level access, or sharing a key in a prompt. See [Security](SECURITY.md).

**Can it control any app?** It operates apps through CUA Driver with a curated tool allowlist. High-risk tools are blocked.

---

## Contributing

Pull requests are welcome. Keep changes focused, avoid committing secrets, and include a short explanation of the user-facing behavior being changed.

## License

[MIT](LICENSE)
