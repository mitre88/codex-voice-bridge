# Codex Voice Bridge

**A local macOS voice layer for OpenAI Realtime, Codex CLI, CUA Driver, and live interview translation.**

Codex Voice Bridge turns your Mac into a voice-controlled coding and productivity assistant. It can talk with you through OpenAI Realtime, ask Codex CLI to inspect local projects, control visible macOS apps through CUA Driver, and run a bidirectional interpreter mode for English interviews.

## What It Does

- Speaks and listens through OpenAI Realtime over WebRTC.
- Uses `gpt-realtime-2` for a conversational assistant with reasoning and tool calls.
- Uses `gpt-realtime-translate` for live speech translation.
- Uses `gpt-realtime-whisper` for low-latency captions.
- Stores your OpenAI API key in macOS Keychain instead of source files.
- Runs Codex CLI in read-only mode for local project inspection.
- Uses CUA Driver to open, focus, inspect, and operate macOS apps.
- Provides an `Interview` mode for English job interviews:
  - interviewer English -> Spanish audio/subtitles for you
  - your Spanish mic -> English audio for the call

## Requirements

- macOS.
- Node.js 20 or newer.
- npm.
- An OpenAI API key with Realtime API access.
- Codex CLI installed and authenticated if you want local coding-agent actions.
- CUA Driver installed and granted Accessibility + Screen Recording if you want app control.
- Optional but recommended for interview mode: BlackHole 2ch or Loopback for virtual audio routing.

## Install

```bash
git clone https://github.com/mitre88/codex-voice-bridge.git
cd codex-voice-bridge
npm install
npm start
```

On first launch, paste your OpenAI API key into the app. The key is saved in macOS Keychain and the field disappears on future launches.

You can also provide the key through the environment:

```bash
export OPENAI_API_KEY="sk-proj-..."
npm start
```

## Configuration

Optional environment variables:

```bash
export OPENAI_REALTIME_MODEL="gpt-realtime-2"
export OPENAI_REALTIME_TRANSLATE_MODEL="gpt-realtime-translate"
export OPENAI_REALTIME_TRANSCRIBE_MODEL="gpt-realtime-whisper"
export OPENAI_REALTIME_VOICE="marin"
export OPENAI_REALTIME_REASONING_EFFORT="low"
export OPENAI_REALTIME_TARGET_LANGUAGE="es"
export CODEX_VOICE_WORKDIR="/path/to/your/workspace"
```

## Voice Modes

### Assistant

The main Samantha-style assistant mode. It uses `gpt-realtime-2`, speaks naturally, and can call local tools:

- `run_codex`: ask Codex CLI to inspect, summarize, or plan from a local project.
- `run_cua_driver`: inspect and operate macOS apps through CUA Driver.
- `open_app`: visibly open or focus apps like Safari, Chrome, Finder, Xcode, Obsidian, or Terminal.
- `type_text_in_front_app`: type into the focused macOS app.
- `press_key_in_front_app`: press keys in the focused macOS app.

Codex is run in read-only mode by default.

### Interview

Bidirectional live interpreter mode for English interviews.

Recommended setup:

1. Use headphones.
2. Install BlackHole 2ch or Loopback.
3. In the app, choose `Interview`.
4. Set `Your mic` to your real microphone.
5. Set `Their audio` to `Capture meeting audio` and choose the meeting window or screen when prompted.
6. Set `Spanish to me` to your headphones/default output.
7. Set `English to call` to `BlackHole 2ch`.
8. In Zoom, Google Meet, Teams, or the interview app, select `BlackHole 2ch` as your microphone.

Without a virtual audio device, the English translation can still play through speakers, but the meeting will only hear it if your microphone picks up the speaker output.

### Live Translate

One-way live translation using `gpt-realtime-translate`. Choose a target language and connect.

### Live Captions

Low-latency speech-to-text captions using `gpt-realtime-whisper`.

## CUA Driver Setup

Install and grant permissions for CUA Driver, then verify:

```bash
npm run smoke:cua
```

The app expects the `cua-driver` command to be available in your `PATH`.

## Security Notes

- Do not commit `.env` files or real API keys.
- API keys pasted into the app are stored in macOS Keychain under `codex-voice-bridge.openai-api-key`.
- Logs are written to `~/Library/Logs/codex-voice-bridge/bridge.log`.
- Tool calls are intentionally limited. Some CUA Driver tools are blocked for safety.
- Codex CLI runs with a read-only sandbox by default.

## Development

```bash
npm install
npm run check
npm run smoke:cua
npm start
```

## Contributing

Pull requests are welcome. Keep changes focused, avoid committing secrets, and include a short explanation of the user-facing behavior being changed.

