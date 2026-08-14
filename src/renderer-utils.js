// Browser-safe helpers shared with the sandboxed renderer.
//
// The renderer runs with sandbox:true and nodeIntegration:false, so its
// <script type="module"> uses Chromium's ESM loader — which cannot resolve
// node: builtins ("Failed to resolve module specifier 'node:path'"). Anything
// the renderer imports must therefore live in a module with ZERO imports:
// keep this file free of any import/export-of-node statements. lib.js
// re-exports these so the main process and tests keep a single import surface.

export const VIRTUAL_AUDIO_LABEL = /blackhole|loopback|virtual/i;

export function hasVirtualAudioDevice(devices = []) {
  // Guard non-array input (a buggy caller must not crash the UI on connect).
  return Array.isArray(devices) && devices.some((device) => VIRTUAL_AUDIO_LABEL.test(device?.label || ""));
}

// Turn common failure modes into short, actionable messages for the UI.
// Pure so it stays unit-testable; anything unrecognized passes through as-is.
export function humanizeError(error) {
  const name = error?.name;
  const message = error?.message || String(error);
  if (name === "NotAllowedError") {
    return "Microphone or screen access was denied. Allow microphone permission for Codex Voice Bridge in System Settings > Privacy & Security, then retry.";
  }
  if (name === "NotFoundError") {
    return "No audio input device was found. Check that a microphone is connected and enabled.";
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return "The request timed out. Check your network connection and try again.";
  }
  const lower = message.toLowerCase();
  // undici (Node's fetch) buries the real reason in error.cause — e.g.
  // TypeError "fetch failed" with cause "unable to verify the first
  // certificate" — and syscall codes (ENOTFOUND, ECONNREFUSED, ...) may live
  // only on error.code. Search all three so the specific diagnosis wins over
  // the generic message instead of a raw pass-through.
  const haystack = [lower, error?.cause?.message, error?.cause?.code, error?.code]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  // An exact deviceId (the mic/output selected in the UI) that is unplugged,
  // renamed, or otherwise gone rejects getUserMedia with OverconstrainedError;
  // the raw Chromium message ("Constraints could not be satisfied") leaves the
  // user guessing whether the app or the hardware is at fault.
  if (name === "OverconstrainedError" || haystack.includes("constraints could not be satisfied")) {
    return "The selected microphone or audio device is no longer available. Check that it is still connected, then reconnect or refresh the device list and try again.";
  }
  // TLS/certificate verification failures (corporate proxy/VPN interception,
  // expired certificate, wrong system clock) surface as raw OpenSSL strings or
  // as the cause of an undici "fetch failed"; without this branch users see
  // the generic connectivity message or an opaque error and blame the wrong
  // thing. Placed before the network branch so a wrapped cert error is not
  // shadowed by "fetch failed".
  if (
    haystack.includes("unable to verify the first certificate") ||
    haystack.includes("unable to get local issuer certificate") ||
    haystack.includes("unable to verify leaf signature") ||
    haystack.includes("self-signed certificate") ||
    haystack.includes("certificate has expired") ||
    haystack.includes("certificate is not yet valid") ||
    // OpenSSL error codes (underscore form) as they appear on error.code.
    haystack.includes("unable_to_get_issuer_cert_locally") ||
    haystack.includes("unable_to_verify_leaf_signature") ||
    haystack.includes("self_signed_cert_in_chain") ||
    haystack.includes("cert_has_expired") ||
    haystack.includes("cert_not_yet_valid") ||
    haystack.includes("depth_zero_self_signed") ||
    haystack.includes("err_cert_") ||
    // Non-certificate TLS handshake failures (net::ERR_SSL_PROTOCOL_ERROR,
    // ERR_SSL_VERSION_OR_CIPHER_MISMATCH, ERR_NO_SSL_VERSIONS_ENABLED, ...)
    // share the interception/clock root causes with certificate errors, and a
    // raw pass-through would leave the user blaming the key or the network.
    haystack.includes("err_ssl_")
  ) {
    return "Could not verify the OpenAI API server's TLS certificate. This usually means a corporate proxy or VPN is intercepting traffic, the system clock is wrong, or the certificate expired — check those and retry.";
  }
  // Network-level failures (DNS lookup, connection refused/reset, offline)
  // surface as TypeError "fetch failed" in the main process or "NetworkError"
  // in the renderer; a raw pass-through leaves the user guessing whether the
  // problem is the key, the server, or their connection. Chromium/Electron
  // additionally reports these as "net::ERR_*" strings (offline, DNS failure,
  // refused/reset connections) — the "err_" prefix is shared with the TLS
  // branch above, so only the specific network codes are matched here and
  // certificate codes keep mapping to the certificate message.
  if (
    haystack.includes("fetch failed") ||
    haystack.includes("failed to fetch") ||
    haystack.includes("networkerror") ||
    haystack.includes("enotfound") ||
    haystack.includes("econnrefused") ||
    haystack.includes("econnreset") ||
    haystack.includes("eai_again") ||
    haystack.includes("getaddrinfo") ||
    haystack.includes("socket hang up") ||
    haystack.includes("network is unreachable") ||
    // undici syscall codes that surface on error.code / error.cause.code when
    // the message itself is only the generic "fetch failed" (a firewalled
    // host timing out, a network unreachable, an aborted connection).
    haystack.includes("etimedout") ||
    haystack.includes("enetunreach") ||
    haystack.includes("ehostunreach") ||
    haystack.includes("econnaborted") ||
    haystack.includes("err_internet_disconnected") ||
    haystack.includes("err_name_not_resolved") ||
    haystack.includes("err_name_resolution_failed") ||
    haystack.includes("err_connection_refused") ||
    haystack.includes("err_connection_reset") ||
    haystack.includes("err_connection_aborted") ||
    haystack.includes("err_connection_closed") ||
    haystack.includes("err_connection_failed") ||
    haystack.includes("err_timed_out") ||
    haystack.includes("err_tunnel_connection_failed") ||
    haystack.includes("err_address_unreachable") ||
    haystack.includes("err_network_changed")
  ) {
    return "Could not reach the OpenAI API. Check your internet connection and firewall, then retry.";
  }
  // A 402 (billing/quota) failure — "insufficient_quota", "Insufficient
  // balance", or a bare 402 status (opaque body, proxy, or a response whose
  // text is not the usual JSON error) — is a billing problem, not a transient
  // failure; a raw pass-through leaves the user guessing whether the key, the
  // network, or their credit is at fault. The status must be exactly three
  // digits (402\b) so a stray 4+ digit number in an unrelated message cannot
  // false-positive, mirroring the 401/403/404 branches.
  if (
    lower.includes("insufficient_quota") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("insufficient balance") ||
    /(?:token|call) failed: 402\b/.test(lower) ||
    /error code: 402\b/.test(lower)
  ) {
    return "OpenAI rejected the Realtime call: insufficient_quota (402). Check billing, project limits, and that the key belongs to the funded organization, then retry.";
  }
  // A billing hard limit ("billing_hard_limit_reached") is a billing problem,
  // not a transient rate limit — OpenAI returns it with a 429 status, so
  // without this branch it would be mislabeled as a rate limit (or pass
  // through raw when no status is present) and the user would blame the wrong
  // thing. Placed before the 429 branch so the billing diagnosis wins.
  if (lower.includes("billing_hard_limit_reached") || lower.includes("billing hard limit")) {
    return "OpenAI rejected the Realtime call: billing_hard_limit_reached. You reached your project's billing hard limit — raise or remove the limit in your OpenAI billing settings, then retry.";
  }
  // A bare "429" (opaque body, proxy, or a response whose text is not the
  // usual JSON error) would otherwise pass through raw even though the
  // status alone is a definitive rate-limit problem, mirroring the bare
  // 401/403/404 branches above. The status must be exactly three digits
  // (429\b) so a stray 4+ digit number in an unrelated message cannot
  // false-positive.
  if (
    lower.includes("rate_limit_exceeded") ||
    lower.includes("rate limit") ||
    /(?:token|call) failed: 429\b/.test(lower) ||
    /error code: 429\b/.test(lower)
  ) {
    return "OpenAI rate limit reached (429). Wait a moment and retry, or check your plan's requests-per-minute (RPM) and tokens-per-minute (TPM) limits.";
  }
  // A content-policy rejection ("content_policy_violation", "Your request was
  // rejected as a result of our safety system") is a request-content problem,
  // not a configuration one: the generic 400 branch below would otherwise tell
  // the user to fix their .env model/voice values when the key and config are
  // fine — the request itself was refused by OpenAI's safety system. Placed
  // before the 400 branch so the content diagnosis wins.
  if (
    lower.includes("content_policy_violation") ||
    lower.includes("content policy violation") ||
    lower.includes("rejected as a result of our safety system")
  ) {
    return "OpenAI rejected the request because it triggered the content safety system (content_policy_violation). Rephrase the request and retry — the API key and connection are fine.";
  }
  // 400 invalid_request_error responses (an invalid voice or language value in
  // .env, an unsupported session parameter, a malformed request body) are
  // configuration problems, not transient failures; a raw pass-through leaves
  // the user guessing whether the key, the network, or the .env is at fault.
  // The reasoning-400 is already auto-retried in the main process, so what
  // reaches the UI is the remaining config class. The status must be exactly
  // three digits (400\b) so a stray 4+ digit number in an unrelated message
  // cannot false-positive, mirroring the 429 branch above.
  if (
    lower.includes("invalid_request_error") ||
    /(?:token|call) failed: 400\b/.test(lower) ||
    /error code: 400\b/.test(lower)
  ) {
    return "OpenAI rejected the Realtime request (400). Check the model, voice, and language values in .env for ones the Realtime API supports, then retry.";
  }
  // A bare "401 Unauthorized" (proxy, opaque body, or a response whose text is
  // not the usual JSON error) would otherwise pass through raw even though the
  // status alone is a definitive key problem. The status must be exactly three
  // digits (401\b) so a stray 4+ digit number in an unrelated message cannot
  // false-positive, mirroring the 5xx branch below.
  if (
    lower.includes("invalid_api_key") ||
    lower.includes("incorrect api key") ||
    /(?:token|call) failed: 401\b/.test(lower) ||
    /error code: 401\b/.test(lower)
  ) {
    return "OpenAI rejected the API key (401). Check that the key is valid, has Realtime access, and belongs to the funded organization, then save it again.";
  }
  // 403 permission errors ("insufficient_permissions", "You do not have access
  // to the realtime API") usually mean the key/project lacks the Realtime
  // entitlement or the model is not enabled for it; a raw pass-through leaves
  // the user guessing whether the problem is the key, the project, or the model.
  if (
    lower.includes("insufficient_permissions") ||
    lower.includes("do not have access to the realtime") ||
    /(?:token|call) failed: 403\b/.test(lower) ||
    /error code: 403\b/.test(lower)
  ) {
    return "OpenAI rejected the request with insufficient permissions (403). Check that the API key belongs to a project with the Realtime API enabled and that the requested model is available to it.";
  }
  // 404 model errors ("The model 'x' does not exist or you do not have access
  // to it.") are usually a typo in the .env model names or a model the account
  // cannot use; a raw pass-through leaves the user guessing which one.
  if (
    lower.includes("model_not_found") ||
    (lower.includes("does not exist") && lower.includes("model")) ||
    /(?:token|call) failed: 404\b/.test(lower) ||
    /error code: 404\b/.test(lower)
  ) {
    return "OpenAI could not find the requested Realtime model (404). Check the model names in .env (OPENAI_REALTIME_MODEL, OPENAI_REALTIME_TRANSLATE_MODEL, OPENAI_REALTIME_TRANSCRIBE_MODEL) for typos, or confirm the model is available to your account.";
  }
  // 5xx responses ("OpenAI Realtime token failed: 500 Internal Server Error",
  // "Error code: 502 - Bad Gateway", "Realtime call failed: 503 Service
  // Unavailable") are OpenAI-side outages; a raw pass-through makes the user
  // suspect their key or network when the fix is simply to retry. Placed after
  // the specific 4xx branches so a client error is never shadowed. The status
  // must be exactly three digits (5\d\d\b) so a stray 4+ digit number in an
  // unrelated message cannot false-positive.
  if (
    /(?:token|call) failed: 5\d\d\b/.test(lower) ||
    /error code: 5\d\d\b/.test(lower) ||
    /(^|[^0-9])5\d\d\s+(internal server error|bad gateway|service unavailable|gateway timeout)/.test(lower)
  ) {
    return "OpenAI API is temporarily unavailable (5xx server error). Wait a few seconds and retry — this is an OpenAI-side outage, not your connection or key.";
  }
  return message;
}

export function truncateOutput(output, maxChars = 30000) {
  const out = { ...output };
  for (const key of ["stdout", "stderr"]) {
    if (typeof out[key] === "string" && out[key].length > maxChars) {
      const original = out[key].length;
      out[key] = `${out[key].slice(0, maxChars)}\n...[truncated ${original - maxChars} chars]`;
    }
  }
  return out;
}
