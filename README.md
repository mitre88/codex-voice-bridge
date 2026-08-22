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

Talk to your Mac. It listens, speaks, inspects your code with Codex CLI, operates your apps through CUA Driver, and translates English interviews in real time — all locally, with your own OpenAI API key.

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

- API key stored in **macOS Keychain** (`codex-voice-bridge.openai-api-key`) — never in source files
- Codex CLI runs in a **read-only sandbox** by default
- CUA Driver tools are intentionally limited; unsafe tools are blocked
- Logs stay local at `~/Library/Logs/codex-voice-bridge/bridge.log` and rotate at 2 MB (`bridge.log.1`)

---

## Quick start

```bash
git clone https://github.com/mitre88/codex-voice-bridge.git
cd codex-voice-bridge
npm install
npm start
```

On first launch, paste your OpenAI API key into the app. It is saved to Keychain and the field disappears on future launches.

You can also provide the key via environment:

```bash
export OPENAI_API_KEY="sk-proj-..."
npm start
```

## Requirements

- macOS
- Node.js 20+
- npm
- An OpenAI API key with Realtime API access
- Codex CLI installed and authenticated — for local coding-agent actions
- CUA Driver installed with Accessibility + Screen Recording granted — for app control
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
5. Set `Their audio` to `Capture meeting audio` and choose the meeting window or screen when prompted.
6. Set `Spanish to me` to your headphones/default output.
7. Set `English to call` to `BlackHole 2ch`.
8. In Zoom, Google Meet, Teams, or the interview app, select `BlackHole 2ch` as your microphone.

Without a virtual audio device, the English translation can still play through your speakers, but the meeting will only hear it if your microphone picks up the speaker output.

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

The app expects the `cua-driver` command to be available in your `PATH`.

## Development

```bash
npm install
npm run check     # syntax check for all source files
npm run lint      # ESLint
npm test          # unit tests (node:test)
npm run smoke:cua # CUA Driver connectivity check (requires CUA Driver)
npm start
```

CI on `main` runs `npm ci`, `npm run lint`, `npm test`, and `npm run check` on Node 20 and 22.

---

## Security notes

- Never commit `.env` files or real API keys.
- API keys pasted into the app are stored in macOS Keychain under `codex-voice-bridge.openai-api-key`.
- Logs are written to `~/Library/Logs/codex-voice-bridge/bridge.log` and rotate at 2 MB.
- Tool calls are intentionally limited; some CUA Driver tools are blocked for safety.
- Codex CLI runs with a read-only sandbox by default.

## Project structure

```
codex-voice-bridge/
├── src/
│   ├── main.js          # Electron main process — Realtime session, tools, Keychain
│   ├── preload.cjs      # Context bridge (secure IPC)
│   ├── renderer.html    # UI — modes, voices, tones, reasoning, languages
│   ├── renderer.js      # UI logic — WebRTC, audio routing, mode switching
│   ├── renderer-utils.js# Browser-safe helpers for the sandboxed renderer (zero imports)
│   ├── lib.js           # Pure, unit-tested helpers for the main process (re-exports renderer-utils)
│   └── styles.css       # Dark theme (#070808 / #f7f7f2)
├── assets/
│   └── icon.png         # App icon (electron-builder buildResources)
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
- [ ] More assistant voices and tones
- [ ] Custom tool registration for user projects
- [ ] Windows/Linux support (audio routing differs)
- [ ] Multi-language interview mode

## FAQ

**Does it send my code anywhere?** Only what you ask Codex CLI to inspect — and Codex runs read-only by default. Audio goes to OpenAI Realtime only while a session is active.

**Which models does it use?** `gpt-realtime-2` (assistant), `gpt-realtime-translate` (translation), `gpt-realtime-whisper` (captions). All configurable via environment variables.

**Is my API key safe?** Yes — it is stored in macOS Keychain, never in the repository or log files.

**Can it control any app?** It operates apps through CUA Driver with a curated tool allowlist. High-risk tools are blocked.

---

## Contributing

Pull requests are welcome. Keep changes focused, avoid committing secrets, and include a short explanation of the user-facing behavior being changed.

## License

[MIT](LICENSE)
