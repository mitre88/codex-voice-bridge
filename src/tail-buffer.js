// Character-bounded chunk deque. Append never copies the entire retained tail.
export class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    this.clear();
  }
  clear() {
    this.chunks = [];
    this.head = 0;
    this.length = 0;
    this.dropped = 0;
  }
  append(value) {
    let text = String(value ?? "");
    if (!text) return;
    if (text.length >= this.limit) {
      this.dropped += this.length + text.length - this.limit;
      this.chunks = [text.slice(-this.limit)];
      this.head = 0;
      this.length = this.limit;
      return;
    }
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > this.limit) {
      const first = this.chunks[this.head],
        excess = this.length - this.limit;
      if (first.length <= excess) {
        this.length -= first.length;
        this.dropped += first.length;
        this.chunks[this.head++] = "";
      } else {
        this.chunks[this.head] = first.slice(excess);
        this.length -= excess;
        this.dropped += excess;
      }
    }
    // Bound array overhead even with one-character chunks and long sessions.
    if (this.head > 256 && this.head > this.chunks.length / 2) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    if (this.chunks.length - this.head > 1024) {
      this.chunks = [this.text()];
      this.head = 0;
    }
  }
  text() {
    return this.chunks.slice(this.head).join("");
  }
  display() {
    const text = this.text();
    const marker = "...[older content truncated]\n";
    return this.dropped ? marker + text.slice(-(this.limit - marker.length)) : text;
  }
}
