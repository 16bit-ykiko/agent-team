import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";

// The conversation agy runs a subagent in. ACP names none (invoke_subagent
// returns at once, session/list leaves subagents out), but agy keeps each
// conversation as `~/.gemini/antigravity-cli/conversations/<id>.db`, and a
// subagent's first step holds the call that started it (agy 1.5.8, snap
// fixture agy/subagent). Read only; a conversation found is then loaded
// over ACP like any other.
const CONVERSATIONS = () => path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");

export function findSubagentConversation(callId: string, since: number): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(CONVERSATIONS()).filter((n) => n.endsWith(".db"));
  } catch {
    return null;
  }
  const needle = Buffer.from(callId);
  for (const name of names) {
    const file = path.join(CONVERSATIONS(), name);
    try {
      // Created before the call: not its subagent.
      const st = fs.statSync(file);
      // Where the file system keeps no birth time, its last write.
      if ((st.birthtimeMs || st.mtimeMs) < since - 5_000) continue;
    } catch {
      continue;
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const row = db.prepare("SELECT step_payload FROM steps WHERE idx = 0").get() as
        { step_payload: Uint8Array | null } | undefined;
      if (row?.step_payload && Buffer.from(row.step_payload).includes(needle)) {
        return name.slice(0, -".db".length);
      }
    } catch {
      // not one of agy's, or being written
    } finally {
      db?.close();
    }
  }
  return null;
}
