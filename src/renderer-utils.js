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
    haystack.includes("err_cert_")
  ) {
    return "Could not verify the OpenAI API server's TLS certificate. This usually means a corporate proxy or VPN is intercepting traffic, the system clock is wrong, or the certificate expired — check those and retry.";
  }
  // Network-level failures (DNS lookup, connection refused/reset, offline)
  // surface as TypeError "fetch failed" in the main process or "NetworkError"
  // in the renderer; a raw pass-through leaves the user guessing whether the
  // problem is the key, the server, or their connection.
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
    haystack.includes("network is unreachable")
  ) {
    return "Could not reach the OpenAI API. Check your internet connection and firewall, then retry.";
  }
  if (lower.includes("insufficient_quota") || lower.includes("exceeded your current quota")) {
    return "OpenAI rejected the Realtime call: insufficient_quota. Check billing, project limits, and that the key belongs to the funded organization.";
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
