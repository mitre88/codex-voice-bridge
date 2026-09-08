import { spawn as nativeSpawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { TailBuffer } from "./tail-buffer.js";
import { humanizeSpawnError } from "./lib.js";

export function createProcessRunner({
  spawn = nativeSpawn,
  kill = process.kill.bind(process),
  killGraceMs = 3000,
} = {}) {
  const children = new Set();
  function run(command, args, options = {}) {
    if (options.signal?.aborted)
      return Promise.resolve({ ok: false, code: -95, stdout: "", stderr: "Session cancelled." });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env || process.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        resolve({ ok: false, code: -1, stdout: "", stderr: humanizeSpawnError(command, error) });
        return;
      }
      const record = { child, stop: () => terminate("cancel") };
      children.add(record);
      let settled = false,
        terminating = false,
        hardKill,
        timeout;
      const stdout = new TailBuffer(1048576),
        stderr = new TailBuffer(1048576);
      const outDecoder = new StringDecoder("utf8"),
        errDecoder = new StringDecoder("utf8");
      function groupSignal(signal) {
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
        try {
          kill(-child.pid, signal);
        } catch {
          /* The owned process group is gone. */
        }
      }
      function finish(code, message) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        stdout.append(outDecoder.end());
        stderr.append(errDecoder.end());
        const out = (stdout.dropped ? "...[stdout truncated at 1048576 characters]\n" : "") + stdout.text().trim();
        const err = (stderr.dropped ? "...[stderr truncated at 1048576 characters]\n" : "") + stderr.text().trim();
        resolve({
          ok: code === 0,
          code,
          stdout: out,
          stderr: message ? [err, message].filter(Boolean).join("\n") : err,
        });
      }
      function terminate(reason) {
        if (terminating) return;
        terminating = true;
        groupSignal("SIGTERM");
        // Do not clear on leader close: descendants may have closed inherited
        // pipes yet remain in our process group. Keep the owned cleanup record.
        hardKill = setTimeout(() => {
          groupSignal("SIGKILL");
          children.delete(record);
        }, killGraceMs);
        finish(
          reason === "timeout" ? -2 : -95,
          reason === "timeout"
            ? `${command} timed out after ${(options.timeoutMs || 60000) / 1000} seconds.`
            : "Session cancelled.",
        );
      }
      function onAbort() {
        terminate("cancel");
      }
      for (const [stream, decoder, buffer] of [
        [child.stdout, outDecoder, stdout],
        [child.stderr, errDecoder, stderr],
      ]) {
        stream.on("data", (chunk) => {
          if (settled) return;
          const text = decoder.write(chunk);
          buffer.append(text);
          try {
            options.onOutput?.(text);
          } catch {
            /* Output receiver disappeared. */
          }
        });
        stream.on("error", () => {});
      }
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin || "");
      timeout = setTimeout(() => terminate("timeout"), options.timeoutMs || 60000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      child.once("close", (code) => {
        finish(code);
        if (!terminating) {
          let descendants = false;
          if (Number.isSafeInteger(child.pid) && child.pid > 0) {
            try {
              kill(-child.pid, 0);
              descendants = true;
            } catch {
              /* Group is gone. */
            }
          }
          if (descendants) terminate("cleanup");
          else {
            children.delete(record);
            clearTimeout(hardKill);
          }
        }
      });
      child.once("error", (error) => {
        if (!terminating) children.delete(record);
        finish(
          -1,
          error?.code === "ENOENT" && options.cwd && !fs.existsSync(options.cwd)
            ? `The working directory does not exist: ${options.cwd}`
            : humanizeSpawnError(command, error),
        );
      });
    });
  }
  return {
    run,
    get size() {
      return children.size;
    },
    async close() {
      for (const record of children) record.stop();
      if (children.size) await new Promise((resolve) => setTimeout(resolve, killGraceMs + 10));
    },
  };
}
