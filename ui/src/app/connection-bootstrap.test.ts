import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";

function fixture(connected = true) {
  const coordinator = createConnectionBootstrapCoordinator();
  const client = {};
  if (connected) {
    coordinator.synchronize({ client, connected: true });
  }
  const started: string[] = [];
  const queue = (prefix: string, count: number, background = false) => {
    const completions = Array.from({ length: count }, () => createDeferred());
    const tasks = completions.map((completion, index) =>
      coordinator.run(
        `task-${index}`,
        async () => {
          started.push(`${prefix}-${index}`);
          await completion.promise;
        },
        { background },
      ),
    );
    return {
      done: Promise.all(tasks),
      release: () => completions.forEach((completion) => completion.resolve()),
      releaseFirst: () => completions[0]!.resolve(),
    };
  };
  return { coordinator, client, started, queue };
}

it("does not start queued work after its connection is disconnected", async () => {
  const { coordinator, queue, started } = fixture();
  const jobs = queue("old", 3);
  coordinator.synchronize({ client: null, connected: false });
  jobs.release();
  await jobs.done;
  expect(started).toEqual(["old-0", "old-1"]);
});

it("starts a replacement connection while both old tasks remain pending and retains its concurrency", async () => {
  const { coordinator, queue, started } = fixture();
  const runDuplicate = vi.fn(async () => {});
  const previous = queue("old", 2);
  expect(started).toEqual(["old-0", "old-1"]);
  coordinator.synchronize({ client: {}, connected: true });
  const current = queue("new", 3);
  expect(started).toEqual(["old-0", "old-1", "new-0", "new-1"]);
  previous.release();
  await previous.done;
  const duplicateTask = coordinator.run("task-0", runDuplicate);
  expect(runDuplicate).not.toHaveBeenCalled();
  expect(started).toEqual(["old-0", "old-1", "new-0", "new-1"]);

  current.releaseFirst();
  await vi.waitFor(() => expect(started).toEqual(["old-0", "old-1", "new-0", "new-1", "new-2"]));
  current.release();
  await Promise.all([current.done, duplicateTask]);
  await coordinator.run("task-0", runDuplicate);

  expect(runDuplicate).toHaveBeenCalledOnce();
});

it("pauses only background work until the selected transcript is authoritative, then drains it in order", async () => {
  const { coordinator, client, started, queue } = fixture(false);
  const pane = {};
  const retiredPane = {};
  const sessionKey = "agent:main:selected";
  const expectStarted = (...background: string[]) =>
    expect(started).toEqual(["route-prerequisite", ...background]);
  coordinator.setForegroundRoute(undefined);
  coordinator.synchronize({ client, connected: true });
  const background = queue("background", 3, true);
  await coordinator.run("route-prerequisite", async () => {
    started.push("route-prerequisite");
  });
  expectStarted();

  coordinator.setForegroundPane(retiredPane, { sessionKey, client, ready: true });
  expectStarted();
  coordinator.setForegroundPane(retiredPane, null);
  coordinator.setForegroundRoute(sessionKey);
  expectStarted();
  for (const state of [
    { sessionKey, client: null, ready: true },
    { sessionKey, client: {}, ready: true },
    { sessionKey, client, ready: false },
    { sessionKey: "agent:main:other", client, ready: true },
  ]) {
    coordinator.setForegroundPane(pane, state);
    expectStarted();
  }
  coordinator.setForegroundPane(retiredPane, null);
  coordinator.setForegroundPane(pane, { sessionKey, client, ready: true });
  await vi.waitFor(() => expectStarted("background-0", "background-1"));
  background.releaseFirst();
  await vi.waitFor(() => expectStarted("background-0", "background-1", "background-2"));
  background.release();
  await background.done;
});

it("releases bulk work when navigation leaves or rejects the native chat route", async () => {
  const { coordinator, client } = fixture(false);
  coordinator.setForegroundRoute("agent:main:selected");
  coordinator.synchronize({ client, connected: true });
  const pendingPane = { sessionKey: "agent:main:selected", client, ready: false };
  coordinator.setForegroundPane({}, pendingPane);
  const hydrate = vi.fn(async () => {});
  const background = coordinator.run("roster", hydrate, { background: true });
  expect(hydrate).not.toHaveBeenCalled();

  coordinator.setForegroundRoute(null);
  await background;
  expect(hydrate).toHaveBeenCalledOnce();
});

it("runs connected bootstrap work queued by an earlier subscription", async () => {
  const { coordinator, client } = fixture(false);
  const hydrate = vi.fn(async () => {});

  const queued = coordinator.run("sessions", hydrate);
  await Promise.resolve();
  expect(hydrate).not.toHaveBeenCalled();

  coordinator.synchronize({ client, connected: true });
  await queued;

  expect(hydrate).toHaveBeenCalledOnce();
});
