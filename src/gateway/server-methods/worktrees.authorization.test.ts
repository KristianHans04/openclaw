import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  authorizationClient,
  dispatchAuthorizationRequest,
} from "../server-methods.authorization.test-support.js";
import type { GatewayRequestContext } from "./types.js";
import { createWorktreesHandlers } from "./worktrees.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseAsync());

function worktreeRecord(repoRoot: string): ManagedWorktreeRecord {
  return {
    id: "worktree-id",
    name: "task-one",
    repoFingerprint: "0123456789abcdef",
    repoRoot,
    path: "/state/worktrees/0123456789abcdef/task-one",
    branch: "openclaw/task-one",
    baseRef: "HEAD",
    ownerKind: "manual",
    createdAt: 1,
    lastActiveAt: 2,
  };
}

async function dispatchCreate(repoRoot: string, workspace: string, scopes: string[]) {
  const create = vi.fn(async () => worktreeRecord(repoRoot));
  const handler = createWorktreesHandlers({ create } as never)["worktrees.create"];
  if (!handler) {
    throw new Error("worktrees.create handler is not registered");
  }
  const respond = await dispatchAuthorizationRequest(
    "worktrees.create",
    { repoRoot },
    {
      client: authorizationClient("conn-worktree-create", scopes),
      context: {
        getRuntimeConfig: () => ({
          agents: { entries: { main: { workspace } } },
        }),
        logGateway: { warn: vi.fn() },
      } as unknown as GatewayRequestContext,
      extraHandlers: { "worktrees.create": handler },
    },
    "create",
  );
  return { create, respond };
}

it.each([
  ["inside", "operator.write", true],
  ["outside", "operator.write", false],
  ["outside", "operator.admin", true],
] as const)("worktrees.create %s workspace with %s", async (location, scope, allowed) => {
  const root = await fs.realpath(tempDirs.make("openclaw-worktree-create-host-auth-"));
  const workspace = path.join(root, "workspace");
  const repoRoot = path.join(location === "inside" ? workspace : root, "project");
  await fs.mkdir(workspace);
  await fs.mkdir(repoRoot);

  const { create, respond } = await dispatchCreate(repoRoot, workspace, [scope]);
  if (allowed) {
    expect(create).toHaveBeenCalledWith({
      repoRoot,
      name: undefined,
      baseRef: undefined,
      ownerKind: "manual",
      runSetupScript: scope === "operator.admin",
    });
    expect(respond).toHaveBeenCalledWith(true, worktreeRecord(repoRoot), undefined);
    return;
  }
  expect(create).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.admin",
        requiredScopes: ["operator.admin"],
      },
    }),
  );
});
