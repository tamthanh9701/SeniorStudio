import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const requested = process.env.RUN_DB_INTEGRATION === "1";
const missing = ["TEST_DATABASE_URL", "STAGING_DB_CA"].filter((key) => !process.env[key]);
const suite = requested ? describe : describe.skip;

suite("runtime pgTAP contracts", () => {
  it("runs the contract TAP script in a rollback-only transaction", async () => {
    if (missing.length) throw new Error(`RUN_DB_INTEGRATION=1 requires ${missing.join(", ")}`);
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: { ca: process.env.STAGING_DB_CA, rejectUnauthorized: true } });
    await client.connect();
    try {
      await client.query("begin");
      const sql = await readFile(new URL("./runtime-contracts.sql", import.meta.url), "utf8");
      const result = await client.query(sql);
      const tap = result.rows.map((row) => Object.values(row).join(" ")).join("\n");
      expect(tap).not.toMatch(/\bnot ok\b|Bail out!/i);
      expect(tap).toMatch(/1\.\.4/);
      await client.query("rollback");
    } finally { await client.end(); }
  });
});
