import { Client } from "pg";
import { describe, expect, it } from "vitest";

const suite = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;
suite("runtime concurrency", () => {
  it("uses two real database sessions and never falls back locally", async () => {
    if (!process.env.TEST_DATABASE_URL || !process.env.STAGING_DB_CA) throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL and STAGING_DB_CA");
    const config = { connectionString: process.env.TEST_DATABASE_URL, ssl: { ca: process.env.STAGING_DB_CA, rejectUnauthorized: true } };
    const a = new Client(config), b = new Client(config);
    await Promise.all([a.connect(), b.connect()]);
    try {
      const [{ rows: ar }, { rows: br }] = await Promise.all([a.query("select pg_backend_pid() as pid"), b.query("select pg_backend_pid() as pid")]);
      expect(ar[0].pid).not.toBe(br[0].pid);
    } finally { await Promise.all([a.end(), b.end()]); }
  });
});
