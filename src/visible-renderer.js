// UI work only; visibility must never pause audio or transport.
export function createVisibleRenderer({ requestFrame, cancelFrame, isVisible, render }) {
  let frame = null,
    dirty = false;
  function flush() {
    frame = null;
    if (!dirty || !isVisible()) return;
    dirty = false;
    render();
  }
  function invalidate() {
    dirty = true;
    if (frame === null && isVisible()) frame = requestFrame(flush);
  }
  function visibilityChanged() {
    if (!isVisible() && frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    if (isVisible()) invalidate();
  }
  return {
    invalidate,
    visibilityChanged,
    dispose() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      dirty = false;
    },
  };
}
