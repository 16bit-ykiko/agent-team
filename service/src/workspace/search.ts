// Full-history message search. The client only holds lazily-loaded message
// windows, so search runs server-side over everything in memory.

export interface SearchSource {
  id: string;
  name: string;
  messages: Array<{
    id: string;
    kind: string;
    content: string;
    timestamp: number;
  }>;
}

export interface SearchHit {
  workspaceId: string;
  workspaceName: string;
  messageId: string;
  timestamp: number;
  snippet: string;
}

const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 56;

// Case-insensitive AND over whitespace-separated terms. A term matches if it
// appears in the message content or in the workspace name (so "clice crash"
// finds "crash" inside the clice workspace). Results are newest-first.
export function searchMessages(sources: SearchSource[], query: string, limit = 50): SearchHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const ws of sources) {
    const wsName = ws.name.toLowerCase();
    for (const msg of ws.messages) {
      if (msg.kind === "system" || !msg.content) continue;
      const text = msg.content.toLowerCase();
      let firstIdx = -1;
      let ok = true;
      for (const term of terms) {
        const idx = text.indexOf(term);
        if (idx !== -1) {
          if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
        } else if (!wsName.includes(term)) {
          ok = false;
          break;
        }
      }
      // At least one term must hit the content itself, otherwise every
      // message in a name-matched workspace would qualify.
      if (!ok || firstIdx === -1) continue;

      const start = Math.max(0, firstIdx - SNIPPET_BEFORE);
      const end = Math.min(msg.content.length, firstIdx + SNIPPET_AFTER);
      hits.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        messageId: msg.id,
        timestamp: msg.timestamp,
        snippet:
          (start > 0 ? "..." : "") +
          msg.content.slice(start, end).replace(/\n+/g, " ") +
          (end < msg.content.length ? "..." : ""),
      });
    }
  }

  hits.sort((a, b) => b.timestamp - a.timestamp);
  return hits.slice(0, limit);
}
