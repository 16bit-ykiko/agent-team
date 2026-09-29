// An Emacs lock file (a dangling .#x.toml symlink) appearing in an area must
// not throw from the watcher's timer: in the server that would be an
// uncaughtException, which exits the process.
import { it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { setupProjects as setup, tick } from "./projectHarness";

it("an editor lock file appearing does not throw from the watcher", async () => {
  const { create, call, base } = setup();
  const { project, lead } = create("p");
  await call(lead, "write_objective", { id: "a/x", title: "x", goal: "g" });
  for (let i = 0; i < 60; i++) await tick();
  const errors: unknown[] = [];
  const listeners = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (e) => errors.push(e));
  try {
    const dir = path.join(base, ".agent-team", "projects", project.id, "objectives", "a");
    fs.symlinkSync("ykiko@host.123:456", path.join(dir, ".#x.toml"));
    for (let i = 0; i < 100 && errors.length === 0; i++) await tick();
  } finally {
    process.removeAllListeners("uncaughtException");
    for (const l of listeners) process.on("uncaughtException", l);
  }
  expect(errors.map(String)).toEqual([]);
});
