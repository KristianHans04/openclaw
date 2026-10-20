import { describe, expect, it, vi } from "vitest";
import {
  extractTailscaleServeGatewayUrls,
  inspectTailscaleServeGatewayUrlsWithRunner as inspectServe,
  resolveTailnetHostWithRunner,
  resolveTailscalePublishedHost,
  resolveTailscaleServeGatewayUrlsWithRunner as resolveServe,
} from "./tailscale-status.js";

const handler = (Proxy: string, path = "/") => ({ Handlers: { [path]: { Proxy } } });
const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value) });
const runner = (value: unknown) => vi.fn().mockResolvedValue(result(value));

describe("shared/tailscale-status", () => {
  it("keeps the deprecated named-Service formatter for shipped plugin SDK callers", () => {
    expect(
      resolveTailscalePublishedHost({
        tailscaleMode: "serve",
        tailnetHost: "node.tailnet.ts.net",
        serviceName: "svc:openclaw",
      }),
    ).toBe("openclaw.tailnet.ts.net");
  });

  it("returns null when no runner is provided", async () => {
    await expect(resolveTailnetHostWithRunner()).resolves.toBeNull();
  });

  it("falls back across command candidates and then to the first tailscale ip", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing binary"))
      .mockResolvedValueOnce(result({ Self: { TailscaleIPs: ["100.64.0.9", "fd7a::1"] } }));

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("100.64.0.9");
    expect(run).toHaveBeenNthCalledWith(
      2,
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "status", "--json"],
      { timeoutMs: 5000 },
    );
  });

  it("continues to later command candidates when earlier output has no usable host", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result({ Self: {} }))
      .mockResolvedValueOnce(result({ Self: { DNSName: "backup.tail.ts.net." } }));

    await expect(resolveTailnetHostWithRunner(run)).resolves.toBe("backup.tail.ts.net");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns null for non-zero exits, blank output, or invalid json", async () => {
    for (const commandResult of [
      { code: null, stdout: "boom" },
      { code: 1, stdout: "boom" },
      { code: 0, stdout: "   " },
      { code: 0, stdout: "not-json" },
    ]) {
      const run = vi.fn().mockResolvedValue(commandResult);
      await expect(resolveTailnetHostWithRunner(run)).resolves.toBeNull();
    }
  });

  it.each(["localhost:18789", "18789"])(
    "discovers SDK proxy %s without ownership",
    async (proxy) => {
      const run = runner({
        TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
        Web: {
          "mac.tail.ts.net:443": handler("http://127.0.0.1:8096"),
          "mac.tail.ts.net:8443": handler(proxy),
        },
      });

      await expect(resolveServe(18789, run)).resolves.toEqual(["wss://mac.tail.ts.net:8443"]);
      expect(run).toHaveBeenCalledWith(["tailscale", "serve", "status", "--json"], {
        timeoutMs: 5000,
      });
    },
  );

  it("ignores non-root, non-HTTPS, and non-loopback Serve handlers", async () => {
    const run = runner({
      TCP: { "80": { HTTP: true }, "443": { HTTPS: true } },
      Web: {
        "mac.tail.ts.net:80": handler("http://127.0.0.1:18789"),
        "mac.tail.ts.net:443": handler("http://127.0.0.1:18789", "/openclaw"),
        "other.tail.ts.net:443": handler("http://192.168.1.20:18789"),
      },
    });

    await expect(resolveServe(18789, run)).resolves.toEqual([]);
  });

  it("ignores load-balanced Tailscale Services and public Funnel routes", async () => {
    const run = runner({
      TCP: { "443": { HTTPS: true } },
      Web: { "mac.tail.ts.net:443": handler("127.0.0.1:18789") },
      AllowFunnel: { "mac.tail.ts.net:443": true },
      Services: {
        "svc:openclaw": {
          TCP: { "443": { HTTPS: true } },
          Web: { "openclaw.tail.ts.net:443": handler("127.0.0.1:18789") },
        },
      },
    });

    await expect(resolveServe(18789, run)).resolves.toEqual([]);
  });

  it.each([
    [8443, "http://127.0.0.1:8096"],
    [443, "https://127.0.0.1:18789"],
    [443, "http://127.0.0.1:18789/api"],
    [443, "http://127.0.0.1:18789/?other"],
    [443, "http://192.0.2.1:18789"],
  ])("rejects ownership of HTTPS port %s targeting %s", (httpsPort, proxy) => {
    const host = `fixture.tail.ts.net:${httpsPort}`;
    const raw = JSON.stringify({
      TCP: { [httpsPort]: { HTTPS: true } },
      Web: { [host]: handler(proxy) },
      AllowFunnel: { [host]: true },
    });
    expect(extractTailscaleServeGatewayUrls(raw, 18789, true)).toEqual([]);
  });

  it.each([
    [443, 443, false],
    [443, 8443, true],
  ])(
    "requires HTTPS port %s to be exclusive across hostnames (sibling port %s)",
    (port, siblingPort, owned) => {
      const url = `wss://old.tail.ts.net${port === 443 ? "" : `:${port}`}`;
      const raw = JSON.stringify({
        TCP: { [port]: { HTTPS: true }, [siblingPort]: { HTTPS: true } },
        Web: {
          [`old.tail.ts.net:${port}`]: handler("http://127.0.0.1:18789"),
          [`current.tail.ts.net:${siblingPort}`]: handler("http://127.0.0.1:8096"),
        },
      });
      expect(extractTailscaleServeGatewayUrls(raw, 18789, true)).toEqual(owned ? [url] : []);
      expect(extractTailscaleServeGatewayUrls(raw, 18789)).toEqual([url]);
    },
  );

  it("distinguishes malformed Serve status from an empty valid configuration", async () => {
    const malformed = vi.fn().mockResolvedValue({ code: 0, stdout: "not-json" });
    const empty = runner({});

    await expect(inspectServe(18789, malformed)).resolves.toEqual({
      status: "invalid",
    });
    await expect(inspectServe(18789, empty)).resolves.toEqual({
      status: "ok",
      urls: [],
    });
    await expect(resolveServe(18789, malformed)).resolves.toEqual([]);
  });
});
