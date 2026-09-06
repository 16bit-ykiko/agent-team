import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Backend,
  SNAP_DIR,
  clientView,
  listFixtures,
  loadFixture,
  readRecording,
  recordingPath,
  replay,
  strip,
  transcript,
  agentMessages,
} from "./harness";

// Every <backend>/<name>.ts is one recorded interaction. The fixture's own
// verify() states why it exists; the pinned transcript catches everything
// else; the client aggregation must agree with the server's.
for (const backend of ["claude", "codex"] as Backend[]) {
  const names = listFixtures(backend);
  if (names.length === 0) continue;
  const fixtures = await Promise.all(names.map((n) => loadFixture(backend, n)));
  describe(backend, () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
    afterEach(() => vi.useRealTimers());
    names.forEach((name, i) => {
      const fixture = fixtures[i];
      it(`${name}: ${fixture.description}`, async () => {
        const file = recordingPath(backend, name);
        if (!fs.existsSync(file)) {
          throw new Error(
            `${backend}/${name} has no recording; run: npm run capture -- ${backend} ${name}`,
          );
        }
        const rec = readRecording(file);
        expect(rec.header.description, "description in the recording header").toBe(
          fixture.description,
        );
        const result = await replay(backend, rec);
        fixture.verify?.(result);
        await expect(transcript(result.messages)).toMatchFileSnapshot(
          path.join(SNAP_DIR, backend, `${name}.snap.md`),
        );
        const client = clientView(result.events);
        const server = agentMessages(result);
        expect(client.length, "client message count").toBe(server.length);
        server.forEach((m, j) => expect(strip(client[j]), `message ${j + 1}`).toEqual(strip(m)));
      });
    });
  });
}
