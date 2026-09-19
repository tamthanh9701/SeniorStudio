// Pack assembly runs in the browser so a multi-image archive never has to pass
// through a serverless response body. Entries are stored (level 0): PNG bytes are
// already compressed, so re-compressing only costs memory and time.

import { zipSync } from "fflate";
import { GameUiError } from "./errors";

export const MANIFEST_ENTRY_PATH = "manifest.json";

const ASSET_ENTRY_PATTERN = /^assets\/[^/\\]+\.png$/;

export type PackFile = { path: string; bytes: Uint8Array };

/** Archive bytes backed by a plain ArrayBuffer, as Blob and WebCrypto require. */
export type PackArchive = Uint8Array<ArrayBuffer>;

/**
 * Builds the downloadable archive: manifest.json first, then one stored PNG per
 * verified file. Paths are re-checked here because they come from network data
 * and an archive entry is the one place a bad path escapes a flat directory.
 */
export async function buildAssetZip(files: PackFile[], manifest: unknown): Promise<PackArchive> {
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY_PATH]: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };

  for (const file of files) {
    if (file.path.includes("..") || !ASSET_ENTRY_PATTERN.test(file.path)) {
      throw new GameUiError("INVALID_REQUEST", `Unsafe pack entry path: ${file.path}`);
    }
    if (Object.hasOwn(entries, file.path)) {
      throw new GameUiError("INVALID_REQUEST", `Duplicate pack entry path: ${file.path}`);
    }
    entries[file.path] = file.bytes;
  }

  // fflate declares Uint8Array<ArrayBufferLike>, but zipSync allocates a plain
  // ArrayBuffer: only the SharedArrayBuffer union member is unrepresentable.
  return zipSync(entries, { level: 0 }) as PackArchive;
}
