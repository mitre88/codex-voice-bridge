# Security Policy

## Reporting

Please report security issues privately through GitHub Security Advisories when available, or open a minimal issue without including secrets or exploit details.

## Sensitive Data

Do not include:

- OpenAI API keys.
- GitHub tokens.
- macOS Keychain data.
- `.env` files.
- Logs with private prompts, file paths, or user data.
- Screenshots that reveal private information.

## Local Permissions

This app can request microphone, screen/audio capture, Accessibility, and Screen Recording permissions depending on the mode. Review the code and permissions before using it in a sensitive environment.


## Credential boundary

Electron 44's asynchronous `safeStorage` encrypts the API key; macOS Keychain
holds the encryption key, not a new generic-password API-key record. The app
writes ciphertext only, with 0700 directories / 0600 files, verified readback,
serialized operations and atomic replacement. There is no plaintext fallback.
Development uses `credentials-dev` and never reads the production legacy record.
The previous generic-password record is read-only and preserved after migration.
An existing corrupt/undecryptable file raises recovery guidance, never stale-key
resurrection. A failed save can leave an entered key in process memory for that
launch; quitting clears that runtime value. Stable code signing is required for
consistent Keychain access across updates; unsigned testing cannot establish it.

## Execution boundary

IPC accepts only the app's exact top-level renderer frame. Token requests and
local actions carry session/request IDs and are bound to the originating
webContents. Disconnect/destruction cancels token fetches, invalidates queued
actions, and terminates only owned process groups (SIGTERM then bounded SIGKILL,
even if the group leader exits first). There is no automatic reconnect.

CUA is a positive registry: `list_apps`, `launch_app`, `type_text_chars`,
`press_key`, and non-prompting `check_permissions`. The previous blocked names
(`hotkey`, `move_cursor`, `replay_trajectory`, `set_recording`) remain blocked.
Arguments, launch identities/URLs, workspace containment and output limits remain
guarded. These allowed operations can still affect the foreground application;
review the action preview and keep auto-run off unless you accept that risk.

The app never evaluates a login shell to discover tools. It accepts validated
absolute executables in trusted locations or explicit configuration. Local logs
may contain private transcripts and tool output even with API-key redaction; do
not publish them without review. Logger truncation is not a privacy guarantee.

## Test boundary

`npm test` uses injected storage, media, HTTP and process adapters; descendant
fixtures launch only the test's own Node processes. `npm run test:ui` launches a
separate Electron main with temporary userData, the production preload/renderer,
fake media and peer connections, and denied network/OS permissions. There is no
ambient-environment test bypass in the production entrypoint. Never replace this
harness with a production bootstrap for screenshots or automated checks.
