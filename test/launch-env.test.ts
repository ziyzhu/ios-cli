import { describe, expect, test } from "bun:test";
import { localLaunchUrls, physicalLaunchEnvError } from "../src/launch-env.ts";

describe("physical launch environment", () => {
  test("finds local-only URL hosts", () => {
    expect(localLaunchUrls({
      LOCALHOST: "http://localhost:8000/path",
      LOOPBACK: "ws://127.42.0.9:9876/socket",
      IPV6: "http://[::1]:3000",
      UNSPECIFIED: "http://0.0.0.0:8080",
      SUBDOMAIN: "https://api.localhost/v1",
    })).toEqual([
      { key: "LOCALHOST", endpoint: "http://localhost:8000" },
      { key: "LOOPBACK", endpoint: "ws://127.42.0.9:9876" },
      { key: "IPV6", endpoint: "http://[::1]:3000" },
      { key: "UNSPECIFIED", endpoint: "http://0.0.0.0:8080" },
      { key: "SUBDOMAIN", endpoint: "https://api.localhost" },
    ]);
  });

  test("allows device-reachable URLs and non-URL values", () => {
    expect(localLaunchUrls({
      LAN: "http://192.168.1.20:8000",
      DNS: "https://api.example.com/v1",
      TOKEN: "localhost",
      PATH: "/tmp/socket",
    })).toEqual([]);
  });

  test("does not expose URL credentials, paths, or query values", () => {
    expect(physicalLaunchEnvError({ API: "http://user:secret@localhost:8000/private?token=secret" }))
      .toBe("physical target cannot use loopback launch URLs: API=http://localhost:8000. Override them with device-reachable URLs using --env KEY=VAL");
  });
});
