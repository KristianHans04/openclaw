import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { useAutoCleanupTempDirTracker, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let agentDir: string;
const ROUTER_KEY = "synthetic-router-key";
const CATALOG = {
  version: "clawrouter.client-catalog.v1",
  providers: [
    {
      id: "tavily",
      allowed: true,
      executable: true,
      nativeBaseUrl: "/v1/native/tavily",
      routes: [
        {
          path: "/search",
          methods: ["POST"],
          requestFormat: "tavily.search",
          responseFormat: "tavily.search",
        },
      ],
      models: [{ id: "tavily/search", upstream: "search", capabilities: ["web.search"] }],
    },
  ],
};
const SOURCES = {
  results: [
    {
      title: "A source",
      url: "https://example.com/source",
      content: "Evidence",
      score: 0.9,
      published_date: "2026-10-20",
    },
  ],
};

type SeenRequest = { path?: string; auth?: string; client?: string; body: unknown };
type ConfigOptions = {
  key?: string;
  allowPrivateNetwork?: boolean;
  headers?: Record<string, string>;
  requestHeaders?: Record<string, string>;
};

function registeredTool(origin: string, options: ConfigOptions = {}) {
  const config: OpenClawConfig = {
    models: {
      providers: {
        clawrouter: {
          baseUrl: origin + "/v1",
          apiKey: options.key ?? ROUTER_KEY,
          models: [],
          headers: options.headers,
          request: {
            allowPrivateNetwork: options.allowPrivateNetwork ?? true,
            headers: options.requestHeaders,
          },
        },
      },
    },
  };
  const fixture = createPluginRegistryFixture(config);
  registerVirtualTestPlugin({
    ...fixture,
    id: "clawrouter",
    name: "ClawRouter",
    contracts: manifest.contracts,
    register: plugin.register,
  });
  const entry = fixture.registry.registry.webSearchProviders.find(
    (candidate) => candidate.provider.id === "clawrouter-tavily",
  );
  expect(entry, "ClawRouter must register native Tavily search").toBeDefined();
  const tool = entry!.provider.createTool({
    config,
    agentDir,
  });
  if (!tool) {
    throw new Error("Missing registered Tavily tool");
  }
  return tool;
}

function sendJson(response: ServerResponse, payload: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function withRouter(
  run: (origin: string, seen: SeenRequest[]) => Promise<void>,
  respond?: (request: IncomingMessage, response: ServerResponse, seen: SeenRequest[]) => void,
) {
  const seen: SeenRequest[] = [];
  await withServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          path: request.url,
          auth: request.headers.authorization,
          client: request.headers["x-clawrouter-client"]?.toString(),
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
        });
        if (respond) {
          respond(request, response, seen);
        } else {
          sendJson(response, request.url === "/v1/catalog" ? CATALOG : SOURCES);
        }
      });
    },
    (origin) => run(origin, seen),
  );
}

