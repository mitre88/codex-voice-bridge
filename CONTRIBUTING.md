# Contributing

Thanks for improving Codex Voice Bridge.

## Workflow

1. Fork the repository.
2. Create a focused branch.
3. Run the checks:

```bash
npm run check
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

