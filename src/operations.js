const validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const cancelled = () => ({
  ok: false,
  code: -95,
  stdout: "",
  stderr: "Session cancelled. No queued action was started.",
});

export function createOperationRegistry() {
  const owners = new Map();
  function cancel(owner, id) {
    const current = owners.get(owner.id);
    if (!current || current.id !== id || current.owner !== owner) return { ok: true };
    current.controller.abort();
    owners.delete(owner.id);
    return { ok: true };
  }
  function begin(owner, id) {
    if (!validId(id) || owner.isDestroyed()) return { ok: false, error: "Invalid session identity." };
    const previous = owners.get(owner.id);
    if (previous?.id === id) return { ok: true, sessionId: id };
    if (previous) cancel(owner, previous.id);
    owners.set(owner.id, {
      id,
      owner,
      controller: new AbortController(),
      requests: new Set(),
      queue: Promise.resolve(),
    });
    return { ok: true, sessionId: id };
  }
  async function run(owner, input, handler, { queued = false } = {}) {
    const current = owners.get(owner.id);
    if (
      !current ||
      current.owner !== owner ||
      current.id !== input?.sessionId ||
      !validId(input?.requestId) ||
      current.controller.signal.aborted
    )
      return cancelled();
    if (current.requests.has(input.requestId) || current.requests.size >= 2048)
      return {
        ok: false,
        code: -94,
        stdout: "",
        stderr: "Duplicate request or session request limit reached. Reconnect explicitly.",
      };
    current.requests.add(input.requestId);
    const active = () => owners.get(owner.id) === current && !current.controller.signal.aborted && !owner.isDestroyed();
    const context = {
      sessionId: input.sessionId,
      requestId: input.requestId,
      signal: current.controller.signal,
      output(chunk) {
        if (!active()) return;
        try {
          owner.send("codex-output", { sessionId: input.sessionId, requestId: input.requestId, chunk });
        } catch {
          /* Renderer closed. */
        }
      },
    };
    const execute = async () => {
      if (!active()) return cancelled();
      try {
        const result = await handler(context);
        return active() ? result : cancelled();
      } catch (error) {
        if (!active()) return cancelled();
        throw error;
      }
    };
    const result = queued ? current.queue.then(execute) : execute();
    if (queued) current.queue = result.catch(() => {});
    return result;
  }
  return {
    begin,
    cancel,
    run,
    get size() {
      return owners.size;
    },
    destroy(owner) {
      const current = owners.get(owner.id);
      if (current?.owner === owner) cancel(owner, current.id);
    },
    dispose() {
      for (const current of owners.values()) current.controller.abort();
      owners.clear();
    },
  };
}
