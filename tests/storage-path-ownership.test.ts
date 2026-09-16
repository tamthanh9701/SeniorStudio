// @vitest-environment node
// Privileged storage deletion must not trust a path just because it was read
// from a row: workspace members write those rows (asset_versions, assets) and
// the style hard-delete once destroyed an unrelated object this way.
import { describe, expect, it } from "vitest";

import { filterOwnedStoragePaths } from "../src/lib/assets/ownership";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const STYLE = "33333333-3333-4333-8333-333333333333";
const OTHER_STYLE = "44444444-4444-4444-8444-444444444444";
const PREFIX = [`${WS}/styles/${STYLE}/`];

describe("filterOwnedStoragePaths", () => {
  it("keeps objects of the deleted style", () => {
    const { owned, rejected } = filterOwnedStoragePaths(
      [`${WS}/styles/${STYLE}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`, `${WS}/styles/${STYLE}/outputs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc/source.png`],
      PREFIX,
    );
    expect(owned).toHaveLength(2);
    expect(rejected).toEqual([]);
  });

  it("refuses another style of the same workspace", () => {
    const foreign = `${WS}/styles/${OTHER_STYLE}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png`;
    expect(filterOwnedStoragePaths([foreign], PREFIX)).toEqual({ owned: [], rejected: [foreign] });
  });

  it("refuses another workspace", () => {
    const foreign = `${OTHER_WS}/styles/${STYLE}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png`;
    expect(filterOwnedStoragePaths([foreign], PREFIX).owned).toEqual([]);
  });

  it("refuses traversal and malformed paths instead of passing them on", () => {
    const { owned, rejected } = filterOwnedStoragePaths(
      [`${WS}/styles/${STYLE}/../../${OTHER_WS}/x.png`, `/${WS}/styles/${STYLE}/f.png`, "..%2fescape.png", null, undefined, ""],
      PREFIX,
    );
    expect(owned).toEqual([]);
    expect(rejected).toHaveLength(3);
  });

  it("requires the full prefix, not just a shared beginning", () => {
    // `${WS}/styles/${STYLE}-suffix/...` must not pass a prefix test that lacks a separator.
    expect(filterOwnedStoragePaths([`${WS}/styles/${STYLE}-evil/ffffffff-ffff-4fff-8fff-ffffffffffff.png`], PREFIX).owned).toEqual([]);
  });
});
