import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Standalone test files must not write into the user's real Jev log directory. */
export function isolateJevLogs(): string {
  const previous = process.env.JEV_LOG_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-jev-test-logs-"));
  process.env.JEV_LOG_DIR = directory;
  after(() => {
    if (previous === undefined) delete process.env.JEV_LOG_DIR;
    else process.env.JEV_LOG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
