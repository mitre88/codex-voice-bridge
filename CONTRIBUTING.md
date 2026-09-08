# Contributing

Thanks for improving Codex Voice Bridge.

## Workflow

1. Fork the repository.
2. Create a focused branch.
3. Run the checks:

```bash
npm run check
npm run lint
npm test
npm run test:ui # isolated mock Electron harness; no keys, network or microphone
```

4. If your change touches CUA Driver integration and you have it installed:

```bash
npm run smoke:cua
```

5. Open a pull request with:

- What changed.
- Why it changed.
- How you tested it.

## Safety Rules

- Never commit API keys, `.env` files, tokens, logs, or screenshots containing secrets.
- Keep local-action tools conservative.
- Do not make destructive macOS actions automatic.
- Prefer small, reviewable PRs.


Use Node 24 (`.nvmrc`). Run source-mutating formatters before final verification. Keep both existing regression contracts and injected behavioral proof when extracting modules; do not delete old checks just to force a pass. CI covers Node 22/24/26, but minimum-OS, native Intel, signed credential upgrade and real audio-routing acceptance still require separate explicit manual runs. See [verification](docs/VERIFICATION.md).
