import { describe, expect, test } from "bun:test";
import { parseCompanionListing } from "../src/resolve.ts";

const UDID = "3C55382A-971A-47F0-9C3F-B83816C23ECD";
const OTHER = "BAC1F275-BE27-4147-A066-746670FD7E80";

describe("parseCompanionListing", () => {
  test("finds companions for the udid regardless of binary path and arg order", () => {
    const ps = [
      `  2776 /opt/homebrew/bin/idb_companion --udid ${OTHER} --grpc-port 49186`,
      `18092 idb_companion --udid ${UDID} --grpc-port 10883`,
      ` 3141 idb_companion --grpc-port 20001 --udid ${UDID}`,
      ` 9999 grep idb_companion`,
      `  123 /usr/bin/some-other-daemon --udid ${UDID}`,
    ].join("\n");
    expect(parseCompanionListing(ps, UDID)).toEqual([
      { pid: 18092, port: 10883 },
      { pid: 3141, port: 20001 },
    ]);
  });

  test("matches udids case-insensitively and returns nothing on no match", () => {
    const ps = `18092 idb_companion --udid ${UDID.toLowerCase()} --grpc-port 10883`;
    expect(parseCompanionListing(ps, UDID)).toEqual([{ pid: 18092, port: 10883 }]);
    expect(parseCompanionListing(ps, OTHER)).toEqual([]);
  });
});
