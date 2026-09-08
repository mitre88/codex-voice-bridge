import assert from "node:assert/strict";
import { test } from "node:test";
import { createVisibleRenderer } from "../src/visible-renderer.js";
test("visible DOM updates coalesce once/frame and hidden views flush only after reveal", () => {
  let callback,
    frames = 0,
    renders = 0,
    visible = true,
    cancels = 0;
  const view = createVisibleRenderer({
    requestFrame: (cb) => {
      callback = cb;
      return ++frames;
    },
    cancelFrame: () => cancels++,
    isVisible: () => visible,
    render: () => renders++,
  });
  for (let i = 0; i < 10000; i++) view.invalidate();
  assert.equal(frames, 1);
  callback();
  assert.equal(renders, 1);
  view.invalidate();
  visible = false;
  view.visibilityChanged();
  assert.equal(cancels, 1);
  for (let i = 0; i < 10000; i++) view.invalidate();
  assert.equal(frames, 2);
  visible = true;
  view.visibilityChanged();
  assert.equal(frames, 3);
  callback();
  assert.equal(renders, 2);
  view.dispose();
});
