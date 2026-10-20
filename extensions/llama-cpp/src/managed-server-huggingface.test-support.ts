import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { vi } from "vitest";

const TEST_GGUF_SHA256 = "b83633aa785344791618f2fddf131b010ea04912a60430760b070bad293f65bd";

export async function withHuggingFaceMetadataFixture(
  { cacheDir, servers }: { cacheDir: string; servers: http.Server[] },
  endpoint: "manifest" | "file" | "tree",
  run: (params: {
    cacheDir: string;
    setMetadataAvailable: (available: boolean) => void;
    setPadding: (target: "manifest" | "file" | "tree", padding: string) => void;
    source: string;
  }) => Promise<void>,
  source = "hf:owner/repo",
): Promise<void> {
  await fs.writeFile(path.join(cacheDir, "hf_owner_repo_model.gguf"), "GGUF");
  let padding = "x".repeat(1024 * 1024);
  let metadataAvailable = true;
  const paddedFiles = (target: typeof endpoint) => [
    { path: "model.gguf", size: 4, lfs: { oid: TEST_GGUF_SHA256 } },
    ...(endpoint === target ? [padding] : []),
  ];
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const send = (body: unknown) => res.end(JSON.stringify(body));
    if (!metadataAvailable) {
      res.statusCode = 503;
      send({});
    } else if (req.url?.startsWith("/v2/owner/repo/manifests/latest")) {
      send({
        ggufFile: { rfilename: "model.gguf", size: 4 },
        ...(endpoint === "manifest" ? { padding } : {}),
      });
    } else if (req.url?.startsWith("/api/models/owner/repo/paths-info/")) {
      req.on("end", () => send(paddedFiles("file")));
      req.resume();
    } else if (req.url?.startsWith("/api/models/owner/repo/tree/")) {
      send(paddedFiles("tree"));
    } else {
      res.statusCode = 404;
      send({});
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const upstream = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return await realFetch(`http://127.0.0.1:${address.port}${upstream.pathname}`, init);
  });
  try {
    await run({
      cacheDir,
      setMetadataAvailable: (available) => {
        metadataAvailable = available;
      },
      setPadding: (target, next) => {
        if (target === endpoint) {
          padding = next;
        }
      },
      source,
    });
  } finally {
    vi.unstubAllGlobals();
  }
}