beforeEach(() => {
  agentDir = tempDirs.make("clawrouter-native-tavily-");
  // Fixtures must never inherit an operator proxy or a vendor credential route.
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("TAVILY_API_KEY", "synthetic-vendor-key-must-not-be-used");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("runs native Tavily search with router auth through the production registry", async () => {
  await withRouter(async (origin, seen) => {
    const result = await registeredTool(origin).execute({ query: "synthetic question", count: 3 });
    expect(result).toMatchObject({
      provider: "clawrouter-tavily",
      count: 1,
      externalContent: { source: "web_search", provider: "clawrouter-tavily", untrusted: true },
      results: [
        {
          title: expect.stringContaining("A source"),
          snippet: expect.stringContaining("Evidence"),
          url: "https://example.com/source",
          score: 0.9,
          published: "2026-10-20",
        },
      ],
    });
    expect(seen.map(({ path, auth, client }) => [path, auth, client])).toEqual([
      ["/v1/catalog", "Bearer " + ROUTER_KEY, "openclaw"],
      ["/v1/native/tavily/search", "Bearer " + ROUTER_KEY, "openclaw"],
    ]);
    expect(seen[1]?.body).toEqual({ query: "synthetic question", max_results: 3 });
  });
});

it("preserves configured transport headers through the shared request policy", async () => {
  const headers: Array<[string | undefined, string | undefined]> = [];
  await withRouter(
    async (origin) => {
      await registeredTool(origin, {
        headers: { "X-Account": "synthetic-account", "X-Policy": "synthetic-provider-policy" },
        requestHeaders: { "X-Policy": "synthetic-request-policy" },
      }).execute({ query: "headers" });
      expect(headers).toEqual(
        Array.from({ length: 2 }, () => ["synthetic-account", "synthetic-request-policy"]),
      );
    },
    (request, response) => {
      headers.push([
        request.headers["x-account"]?.toString(),
        request.headers["x-policy"]?.toString(),
      ]);
      sendJson(response, request.url === "/v1/catalog" ? CATALOG : SOURCES);
    },
  );
});

it.each([401, 402, 403, 429])(
  "surfaces router denial %i without another request or vendor fallback",
  async (status) => {
    await withRouter(
      async (origin, seen) => {
        await expect(registeredTool(origin).execute({ query: "denied" })).rejects.toThrow(
          String(status),
        );
        expect(seen.map((request) => request.path)).toEqual([
          "/v1/catalog",
          "/v1/native/tavily/search",
        ]);
      },
      (request, response) =>
        sendJson(
          response,
          request.url === "/v1/catalog" ? CATALOG : { error: { message: "budget/auth denied" } },
          request.url === "/v1/catalog" ? 200 : status,
        ),
    );
  },
);

it.each([
  "missing",
  "denied",
  "unexecutable",
  "foreign-route",
  "unknown-format",
  "unknown-version",
  "wrong-model",
])("requires current scoped native capability: %s", async (kind) => {
  const catalog = structuredClone(CATALOG);
  const provider = catalog.providers[0]!;
  if (kind === "unknown-version") {
    catalog.version = "clawrouter.client-catalog.unknown";
  }
  if (kind === "missing") {
    catalog.providers = [];
  }
  if (kind === "denied") {
    provider.allowed = false;
  }
  if (kind === "unexecutable") {
    provider.executable = false;
  }
  if (kind === "foreign-route") {
    provider.nativeBaseUrl = "https://vendor.invalid/search";
  }
  if (kind === "unknown-format") {
    provider.routes[0]!.responseFormat = "unknown";
  }
  if (kind === "wrong-model") {
    provider.models[0]!.capabilities = ["web.extract"];
  }
  await withRouter(
    async (origin, seen) => {
      await expect(registeredTool(origin).execute({ query: "capability" })).rejects.toThrow(
        "does not advertise",
      );
      expect(seen.map((request) => request.path)).toEqual(["/v1/catalog"]);
    },
    (_request, response) => sendJson(response, catalog),
  );
});

it("does not reuse discovery across credentials or configured endpoints", async () => {
  await withRouter(
    async (origin, seen) => {
      await registeredTool(origin).execute({ query: "shared" });
      await expect(
        registeredTool(origin, { key: "synthetic-denied-key" }).execute({ query: "shared" }),
      ).rejects.toThrow("does not advertise");
      expect(seen.map((request) => request.path)).toEqual([
        "/v1/catalog",
        "/v1/native/tavily/search",
        "/v1/catalog",
      ]);
      expect(seen.at(-1)?.auth).toBe("Bearer synthetic-denied-key");
      await withRouter(
        async (other, otherSeen) => {
          await expect(registeredTool(other).execute({ query: "shared" })).rejects.toThrow(
            "does not advertise",
          );
          expect(otherSeen.map((request) => request.path)).toEqual(["/v1/catalog"]);
        },
        (_request, response) => sendJson(response, { providers: [] }),
      );
    },
    (request, response) =>
      sendJson(
        response,
        request.headers.authorization === "Bearer synthetic-denied-key"
          ? { providers: [] }
          : request.url === "/v1/catalog"
            ? CATALOG
            : SOURCES,
      ),
  );
});

it.each(["/v1/catalog", "/v1/native/tavily/search"])(
  "rejects redirects at %s without following the destination",
  async (stage) => {
    await withRouter(async (destination, diverted) => {
      await withRouter(
        async (origin, seen) => {
          await expect(registeredTool(origin).execute({ query: "redirect" })).rejects.toThrow();
          expect(diverted).toHaveLength(0);
          expect(seen).toHaveLength(stage === "/v1/catalog" ? 1 : 2);
        },
        (request, response) => {
          if (request.url === stage) {
            response.writeHead(302, { location: destination + "/leak" });
            response.end();
          } else {
            sendJson(response, CATALOG);
          }
        },
      );
    });
  },
);

it("blocks private destinations without the existing request opt-in", async () => {
  await withRouter(async (origin, seen) => {
    await expect(
      registeredTool(origin, { allowPrivateNetwork: false }).execute({ query: "private" }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

it.each([
  "file:///tmp/router",
  "https://user:pass@router.invalid",
  "https://router.invalid?token=bad",
  "https://router.invalid/#fragment",
])("rejects unsafe configured URL %s before dispatch", async (origin) => {
  await expect(registeredTool(origin).execute({ query: "bad URL" })).rejects.toThrow();
});

it.each(["missing-results", "array", "invalid-json", "oversized", "credential-echo"])(
  "rejects invalid or unbounded native payload: %s",
  async (kind) => {
    await withRouter(
      async (origin) => {
        await expect(registeredTool(origin).execute({ query: "malformed" })).rejects.toThrow();
      },
      (request, response) => {
        if (request.url === "/v1/catalog") {
          sendJson(response, CATALOG);
          return;
        }
        if (kind === "missing-results") {
          sendJson(response, {});
        }
        if (kind === "array") {
          sendJson(response, []);
        }
        if (kind === "invalid-json") {
          response.end("{broken");
        }
        if (kind === "oversized") {
          response.end(JSON.stringify({ results: [], answer: "x".repeat(4_194_304) }));
        }
        if (kind === "credential-echo") {
          sendJson(response, { results: [], answer: ROUTER_KEY });
        }
      },
    );
  },
);

it("accepts empty results and sanitizes/bounds source metadata through the shared normalizer", async () => {
  let calls = 0;
  await withRouter(
    async (origin) => {
      const tool = registeredTool(origin);
      await expect(tool.execute({ query: "empty" })).resolves.toMatchObject({
        count: 0,
        results: [],
      });
      const result = await tool.execute({ query: "bounded" });
      expect(result).toMatchObject({
        count: 1,
        truncated: true,
        results: [{ url: "https://example.com/valid" }],
      });
      const text = JSON.stringify(result);
      expect(text).not.toContain("javascript:");
      expect(text).not.toContain("not a date");
      expect(text.length).toBeLessThan(22_000);
    },
    (request, response) => {
      if (request.url === "/v1/catalog") {
        sendJson(response, CATALOG);
        return;
      }
      calls += 1;
      sendJson(
        response,
        calls === 1
          ? { results: [] }
          : {
              results: [
                { url: "javascript:alert(1)", content: "unsafe" },
                {
                  url: "https://example.com/valid",
                  title: "title",
                  content: "x".repeat(30_000),
                  published_date: "not a date",
                },
              ],
              answer: "y".repeat(30_000),
            },
      );
    },
  );
});

it("does not dispatch after cancellation or retired execution authority", async () => {
  await withRouter(async (origin, seen) => {
    const controller = new AbortController();
    const reason = new Error("owner cancelled");
    controller.abort(reason);
    await expect(
      registeredTool(origin).execute({ query: "cancel" }, { signal: controller.signal }),
    ).rejects.toBe(reason);
    await expect(
      registeredTool(origin).execute(
        { query: "retired" },
        {
          assertCurrent: () => {
            throw new Error("retired authority");
          },
        },
      ),
    ).rejects.toThrow("retired authority");
    expect(seen).toHaveLength(0);
  });
});

it("revalidates execution authority after discovery before native dispatch", async () => {
  let retired = false;
  await withRouter(
    async (origin, seen) => {
      await expect(
        registeredTool(origin).execute(
          { query: "retired after await" },
          {
            assertCurrent: () => {
              if (retired) {
                throw new Error("retired authority");
              }
            },
          },
        ),
      ).rejects.toThrow("retired authority");
      expect(seen.map((request) => request.path)).toEqual(["/v1/catalog"]);
    },
    (_request, response) => {
      retired = true;
      sendJson(response, CATALOG);
    },
  );
});

it.each(["catalog", "search"])(
  "cancels an in-flight %s response and closes its socket",
  async (stage) => {
    const received = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    await withRouter(
      async (origin, seen) => {
        const controller = new AbortController();
        const reason = new Error("owner cancelled in flight");
        const pending = registeredTool(origin).execute(
          { query: "cancel body" },
          { signal: controller.signal },
        );
        await received.promise;
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
        await closed.promise;
        expect(seen).toHaveLength(stage === "catalog" ? 1 : 2);
      },
      (request, response) => {
        if (stage === "search" && request.url === "/v1/catalog") {
          sendJson(response, CATALOG);
          return;
        }
        request.socket.once("close", () => closed.resolve());
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
        received.resolve();
      },
    );
  },
);
