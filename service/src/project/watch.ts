import * as fs from "fs";

// Calls `onChange` (debounced) when the files a store keeps change on disk
// by other hands; the store's own writes do not echo back once it calls
// settled().
//
// Recursive fs.watch on Linux follows files by inode and goes blind to a
// file once it has been replaced (tmp + rename) twice: the directories
// themselves are watched instead, the set re-read on every change. A
// directory replaced whole (rm -r, then mv) keeps its old watcher alive
// and deaf, so each is known by its inode, and the store's parent
// directory is in the set to hear the replacement.
export class DirWatcher {
  private watchers = new Map<string, { watcher: fs.FSWatcher; ino: number }>();
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
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private rewatch(): void {
    const dirs = new Map<string, number>();
    for (const d of this.dirs()) {
      try {
        const st = fs.statSync(d);
        if (st.isDirectory()) dirs.set(d, st.ino);
      } catch {
        // Not there (yet); the parent's events rescan.
      }
    }
    for (const [d, w] of this.watchers) {
      if (dirs.get(d) !== w.ino) {
        w.watcher.close();
        this.watchers.delete(d);
      }
    }
    for (const [d, ino] of dirs) {
      if (this.watchers.has(d)) continue;
      try {
        const watcher = fs.watch(d, () => this.poke());
        watcher.on("error", () => {
          watcher.close();
          if (this.watchers.get(d)?.watcher === watcher) this.watchers.delete(d);
        });
        this.watchers.set(d, { watcher, ino });
      } catch {
        // Gone again; the next event rescans.
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
