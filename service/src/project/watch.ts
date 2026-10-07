import * as fs from "fs";

// Calls `onChange` (debounced) when the files a store keeps change on disk
// by other hands; the store's own writes do not echo back once it calls
// settled().
//
// Recursive fs.watch on Linux follows files by inode and goes blind to a
// file once it has been replaced (tmp + rename) twice: the directories
// themselves are watched instead, the set re-read on every change.
export class DirWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seen: string;
  private closed = false;

  constructor(
    private dirs: () => string[],
    private signature: () => string,
    private onChange: () => void,
    private label: string,
  ) {
    this.seen = signature();
    this.rewatch();
  }

  // After the store's own change: what the watcher will see is known.
  settled(): void {
    this.seen = this.signature();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private rewatch(): void {
    const dirs = this.dirs();
    for (const d of dirs) {
      if (this.watchers.has(d)) continue;
      try {
        const w = fs.watch(d, () => this.poke());
        w.on("error", () => {
          w.close();
          this.watchers.delete(d);
        });
        this.watchers.set(d, w);
      } catch {
        // Gone again; the next event rescans.
      }
    }
    for (const [d, w] of this.watchers) {
      if (!dirs.includes(d)) {
        w.close();
        this.watchers.delete(d);
      }
    }
  }

  private poke(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.closed) return;
      try {
        this.rewatch();
        const now = this.signature();
        if (now === this.seen) return;
        this.seen = now;
        this.onChange();
      } catch (e) {
        console.error(`[projects] ${this.label}: change not picked up`, e);
      }
    }, 200);
  }
}

// What changes when any of `files` is replaced, grows or goes away.
export function filesSignature(files: string[]): string {
  return files
    .map((file) => {
      try {
        const st = fs.statSync(file);
        return `${file}:${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        return "";
      }
    })
    .join("\n");
}
