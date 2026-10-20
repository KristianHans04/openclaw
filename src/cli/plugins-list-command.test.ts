import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import type { PluginsListOptions } from "./plugins-list-command.js";

function createJsonRuntime(writes: unknown[]): OutputRuntimeEnv {
  return {
    log: (...args: unknown[]) => writes.push(args.length === 1 ? args[0] : args),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeStdout: (value: string) => writes.push(value),
    writeJson: (value: unknown) => writes.push(value),
  };
}

type SnapshotPlugin = {
  id: string;
  enabled: boolean;
  commands?: string[];
  agentHarnessIds?: string[];
};

function mockPluginListSnapshot(
  plugins: SnapshotPlugin[],
  config: OpenClawConfig = {},
  scope?: {
    workspaceDir?: string;
    workspaceScope: "selected" | "omitted";
    diagnostics?: Array<{ level: "warn"; code: "workspace-scope-omitted"; message: string }>;
  },
): void {
  // mock-isolation: Each plugin-list fixture supplies its config without loading operator state.
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: () => config,
    loadConfig: () => config,
    captureRuntimeConfigAsyncReader: () => async () => config,
  }));
  vi.doMock("../plugins/status-snapshot.js", () => ({
    buildPluginRegistrySnapshotReport: () => ({
      workspaceDir: scope?.workspaceDir ?? "/workspace",
      workspaceScope: scope?.workspaceScope ?? "selected",
      registrySource: "config",
      registryDiagnostics: [],
      plugins,
      diagnostics: scope?.diagnostics ?? [],
    }),
  }));
}

function mockHumanListModules(importedModules: string[] = []): void {
  const identity = (value: string) => value;
  const modules = {
    "../plugins/source-display.js": {
      formatPluginSourceForTable: vi.fn(),
      resolvePluginSourceRoots: vi.fn(),
    },
    "../../packages/terminal-core/src/table.js": {
      getTerminalTableWidth: vi.fn(),
      renderTable: vi.fn(),
    },
    "../../packages/terminal-core/src/theme.js": { theme: { muted: identity, warn: identity } },
    "./command-format.js": { formatCliCommand: (value: string) => `formatted(${value})` },
    "./plugins-list-format.js": { formatPluginLine: vi.fn(), formatPluginStatus: vi.fn() },
  };
  for (const [module, exports] of Object.entries(modules)) {
    vi.doMock(module, () => {
      importedModules.push(module);
      return exports;
    });
  }
}

async function runList(options: PluginsListOptions) {
  const { runPluginsListCommand } = await import("./plugins-list-command.js");
  const writes: unknown[] = [];
  await runPluginsListCommand(options, createJsonRuntime(writes));
  return writes;
}

describe("runPluginsListCommand", () => {
  afterEach(() => {
    vi.doUnmock("../config/config.js");
    vi.doUnmock("../plugins/status.js");
    vi.doUnmock("../plugins/status-snapshot.js");
    vi.doUnmock("../plugins/source-display.js");
    vi.doUnmock("../../packages/terminal-core/src/table.js");
    vi.doUnmock("../../packages/terminal-core/src/theme.js");
    vi.doUnmock("./command-format.js");
    vi.doUnmock("./plugins-list-format.js");
    vi.resetModules();
  });

  it("does not import human list renderers for JSON output", async () => {
    vi.resetModules();
    const importedHumanModules: string[] = [];

    vi.doMock("../plugins/status.js", () => {
      throw new Error("plugins list JSON must use the snapshot status module");
    });
    vi.doMock("./plugins-command-helpers.js", () => {
      throw new Error("plugins list JSON must not import plugin command helpers");
    });
    mockPluginListSnapshot([
      { id: "demo", enabled: true, commands: ["demo"], agentHarnessIds: ["runtime-only"] },
    ]);
    mockHumanListModules(importedHumanModules);

    const writes = await runList({ json: true });

    expect(importedHumanModules).toEqual([]);
    expect(writes).toEqual([
      {
        workspaceDir: "/workspace",
        workspaceScope: "selected",
        registry: { source: "config", diagnostics: [] },
        plugins: [{ id: "demo", enabled: true, commands: ["demo"] }],
        diagnostics: [],
      },
    ]);
  });

  it("explains an empty enabled-only list when plugins are installed", async () => {
    mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }]);
    mockHumanListModules();
    expect(await runList({ enabled: true })).toEqual([
      "No enabled plugins found. Run formatted(openclaw plugins list) to inspect installed plugins.",
    ]);
  });

  it("explains a globally disabled plugin inventory", async () => {
    mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }], {
      plugins: { enabled: false },
    });
    mockHumanListModules();
    expect(await runList({ enabled: true, verbose: true })).toEqual([
      "No enabled plugins found. Plugins are globally disabled. Run formatted(openclaw plugins list) to inspect installed plugins.",
    ]);
  });

  it("makes omitted workspace plugin scope visible in human output", async () => {
    const message =
      "Workspace plugin discovery was skipped; set agents.defaults.systemAgent.agentId.";
    mockPluginListSnapshot(
      [],
      {},
      {
        workspaceScope: "omitted",
        diagnostics: [{ level: "warn", code: "workspace-scope-omitted", message }],
      },
    );
    mockHumanListModules();
    expect(await runList({})).toEqual([
      `Warning: ${message}`,
      "",
      "No plugins found. Run formatted(openclaw plugins install <plugin>) to add one, or formatted(openclaw plugins list --json) to inspect raw discovery state.",
    ]);
  });
});
