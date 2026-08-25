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

// True when two enumerateDevices() snapshots describe the same hardware
// (id, kind, and label). Used to skip rebuilding four <select>s on the
// frequent macOS devicechange flaps that report an identical list.
export function sameMediaDeviceList(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a.deviceId !== b.deviceId || a.kind !== b.kind || a.label !== b.label) return false;
  }
  return true;
}

// Turn common failure modes into short, actionable messages for the UI.
// Pure so it stays unit-testable; anything unrecognized passes through as-is.
export function humanizeError(error) {
  const name = error?.name;
  const message = error?.message || String(error);
  const lower = message.toLowerCase();
  if (name === "NotAllowedError") {
    return "Microphone or screen access was denied. Allow microphone permission for Codex Voice Bridge in System Settings > Privacy & Security, then retry.";
  }
  if (name === "NotFoundError") {
    return "No audio input device was found. Check that a microphone is connected and enabled.";
  }
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    // The main process rethrows its fetch TimeoutError as a plain Error
    // ("OpenAI request timed out after Ns: <url>"), so the DOMException name
    // is lost by the time the error reaches the UI — without this the most
    // common network-failure path (a hung token fetch) passes through as raw
    // text instead of the friendly timeout message.
    lower.includes("openai request timed out after") ||
    // A proxy or server answering with a bare HTTP 408 Request Timeout
    // (opaque body, or a response whose text is not the usual JSON error)
    // would otherwise pass through raw even though the status alone is a
    // definitive timeout diagnosis — mirroring the bare-status 401/403/404/
    // 429/5xx branches. The status must be exactly three digits (408\b) so a
    // stray 4+ digit number in an unrelated message cannot false-positive.
    /(?:token|call) failed: 408\b/.test(lower) ||
    /error code: 408\b/.test(lower)
  ) {
    return "The request timed out. Check your network connection and try again.";
  }
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
  // A device that exists but cannot be opened rejects getUserMedia with
  // NotReadableError — almost always exclusive access: a video call, a
  // recorder, or another Codex Voice Bridge window holding the microphone
  // (macOS hands the mic to one app at a time). The raw Chromium message
  // ("Could not start audio source") leaves the user guessing whether the
  // mic or another app is at fault.
  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    haystack.includes("could not start audio source")
  ) {
    return "The microphone could not be started: it is in use by another app (a video call, a recorder, or another Codex Voice Bridge window) or is otherwise unavailable. Close the app using it or pick a different microphone, then retry.";
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
    haystack.includes("err_ssl_") ||
    // undici surfaces TLS protocol failures as EPROTO with an OpenSSL detail
    // ("write EPROTO: error:1408F10B:SSL routines:ssl3_get_record:wrong
    // version number") — a proxy/antivirus speaking plain HTTP to a TLS port,
    // a captive portal, or a MITM interception. The raw text would otherwise
    // pass through with no hint that TLS (not the key or the network) is at
    // fault. "ssl routines" / "tlsv1 alert" / "sslv3 alert" cover the other
    // OpenSSL handshake-failure strings that carry the same root causes.
    haystack.includes("eproto") ||
    haystack.includes("wrong version number") ||
    haystack.includes("ssl routines") ||
    haystack.includes("tlsv1 alert") ||
    haystack.includes("sslv3 alert")
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
    // undici's own failure codes (UND_ERR_CONNECT_TIMEOUT,
    // UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, UND_ERR_SOCKET) surface
    // on error.code / error.cause.code when a connection stalls before the
    // AbortSignal.timeout fires (or the abort is not the first to trigger);
    // the raw "Connect Timeout Error" / "Socket Error" text would otherwise
    // pass through with no hint that the network is at fault.
    haystack.includes("und_err_connect_timeout") ||
    haystack.includes("und_err_headers_timeout") ||
    haystack.includes("und_err_body_timeout") ||
    haystack.includes("und_err_socket") ||
    haystack.includes("enetunreach") ||
    haystack.includes("ehostunreach") ||
    haystack.includes("enetdown") ||
    haystack.includes("econnaborted") ||
    // The macOS application firewall (or a network filter) denying this app
    // outbound access surfaces as Chromium's ERR_NETWORK_ACCESS_DENIED — a
    // firewall problem, not a server outage or a key problem. Without this
    // the raw net:: text passes through and the user blames the wrong thing.
    haystack.includes("err_network_access_denied") ||
    haystack.includes("err_internet_disconnected") ||
    haystack.includes("err_name_not_resolved") ||
    haystack.includes("err_name_resolution_failed") ||
    haystack.includes("err_connection_refused") ||
    haystack.includes("err_connection_reset") ||
    haystack.includes("err_connection_aborted") ||
    haystack.includes("err_connection_closed") ||
    haystack.includes("err_connection_failed") ||
    haystack.includes("err_timed_out") ||
    // ERR_CONNECTION_TIMED_OUT is the most common Chromium form of a silently
    // dropped connection (firewall/proxy dropping SYN packets, a blocked
    // host); the bare "err_timed_out" match above does not cover it because
    // the substring is "connection_timed_out", not "err_timed_out".
    haystack.includes("err_connection_timed_out") ||
    haystack.includes("err_tunnel_connection_failed") ||
    haystack.includes("err_address_unreachable") ||
    haystack.includes("err_network_changed") ||
    // A configured-but-unreachable proxy (ERR_PROXY_CONNECTION_FAILED, e.g.
    // the corporate proxy is down) and a server that closes the connection
    // without sending data (ERR_EMPTY_RESPONSE, usually a firewall/proxy
    // dropping the request) share the connectivity root cause; without these
    // the raw net:: text passes through with no hint that the network is at
    // fault — the exact failure the branch exists to explain.
    haystack.includes("err_proxy_connection_failed") ||
    haystack.includes("err_empty_response")
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

// True when an error means the API key itself was rejected: invalid, revoked,
// or belonging to the wrong project (the 401-class failures — OpenAI's
// invalid_api_key / "Incorrect API key provided" bodies, or a bare 401 status
// on either the token or the SDP call). Everything else — network, quota,
// rate limits, permissions, 5xx, content policy — leaves the key alone, so
// only this class must reveal the key input (see renderer.js). Mirrors the
// 401 branch of humanizeError; the status must be exactly three digits (401\b)
// so a stray 4+ digit number in an unrelated message cannot false-positive.
export function isApiKeyRejection(error) {
  const lower = String(error?.message || error).toLowerCase();
  return (
    lower.includes("invalid_api_key") ||
    lower.includes("incorrect api key") ||
    /(?:token|call) failed: 401\b/.test(lower) ||
    /error code: 401\b/.test(lower)
  );
}

// Every SDP document begins with the version line ("v=0"), so a body that
// does not is definitively not an SDP answer. The Realtime SDP exchange
// trusts response.ok alone; a proxy or captive portal answering the POST
// with a 200 HTML/JSON page would otherwise flow straight into
// pc.setRemoteDescription and fail with an opaque "not a valid SDP" error
// that humanizeError passes through raw — leaving the user blaming the key
// or the network instead of the interception.
export function isSdpAnswer(value) {
  return typeof value === "string" && value.trimStart().startsWith("v=");
}

// Newest-first debug log without Array.unshift. Lines are appended (O(1));
// a start index skips dropped oldest lines; join walks from the end so the
// <pre> still shows newest first. Compact the dead prefix every 32 drops so
// the backing array cannot grow without bound on a long session.
// Live captions are joined every animation frame. trim() on a 50KB string
// allocates a copy whenever the edges are whitespace; when they are not
// (the common case for a spoken turn), reuse the joined string.
export function captionDisplayText(text) {
  if (!text) return "...";
  const start = text[0];
  const end = text[text.length - 1];
  if (!/\s/.test(start) && !/\s/.test(end)) return text;
  return text.trim() || "...";
}

export function createDebugLogBuffer(maxChars = 50000) {
  const COMPACT_AFTER = 32;
  const lines = [];
  let start = 0;
  let chars = 0;

  function compact() {
    if (start === 0) return;
    lines.splice(0, start);
    start = 0;
  }

  return {
    push(line) {
      const piece = String(line);
      if (!piece) return;
      lines.push(piece);
      chars += piece.length;
      while (chars > maxChars && start < lines.length - 1) {
        chars -= lines[start].length;
        start += 1;
      }
      if (chars > maxChars && start === lines.length - 1) {
        // Keep the HEAD of the remaining (newest) line — same as the old
        // unshift + slice(0, maxChars). The timestamp and message start
        // stay; a single huge Codex dump does not rotate the visible log
        // to its tail.
        lines[start] = lines[start].slice(0, maxChars);
        chars = lines[start].length;
      }
      if (start >= COMPACT_AFTER) compact();
    },
    joinNewestFirst() {
      let out = "";
      for (let i = lines.length - 1; i >= start; i--) {
        out += lines[i];
      }
      return out;
    },
    get length() {
      return chars;
    },
  };
}

// Cap an HTTP error body (or any diagnostic string) before it is copied
// into Error.message, the status pill, or the debug log. A captive portal
// or proxy can answer a failed Realtime/token fetch with a megabyte of
// HTML; keeping the HEAD is enough to diagnose (OpenAI JSON errors put
// code/type first) and matches serializeLogData's head-truncation.
export function capErrorBody(text, maxChars = 4000) {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

// Read an HTTP body only up to maxChars, then cancel the stream. capErrorBody
// after response.text() still allocated the full megabyte from a captive
// portal; this keeps the peak at the budget. Falls back to text()+cap when
// the body has no reader (already consumed, or a stub).
export async function readCappedResponseText(response, maxChars = 4000) {
  if (!response) return "";
  let reader = null;
  try {
    reader = response.body?.getReader?.() ?? null;
  } catch {
    reader = null;
  }
  if (!reader) {
    try {
      return capErrorBody(await response.text(), maxChars);
    } catch {
      return "";
    }
  }

  const decoder = new TextDecoder();
  let out = "";
  let overflowed = false;
  try {
    while (out.length < maxChars) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      out += decoder.decode(value, { stream: true });
      if (out.length > maxChars) {
        out = out.slice(0, maxChars);
        overflowed = true;
        break;
      }
    }
    // Exact-size body: one more read so we do not mark a 4000-char OpenAI
    // JSON error as truncated when it filled the budget exactly.
    if (!overflowed && out.length === maxChars) {
      const extra = await reader.read();
      if (!extra.done && extra.value?.byteLength) overflowed = true;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed or cancelled.
    }
  }
  const flush = decoder.decode();
  if (!overflowed && flush) {
    if (out.length + flush.length > maxChars) {
      out = `${out}${flush}`.slice(0, maxChars);
      overflowed = true;
    } else {
      out += flush;
    }
  }
  return overflowed ? `${out}\n...[truncated]` : out;
}

// Parse a JSON HTTP body without buffering a megabyte 2xx dump.
// response.json() reads the entire stream first; a captive portal that
// answers 200 with HTML would allocate that page just to throw SyntaxError.
// Stream-cap first (same helper as error bodies / SDP), then parse. A body
// that overflows the budget, or that is not JSON, fails with a short
// actionable message instead of keeping the dump alive on Error.message.
export async function readCappedJson(response, maxChars = 65536) {
  const text = await readCappedResponseText(response, maxChars);
  if (typeof text === "string" && text.includes("\n...[truncated]")) {
    throw new Error(
      "the server returned an unexpectedly large response instead of JSON — a proxy or captive portal may be intercepting the connection.",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "the server returned a non-JSON response — a proxy or captive portal may be intercepting the connection.",
    );
  }
}

export function truncateOutput(output, maxChars = 30000) {
  const out = { ...output };
  for (const key of ["stdout", "stderr"]) {
    if (typeof out[key] === "string" && out[key].length > maxChars) {
      const original = out[key].length;
      // Keep the TAIL, not the head: this output is the function_call_output
      // the model uses to decide its next action, and for a long run the
      // actionable part (final result, error summary, exit message) is at the
      // END — head-truncation handed the model the verbose preamble of a
      // 100KB codex run and dropped the conclusion it needs to self-correct.
      // Same convention as appendCaption, which keeps the newest text with a
      // marker showing the cut.
      out[key] = `...[truncated ${original - maxChars} chars]\n${out[key].slice(-maxChars)}`;
    }
  }
  return out;
}
