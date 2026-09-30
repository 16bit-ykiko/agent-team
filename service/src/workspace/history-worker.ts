import { parentPort, workerData } from "worker_threads";
import {
  answer,
  HistoryIndex,
  querySql,
  type IndexRequest,
  type SqlRequest,
} from "./history-index";

// As a worker thread: keeps the search index up to date in the background,
// in short slices so a question never waits long behind it, and answers the
// questions. As a child process: runs one SQL query read from stdin, so a
// query that takes too long can be killed (SQLite cannot be interrupted).
if (parentPort) {
  const port = parentPort;
  const { file, historyFile } = workerData as { file: string; historyFile: string };
  const index = new HistoryIndex(file, historyFile);
  let pumping = false;
  const pump = () => {
    try {
      pumping = !index.sync(200);
    } catch (e) {
      console.error("[history-index]", e);
      pumping = false;
    }
    if (pumping) setImmediate(pump);
  };
  const wake = () => {
    if (pumping) return;
    pumping = true;
    setImmediate(pump);
  };
  port.on("message", (msg: { changed: true } | { id: number; req: IndexRequest }) => {
    if ("changed" in msg) {
      index.markDirty();
      wake();
      return;
    }
    try {
      port.postMessage({ id: msg.id, result: answer(index, msg.req, 100) });
    } catch (e) {
      port.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
    wake();
  });
  wake();
} else {
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => (input += chunk));
  process.stdin.on("end", () => {
    const req = JSON.parse(input) as SqlRequest & { file: string; historyFile: string };
    try {
      const result = querySql(req.file, req.historyFile, req.query, req.sessions, req.maxRows);
      process.stdout.write(JSON.stringify({ result }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
}
