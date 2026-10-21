// Run with node --expose-gc --import ./scripts/tsx.mjs scripts/perf/diagnostic-event-pipeline-measure.ts.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  hasPendingInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventInput,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../../src/infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../src/infra/diagnostic-otel-listener-provenance.js";
import { registerDiagnosticTracePropagationBridge } from "../../src/infra/diagnostic-trace-propagation.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "plain" },
    cycles: { type: "string", default: "500" },
    warmup: { type: "string", default: "50" },
    "sampling-interval": { type: "string", default: "1024" },
    revision: { type: "string" },
    output: { type: "string" },
  },
});
assert(["plain", "opaque", "no-interest"].includes(values.scenario));
assert(globalThis.gc, "Run Node with --expose-gc");
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const cycles = integer(values.cycles, "--cycles");
const warmup = integer(values.warmup, "--warmup", 0);
const samplingInterval = integer(values["sampling-interval"], "--sampling-interval");
const interested = values.scenario !== "no-interest";

function createFixtures(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const base = {
      runId: `run-${index}`,
      sessionKey: "agent:main:synthetic-diagnostics",
      callId: `model-${index}`,
      provider: "synthetic",
      model: "fixture",
    };
    const modelContent = {
      inputMessages: Array.from({ length: 16 }, (_messageValue, message) => ({
        role: message % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Synthetic message ${message}. `.repeat(80) }],
      })),
      toolDefinitions: Array.from({ length: 8 }, (_toolValue, tool) => ({
        name: `synthetic_tool_${tool}`,
        description: "Synthetic tool description",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      })),
      outputMessages: [
        { role: "assistant", content: [{ type: "text", text: "Synthetic answer" }] },
      ],
    };
    return {
      started: { ...base, type: "model.call.started" } satisfies DiagnosticEventInput,
      completed: {
        ...base,
        type: "model.call.completed",
        durationMs: 100,
        usage: { input: 200, output: 20 },
      } satisfies DiagnosticEventInput,
      tool: {
        type: "tool.execution.completed",
        runId: base.runId,
        toolCallId: `tool-${index}`,
        toolName: "synthetic_read",
        durationMs: 10,
      } satisfies DiagnosticEventInput,
      publicEvent: {
        type: "message.queued",
        source: "synthetic",
        ...(values.scenario === "opaque"
          ? { opaque: { map: new Map([["value", 42]]), bytes: new Uint8Array([42]) } }
          : {}),
      } satisfies DiagnosticEventInput & { opaque?: object },
      modelPrivate: { modelContent } satisfies DiagnosticEventPrivateData,
      toolPrivate: {
        toolContent: {
          toolInput: { path: "/synthetic/fixture.txt" },
          toolOutput: { content: [{ type: "text", text: "Synthetic tool output. ".repeat(300) }] },
        },
      } satisfies DiagnosticEventPrivateData,
    };
  });
}

function assertOpaque(
  value: unknown,
): asserts value is { map: Map<unknown, unknown>; bytes: Uint8Array } {
  assert(value && typeof value === "object");
  assert("map" in value && value.map instanceof Map);
  assert("bytes" in value && value.bytes instanceof Uint8Array);
}

function readOpaque(event: DiagnosticEventPayload) {
  const value: unknown = Reflect.get(event, "opaque");
  assertOpaque(value);
  return value;
}

function installConsumers() {
  resetDiagnosticEventsForTest();
  const counts = {
    public: 0,
    otel: 0,
    collector: 0,
    prepared: 0,
    pending: 0,
    errors: 0,
    content: 0,
  };
  if (interested) {
    onDiagnosticEvent((event) => {
      counts.public++;
      if (values.scenario === "opaque") {
        try {
          const opaque = readOpaque(event);
          opaque.map.set("value", 0);
          opaque.bytes[0] = 0;
        } catch {
          counts.errors++;
        }
      }
    });
    onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((_event, _metadata, data) => {
        counts.otel++;
        counts.content +=
          Number(data.modelContent !== undefined) + Number(data.toolContent !== undefined);
      }),
    );
    onTrustedInternalDiagnosticEvent((event, _metadata, data) => {
      counts.collector++;
      counts.content +=
        Number(data.modelContent !== undefined) + Number(data.toolContent !== undefined);
      if (values.scenario === "opaque" && event.type === "message.queued") {
        try {
          const opaque = readOpaque(event);
          counts.errors += Number(opaque.map.get("value") !== 42 || opaque.bytes[0] !== 42);
        } catch {
          counts.errors++;
        }
      }
    });
    registerDiagnosticTracePropagationBridge({
      shouldPrepareEvent: (event: DiagnosticEventPayload) => event.type === "model.call.started",
      prepareEvent: () => {
        counts.prepared++;
      },
      resolveTraceContext: (context) => context,
    });
  }
  return counts;
}

async function dispatch(
  fixtures: ReturnType<typeof createFixtures>,
  counts: ReturnType<typeof installConsumers>,
) {
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index]!;
    emitTrustedDiagnosticEventWithPrivateData(fixture.started, fixture.modelPrivate);
    emitTrustedDiagnosticEventWithPrivateData(fixture.completed, fixture.modelPrivate);
    emitTrustedDiagnosticEventWithPrivateData(fixture.tool, fixture.toolPrivate);
    emitDiagnosticEvent(fixture.publicEvent);
    counts.pending += Number(
      hasPendingInternalDiagnosticEvent((event) => event.type === "model.call.completed"),
    );
    // Bound the queue below its drop limit while preserving real asynchronous dispatch.
    if (index % 16 === 15) {
      await waitForDiagnosticEventsDrained();
    }
  }
  await waitForDiagnosticEventsDrained();
}

function verify(counts: ReturnType<typeof installConsumers>, count: number) {
  assert.deepEqual(counts, {
    public: interested ? count : 0,
    otel: interested ? count * 4 : 0,
    collector: interested ? count * 4 : 0,
    prepared: interested ? count : 0,
    pending: interested ? count : 0,
    errors: 0,
    content: interested ? count * 6 : 0,
  });
}

function summarize(profile: HeapProfiler.SamplingHeapProfile) {
  const categories: Record<string, number> = {};
  const pending = [{ node: profile.head, category: "other" }];
  for (const { node, category: inherited } of pending) {
    const name = node.callFrame.functionName;
    const category =
      name === "structuredClone"
        ? "structuredClone"
        : inherited === "structuredClone"
          ? inherited
          : name === "projectDiagnosticValue"
            ? "projection"
            : /[Ff]reeze.*(?:Diagnostic|Json)|freezeDiagnosticValue/.test(name)
              ? "freeze"
              : node.callFrame.url.includes("diagnostic-event")
                ? "dispatcher"
                : inherited;
    categories[category] = (categories[category] ?? 0) + node.selfSize;
    for (const child of node.children) {
      pending.push({ node: child, category });
    }
  }
  return {
    sampledAllocatedBytes: Object.values(categories).reduce((total, bytes) => total + bytes, 0),
    sampledBytesByCategory: categories,
  };
}

const setupStart = performance.now();
const warmCounts = installConsumers();
await dispatch(createFixtures(warmup), warmCounts);
verify(warmCounts, warmup);
const setupAndWarmupMs = performance.now() - setupStart;
const events = cycles * 4;

const timingFixtures = createFixtures(cycles);
const timingCounts = installConsumers();
globalThis.gc();
const cpuStart = process.threadCpuUsage();
const timeStart = performance.now();
await dispatch(timingFixtures, timingCounts);
const elapsedMs = performance.now() - timeStart;
const cpu = process.threadCpuUsage(cpuStart);
verify(timingCounts, cycles);

const allocationFixtures = createFixtures(cycles);
const allocationCounts = installConsumers();
globalThis.gc();
const inspector = new Session();
inspector.connect();
let allocations: ReturnType<typeof summarize>;
try {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await dispatch(allocationFixtures, allocationCounts);
  globalThis.gc();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocations = summarize(profile);
} finally {
  inspector.disconnect();
}
verify(allocationCounts, cycles);

const workFixtures = createFixtures(cycles);
const workCounts = installConsumers();
const originalClone = globalThis.structuredClone;
let cloneCalls = 0;
try {
  globalThis.structuredClone = (value, options) => {
    cloneCalls++;
    return originalClone(value, options);
  };
  await dispatch(workFixtures, workCounts);
} finally {
  globalThis.structuredClone = originalClone;
  resetDiagnosticEventsForTest();
}
verify(workCounts, cycles);
const result = {
  format: "openclaw-diagnostic-event-pipeline-v1",
  revision: values.revision ?? null,
  node: process.version,
  scenario: values.scenario,
  cycles,
  events,
  warmupCycles: warmup,
  setupAndWarmupMs,
  loadAverage: loadavg(),
  elapsedMs,
  microsecondsPerEvent: (elapsedMs * 1_000) / events,
  cpuMicrosecondsPerEvent: (cpu.user + cpu.system) / events,
  samplingInterval,
  ...allocations,
  sampledAllocatedBytesPerEvent: allocations.sampledAllocatedBytes / events,
  cloneCalls,
  cloneCallsPerEvent: cloneCalls / events,
  deliveries: workCounts,
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (values.output) {
  writeFileSync(values.output, json);
}
process.stdout.write(json);
