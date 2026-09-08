import { test, expect, _electron as electron } from "@playwright/test";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
let app, page;
mkdirSync(path.join(root, ".artifacts/screenshots"), { recursive: true });
test.beforeEach(async () => {
  // Do not pass shell credentials into the harness process.
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "DISPLAY", "XAUTHORITY"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  app = await electron.launch({ args: [path.join(root, "test/ui/main.js")], env });
  page = await app.firstWindow();
  await page.addInitScript({ path: path.join(root, "test/ui/mocks.js") });
  await page.goto(pathToFileURL(path.join(root, "src/renderer.html")).href);
  await expect(page.locator("#keyStatus")).toBeVisible();
});
test.afterEach(async () => {
  await app?.close();
});

test("real renderer boots with optional tools absent; cancel during token owns all media", async () => {
  await app.evaluate(() => globalThis.harness.configure({ holdToken: true }));
  await page.locator("#connect").click();
  await expect(page.locator("#disconnect")).toHaveText("Cancel");
  await expect.poll(() => app.evaluate(() => globalThis.harness.pendingTokens())).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__fixture.stats().liveTracks)).toBe(1);
  await page.locator("#disconnect").click();
  await expect(page.locator("#status")).toHaveText("Idle");
  await expect.poll(() => page.evaluate(() => window.__fixture.stats().liveTracks)).toBe(0);
  expect(await page.evaluate(() => window.__fixture.stats().livePeers)).toBe(0);
  await expect.poll(() => app.evaluate(() => globalThis.harness.activeSessions())).toBe(0);
  // Deliver the held operation after cancellation; the owner must reject it.
  await app.evaluate(() => globalThis.harness.releaseTokens());
  await expect
    .poll(() =>
      app.evaluate(() => globalThis.harness.calls().filter((c) => c.kind === "token-settled" && c.cancelled).length),
    )
    .toBe(1);
  expect(await app.evaluate(() => globalThis.harness.pendingTokens())).toBe(0);
  await expect(page.locator("#status")).toHaveText("Idle");
  expect(await page.evaluate(() => window.__fixture.stats())).toMatchObject({ liveTracks: 0, livePeers: 0, sent: [] });
});
test("all four modes and 50 cycles close every fake resource; selected voice locks", async () => {
  for (let i = 0; i < 50; i++) {
    const mode = ["assistant", "translate", "transcribe", "interview"][i % 4];
    await page.locator("#voiceMode").selectOption(mode);
    if (mode === "interview") {
      await page.locator("#interviewerInputMode").selectOption("device");
      await page.locator("#interviewerAudioDevice").selectOption("meeting");
    }
    await page.locator("#connect").click();
    await expect(page.locator("#status")).toHaveText("Listening");
    await expect(page.locator("#voice")).toBeDisabled();
    await page.locator("#disconnect").click();
    expect(await page.evaluate(() => window.__fixture.stats().liveTracks)).toBe(0);
    expect(await page.evaluate(() => window.__fixture.stats().livePeers)).toBe(0);
  }
});
test("readiness timeout has a separate recovery banner, no mic and explicit Retry", async () => {
  await app.evaluate(() => globalThis.harness.configure({ openaiTimeoutMs: 600 }));
  await page.reload();
  await page.evaluate(() => window.__fixture.configure({ neverReady: true }));
  await page.locator("#connect").click();
  await expect(page.locator("#errorBanner")).toBeVisible();
  await expect(page.locator("#connect")).toHaveText("Retry");
  await expect(page.locator("#status")).not.toContainText("timed out");
  expect(await page.evaluate(() => window.__fixture.stats().liveTracks)).toBe(0);
});
test("failed selected output and disappeared input never silently select speakers/default", async () => {
  await page.locator("#voiceMode").selectOption("interview");
  await page.locator("#spanishOutputDevice").selectOption("headphones");
  await page.locator("#englishOutputDevice").selectOption("virtual");
  await page.evaluate(() => window.__fixture.configure({ sinkFails: true }));
  await page.locator("#connect").click();
  await expect(page.locator("#errorMessage")).toContainText("output");
  expect(await page.evaluate(() => window.__fixture.stats().liveTracks)).toBe(0);
  await page.locator("#myMicDevice").selectOption("microphone");
  await page.evaluate(() => window.__fixture.devices([]));
  await expect(page.locator("#myMicDevice")).toHaveValue("microphone");
  await expect(page.locator("#errorMessage")).toContainText("disappeared");
});
test("approval is keyboard complete, labelled, deadline announced and rejects on Escape", async () => {
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Listening");
  await page.evaluate(() =>
    window.__fixture.event({
      type: "response.function_call_arguments.done",
      call_id: "approve-1",
      name: "run_codex",
      arguments: JSON.stringify({ prompt: "Inspect mock files" }),
    }),
  );
  await expect(page.getByLabel("Action preview (read-only)")).toBeVisible();
  await expect(page.locator("#runCodex")).toBeFocused();
  await expect(page.locator("#actionDeadline")).toContainText("Automatically rejected");
  await page.keyboard.press("Escape");
  await expect(page.locator("#pendingPanel")).toBeHidden();
  await expect(page.locator("#disconnect")).toBeFocused();
  expect(
    (await page.evaluate(() => window.__fixture.stats().sent)).some(
      (message) => message.item?.type === "function_call_output",
    ),
  ).toBe(true);
});
test("hidden debug is not rewritten by caption floods; completed captions announce segments", async () => {
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Listening");
  await page.evaluate(() => {
    window.debugWrites = 0;
    new MutationObserver(() => window.debugWrites++).observe(document.querySelector("#log"), {
      childList: true,
      subtree: true,
    });
    window.__fixture.burst(6000);
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.debugWrites)).toBe(0);
  expect((await page.locator("#outputCaption").textContent()).length).toBeLessThanOrEqual(50000);
  await expect(page.locator("#captionAnnouncement")).toHaveText("");
  await page.evaluate(() =>
    window.__fixture.event({ type: "response.output_audio_transcript.done", transcript: "One completed thought." }),
  );
  await expect(page.locator("#captionAnnouncement")).toHaveText("One completed thought.");
  await page.locator(".debug-panel summary").click();
  await expect(page.locator("#log")).not.toBeEmpty();
});
test("narrow 420px layout, 200 percent zoom and reduced motion remain usable", async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 980));
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(root, ".artifacts/screenshots/samantha-420.png"), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(210);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Listening");
  expect(await page.locator(".orb").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  // Playwright fullPage clips at CSS width * display scale while Electron's
  // page zoom also scales the surface. Capture the actual native viewport,
  // and bind the bitmap width to layout width * effective devicePixelRatio.
  async function captureZoomViewport(filename) {
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      dpr: window.devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll("h1, #status, button, select, .caption-text")]
        .filter((el) => {
          if (!el.getClientRects().length) return false;
          const rect = el.getBoundingClientRect();
          return rect.left < -0.5 || rect.right > window.innerWidth + 0.5;
        })
        .map((el) => el.id || el.tagName),
    }));
    expect(layout.overflowing).toEqual([]);
    const bitmap = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      return { size: image.getSize(), png: image.toPNG().toString("base64") };
    });
    expect(bitmap.size.width).toBe(Math.round(layout.width * layout.dpr));
    writeFileSync(path.join(root, ".artifacts/screenshots", filename), Buffer.from(bitmap.png, "base64"));
    writeFileSync(
      path.join(root, ".artifacts/screenshots", `${filename}.json`),
      JSON.stringify({ layout, bitmapSize: bitmap.size }, null, 2),
    );
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await captureZoomViewport("samantha-200-percent.png");
  await page.evaluate(() => document.querySelector("#captionPanel").scrollIntoView());
  await captureZoomViewport("samantha-200-percent-captions.png");
});
test("late media grant and old action completion cannot mutate a replacement session", async () => {
  await page.evaluate(() => window.__fixture.configure({ mediaDelay: 400 }));
  await page.locator("#connect").click();
  await expect.poll(() => page.evaluate(() => window.__fixture.stats().mediaRequests)).toBe(1);
  await page.locator("#disconnect").click();
  await page.evaluate(() => window.__fixture.configure({ mediaDelay: 0 }));
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Listening");
  await page.waitForTimeout(450);
  expect(await page.evaluate(() => window.__fixture.stats().liveTracks)).toBe(1);
  await app.evaluate(() => globalThis.harness.configure({ actionDelay: 400 }));
  await page.locator(".advanced-panel summary").click();
  await page.locator("#autoRun").check();
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++)
      window.__fixture.event({
        type: "response.function_call_arguments.done",
        call_id: `old-${i}`,
        name: "run_codex",
        arguments: JSON.stringify({ prompt: "mock work" }),
      });
  });
  await expect
    .poll(() => app.evaluate(() => globalThis.harness.calls().filter((c) => c.kind === "codex:run").length))
    .toBe(1);
  await page.locator("#disconnect").click();
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Listening");
  await page.waitForTimeout(450);
  expect(await app.evaluate(() => globalThis.harness.calls().filter((c) => c.kind === "codex:run").length)).toBe(1);
  await expect(page.locator("#status")).toHaveText("Listening");
});
test("hidden window pauses visual work but never releases or pauses active transport", async () => {
  await page.locator("#connect").click();
  await expect(page.locator("#status")).toHaveText("Listening");
  const nativeWindow = await app.browserWindow(page);
  const id = await nativeWindow.evaluate((window) => {
    window.visibilityEvents = [];
    for (const event of ["hide", "show"]) window.on(event, () => window.visibilityEvents.push(event));
    window.hide();
    return window.id;
  });
  const nativeState = () =>
    nativeWindow.evaluate((window) => ({
      id: window.id,
      visible: window.isVisible(),
      events: window.visibilityEvents,
    }));
  await expect.poll(nativeState).toEqual({ id, visible: false, events: ["hide"] });
  await expect(page.locator("body")).toHaveAttribute("data-hidden", "true");
  expect(await page.locator(".orb").evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("paused");
  await page.evaluate(() => {
    window.hiddenWork = { requests: 0, executions: 0, writes: 0 };
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      window.hiddenWork.requests++;
      return request((time) => {
        window.hiddenWork.executions++;
        callback(time);
      });
    };
    const observer = new MutationObserver((records) => (window.hiddenWork.writes += records.length));
    for (const selector of ["#captionPanel", "#log"])
      observer.observe(document.querySelector(selector), { childList: true, subtree: true, characterData: true });
    window.__fixture.burst(100);
  });
  await page.waitForTimeout(200);
  expect(await nativeState()).toEqual({ id, visible: false, events: ["hide"] });
  expect(await page.evaluate(() => window.hiddenWork)).toEqual({ requests: 0, executions: 0, writes: 0 });
  expect(await page.evaluate(() => window.__fixture.stats())).toMatchObject({
    mediaRequests: 1,
    liveTracks: 1,
    livePeers: 1,
  });
  await nativeWindow.evaluate((window) => window.show());
  await expect.poll(nativeState).toEqual({ id, visible: true, events: ["hide", "show"] });
  await expect(page.locator("body")).toHaveAttribute("data-hidden", "false");
  expect(await page.locator(".orb").evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("running");
  await expect(page.locator("#outputCaption")).toContainText("A clear thought.");
  await expect(page.locator("#status")).toHaveText("Listening");
  expect(await page.evaluate(() => window.__fixture.stats())).toMatchObject({
    mediaRequests: 1,
    liveTracks: 1,
    livePeers: 1,
  });
});
