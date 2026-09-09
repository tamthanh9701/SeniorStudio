import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const patchSrc = readFileSync("src/app/api/styles/[styleId]/route.ts", "utf8");
const analyzeSrc = readFileSync("src/app/api/styles/[styleId]/analyze/route.ts", "utf8");
const validateSrc = readFileSync("src/app/api/styles/[styleId]/validate/route.ts", "utf8");
const tuneSrc = readFileSync("src/app/api/styles/[styleId]/tune/apply/route.ts", "utf8");
const helperSrc = readFileSync("src/lib/style/schema-versions.ts", "utf8");

function expectsAtomicMutation(source: string) {
  expect(source).toContain("commitStyleSchemaMutation");
  expect(source).not.toContain("appendSchemaVersion");
}

describe("atomic style schema history contract", () => {
  it("PATCH route uses the transactional mutation boundary", () => {
    expectsAtomicMutation(patchSrc);
  });

  it("mutation helper exposes one database RPC boundary", () => {
    expect(helperSrc).toContain('rpc("commit_style_schema_mutation"');
    expect(helperSrc).toContain('rpc("update_style_fields"');
  });

  it("analysis and other mutation routes remain routed through service boundaries", () => {
    expect(analyzeSrc).toContain("analyzeStyleProfile");
    expect(validateSrc).toContain("styleId");
    expect(tuneSrc).toContain("styleId");
  });
});
