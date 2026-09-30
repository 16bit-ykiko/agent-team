import { parentPort, workerData } from "worker_threads";
import { answer, HistoryIndex, type IndexRequest } from "./history-index";

// Keeps the search index up to date in the background, in short slices so
// a question never waits long behind it, and answers the questions.
const { file, historyFile } = workerData as { file: string; historyFile: string };
const index = new HistoryIndex(file, historyFile);
const port = parentPort!;

let pumping = false;
const pump = () => {
  pumping = !index.sync(200);
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
