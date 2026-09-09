#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const output = process.env.STAGING_FIXTURE_DIR ?? ".staging-fixture";
await mkdir(output, { recursive: true });
const manifest = { aliases: { openai: "tests/fixtures/openai-sdk.ts", "@google/genai": "tests/fixtures/google-sdk.ts" }, generatedAt: new Date().toISOString() };
const payload = JSON.stringify(manifest, null, 2);
await writeFile(join(output, "manifest.json"), payload);
await writeFile(join(output, "manifest.sha256"), `${createHash("sha256").update(payload).digest("hex")}  manifest.json\n`);
console.log(`staging fixture manifest written to ${output}`);
