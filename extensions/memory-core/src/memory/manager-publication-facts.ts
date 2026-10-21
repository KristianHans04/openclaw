import type { DatabaseSync } from "node:sqlite";
import { readSqliteDatabaseScopedWriteToken } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { MEMORY_INDEX_WRITE_SCOPE } from "./manager-publication-task.js";
import { readMemoryDatabaseFacts, type MemoryDatabaseFacts } from "./manager-retrieval-read.js";
import type {
  MemorySourceIndexHeader,
  MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";

// Agent publication bindings borrow the same worker connection across operations.
const retained = new WeakMap<DatabaseSync, { facts: MemoryDatabaseFacts; token?: string }>();

export function retainedMemoryPublicationFacts(db: DatabaseSync): MemoryDatabaseFacts | undefined {
  const previous = retained.get(db);
  const token = readSqliteDatabaseScopedWriteToken(db, MEMORY_INDEX_WRITE_SCOPE);
  return token !== undefined && previous?.token === token ? previous.facts : undefined;
}

export function publishMemoryFacts(
  db: DatabaseSync,
  facts = readMemoryDatabaseFacts(db),
): MemoryDatabaseFacts {
  retained.set(db, {
    facts,
    token: readSqliteDatabaseScopedWriteToken(db, MEMORY_INDEX_WRITE_SCOPE),
  });
  return facts;
}

export function readPublishedMemoryFacts(db: DatabaseSync): MemoryDatabaseFacts {
  return retainedMemoryPublicationFacts(db) ?? publishMemoryFacts(db);
}

export function memoryMetadataPostimage(
  facts: MemoryDatabaseFacts | undefined,
  meta: NonNullable<MemoryDatabaseFacts["meta"]>,
): MemoryDatabaseFacts | undefined {
  // Changed vector dimensions need the persisted completeness marker as well.
  return facts && facts.meta?.vectorDims === meta.vectorDims
    ? { ...facts, meta, serialized: JSON.stringify(meta) }
    : undefined;
}

export function memorySourceHashPostimage(
  facts: MemoryDatabaseFacts | undefined,
  source: "memory" | "sessions",
  hash: string,
): MemoryDatabaseFacts | undefined {
  if (!facts || (hash !== "" && facts.invalidatedSources.includes(source))) {
    // A Boolean cannot tell whether this was the last invalidated source.
    return undefined;
  }
  return hash === ""
    ? {
        ...facts,
        invalidatedSources: (["memory", "sessions"] as const).filter(
          (kind) => kind === source || facts.invalidatedSources.includes(kind),
        ),
      }
    : facts;
}

/** Reduce source writes in order, including repeated paths within a group. */
export class MemorySourcePublicationFacts {
  constructor(private facts: MemoryDatabaseFacts | undefined) {}

  *rows(header: MemorySourceIndexHeader, rows: Iterable<MemorySourceIndexRow>) {
    let inserted = false;
    let removed = !header.delta;
    let embeddings = false;
    for (const row of rows) {
      if ("removedId" in row) {
        removed = true;
      } else if (!row.retained) {
        inserted = true;
        embeddings ||= row.embedding.length > 0;
      }
      yield row;
    }
    const facts = memorySourceHashPostimage(this.facts, header.source, header.entry.hash);
    const semantic = inserted && header.model !== "fts-only";
    if (
      !facts ||
      facts.hasVectorTable ||
      header.vectorReady ||
      (removed && ((!inserted && facts.hasIndexedChunks) || (!semantic && facts.hasSemanticChunks)))
    ) {
      // Vector cleanup may record debt; removing a last chunk needs one snapshot.
      this.facts = undefined;
      return;
    }
    this.facts = {
      ...facts,
      hasIndexedChunks: facts.hasIndexedChunks || inserted,
      hasSemanticChunks: facts.hasSemanticChunks || semantic,
      vectorState:
        embeddings || (semantic && facts.meta?.vectorDims)
          ? { state: "incomplete" }
          : facts.vectorState,
    };
  }

  postimage(): MemoryDatabaseFacts | undefined {
    return this.facts && { ...this.facts, revision: this.facts.revision + 1 };
  }
}
