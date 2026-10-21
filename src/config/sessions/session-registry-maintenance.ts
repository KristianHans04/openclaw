import fs from "node:fs";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { readSessionRowChangeRevision } from "../../sessions/session-row-changes.js";
import {
  applySessionEntryLifecycleMutation,
  type SessionEntryLifecycleRemoval,
} from "./session-accessor.js";
import { listSessionChildEntriesReadOnly } from "./session-entry-children-read.js";
import { withSessionRegistryEntriesInWorker } from "./session-entry-read-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { collectActiveSessionWorkAdmissionKeys } from "./store-maintenance-preserve.js";
import { pruneStaleEntries, shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";

type SessionRegistryMaintenanceStoreSummary = {
  preservedRunning: number;
  pruned: number;
  nextSweepAtMs: number | null;
};

type SessionRegistryMaintenanceStoreOptions = SessionStoreTarget & {
  /** Whether to commit the selected removals to the backing store. */
  apply: boolean;
  /** Retention window for cron-run session entries. */
  retentionMs: number;
  /** Currently running cron job ids, normalized to lowercase. */
  runningCronJobIds: ReadonlySet<string>;
  /** All discovered stores, including children spawned into another agent. */
  childStores?: readonly SessionStoreTarget[];
  assertCurrent?: () => void;
};

/**
 * Runs session-registry maintenance for one resolved agent store.
 * Preview and apply consume bounded snapshots under one physical reader owner.
 * The lifecycle owner commits removals without running generic session maintenance.
 */
export async function runSessionRegistryMaintenanceForStore(
  params: SessionRegistryMaintenanceStoreOptions,
): Promise<SessionRegistryMaintenanceStoreSummary> {
  params.assertCurrent?.();
  const { agentId, storePath } = params;
  const summary: SessionRegistryMaintenanceStoreSummary = {
    preservedRunning: 0,
    pruned: 0,
    nextSweepAtMs: null,
  };
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (sqliteTarget.path && !fs.existsSync(sqliteTarget.path)) {
    return summary;
  }
  await withSessionRegistryEntriesInWorker(
    { agentId, storePath },
    async (entries, assertReaderCurrent) => {
      const assertCurrent = () => {
        params.assertCurrent?.();
        assertReaderCurrent();
      };
      assertCurrent();
      const store = Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
      const revision = readSessionRowChangeRevision();
      // Child lookup excludes its parent keys, so retain links within this candidate page too.
      const preserveKeys = new Set(
        entries.flatMap(({ entry }) =>
          entry.spawnedBy && entry.archivedAt === undefined ? [entry.spawnedBy] : [],
        ),
      );
      const parentSessionKeys = Object.keys(store);
      for (const target of params.childStores ?? [{ agentId, storePath }]) {
        if (parentSessionKeys.length === 0) {
          break;
        }
        const children = await listSessionChildEntriesReadOnly(
          { ...target, sessionKey: "", projection: "list" },
          parentSessionKeys,
        );
        assertCurrent();
        for (const { entry } of children) {
          if (entry.spawnedBy && entry.archivedAt === undefined) {
            preserveKeys.add(entry.spawnedBy);
          }
        }
      }
      const removals: SessionEntryLifecycleRemoval[] = [];
      for (const key of collectActiveSessionWorkAdmissionKeys({ storePath, store }) ?? []) {
        preserveKeys.add(key);
      }
      for (const key of parentSessionKeys) {
        const parsed = parseAgentSessionKey(key);
        const jobId = /^cron:([^:]+):run:[^:]+(?:$|:)/u.exec(parsed?.rest ?? "")?.[1];
        if (jobId && params.runningCronJobIds.has(jobId)) {
          preserveKeys.add(key);
          summary.preservedRunning += 1;
        }
      }
      let pruned = pruneStaleEntries(store, params.retentionMs, {
        log: false,
        onPruned: ({ key, entry }) => {
          removals.push({
            sessionKey: key,
            expectedEntry: entry,
            archiveRemovedTranscript: true,
          });
        },
        preserveKeys,
      });
      const now = Date.now();
      let nextSweepAtMs: number | null = null;
      for (const [key, entry] of Object.entries(store)) {
        if (
          shouldPreserveMaintenanceEntry({ key, entry }) ||
          typeof entry.updatedAt !== "number" ||
          !Number.isFinite(entry.updatedAt)
        ) {
          continue;
        }
        // Expired protected rows retry after running work or child dependencies settle.
        const expiresAt = entry.updatedAt + params.retentionMs + 1;
        const deadline = expiresAt <= now ? now + 60_000 : expiresAt;
        nextSweepAtMs = Math.min(nextSweepAtMs ?? Infinity, deadline);
      }
      if (params.apply && removals.length > 0) {
        const mutation = await applySessionEntryLifecycleMutation({
          agentId,
          storePath,
          removals,
          skipMaintenance: true,
          commitGuard() {
            assertCurrent();
            // Child creation/restoration and store discovery must still match the read.
            if (readSessionRowChangeRevision() !== revision) {
              throw new Error("Session ancestry changed before cron registry cleanup");
            }
          },
        });
        assertCurrent();
        if (mutation.removedEntries !== pruned) {
          nextSweepAtMs = Date.now() + 60_000;
        }
        pruned = mutation.removedEntries;
      }
      summary.pruned += pruned;
      if (nextSweepAtMs !== null) {
        summary.nextSweepAtMs = Math.min(summary.nextSweepAtMs ?? Infinity, nextSweepAtMs);
      }
    },
  );
  return summary;
}
