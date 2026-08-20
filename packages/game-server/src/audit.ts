import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { appendFile } from "node:fs/promises";

export class MatchAudit {
  private digest = "0".repeat(64);
  private writeQueue = Promise.resolve();

  constructor(private readonly matchId: string, private readonly path = process.env.GAME_AUDIT_LOG_PATH) {
    if (path) closeSync(openSync(path, "a", 0o600));
  }

  record(type: string, data: object, at = Date.now()): void {
    const entry = { version: 1, matchId: this.matchId, at, type, data, previousHash: this.digest };
    const canonical = JSON.stringify(entry);
    this.digest = createHash("sha256").update(canonical).digest("hex");
    if (!this.path) return;
    const line = `${JSON.stringify({ ...entry, hash: this.digest })}\n`;
    this.writeQueue = this.writeQueue.then(() => appendFile(this.path!, line, { encoding: "utf8", mode: 0o600 })).catch((error) => {
      console.error("Failed to append game audit record", error);
    });
  }

  hash(): string { return this.digest; }
  flush(): Promise<void> { return this.writeQueue; }
}
