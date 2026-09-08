// Single asynchronous writer. Waiting for each write callback bounds the
// Writable's internal buffer as well as our byte-counted producer queue.
export function createBoundedLogger({ open, rotate, maxQueueBytes = 2 * 1024 * 1024, maxFileBytes = 2 * 1024 * 1024 }) {
  let stream,
    size = 0,
    queuedBytes = 0,
    dropped = 0,
    pendingDrops = 0,
    errors = 0;
  let closed = false,
    stopped = false,
    pumping = null;
  const queue = [];
  const stopStream = () =>
    new Promise((resolve) => {
      if (!stream || stream.destroyed) {
        stream = undefined;
        resolve();
        return;
      }
      const current = stream;
      stream = undefined;
      current.once("error", resolve);
      current.end(resolve);
    });
  async function pump() {
    try {
      while (!stopped && (queue.length || pendingDrops)) {
        let line;
        if (queue.length) {
          line = queue.shift();
          queuedBytes -= line.length;
        } else {
          line = Buffer.from(`[logger dropped ${pendingDrops} entries under backpressure]\n`);
          pendingDrops = 0;
        }
        if (!stream) {
          const opened = await open();
          stream = opened.stream;
          size = opened.size;
          stream.on("error", () => {
            errors++;
          });
        }
        if (size && size + line.length > maxFileBytes) {
          await stopStream();
          await rotate();
          const opened = await open();
          stream = opened.stream;
          size = opened.size;
          stream.on("error", () => {
            errors++;
          });
        }
        if (stopped) {
          stream?.destroy();
          stream = undefined;
          break;
        }
        await new Promise((resolve, reject) => {
          const target = stream;
          const onError = (error) => {
            target.removeListener("error", onError);
            reject(error);
          };
          target.once("error", onError);
          target.write(line, (error) => {
            target.removeListener("error", onError);
            if (error) reject(error);
            else resolve();
          });
        });
        size += line.length;
      }
    } catch {
      errors++;
      dropped += queue.length;
      queue.length = 0;
      queuedBytes = 0;
      pendingDrops = 0;
      stream?.destroy();
      stream = undefined;
    }
  }
  function start() {
    if (pumping || stopped) return;
    pumping = pump().finally(() => {
      pumping = null;
      if (!stopped && (queue.length || pendingDrops)) start();
    });
  }
  function write(value) {
    if (closed || stopped) return;
    const line = Buffer.from(`${String(value)}\n`);
    if (line.length > maxFileBytes || queuedBytes + line.length > maxQueueBytes) {
      dropped++;
      pendingDrops++;
      start();
      return;
    }
    queue.push(line);
    queuedBytes += line.length;
    start();
  }
  async function close(timeoutMs = 1000) {
    closed = true;
    start();
    let timer;
    await Promise.race([
      (async () => {
        while (pumping) await pumping;
        await stopStream();
      })(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    stopped = true;
    dropped += queue.length;
    queue.length = 0;
    queuedBytes = 0;
    stream?.destroy();
  }
  return {
    write,
    close,
    get stats() {
      return { queuedBytes, dropped, errors };
    },
  };
}
