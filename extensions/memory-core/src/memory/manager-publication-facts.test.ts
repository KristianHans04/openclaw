import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it } from "vitest";
import {
  createPublication,
  publicationReplacement,
} from "./manager-publication-fixture.test-support.js";
import { memoryPublicationInline } from "./manager-publication-transfer.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";
import { readMemoryDatabaseFacts } from "./manager-retrieval-read.js";

it("reads facts once, then carries committed facts across publication bindings", () => {
  using fixture = createPublication();
  const { db, backend, filename } = fixture;
  let reads = 0;
  const observer = observeHostDataSql((query, database) => {
    if (database === undefined && /select .*hasSemanticChunks/i.test(query)) {
      reads += 1;
    }
  });
  try {
    const command = { type: "index.facts", input: undefined } as const;
    expect(backend.execute(command)).toMatchObject({ hasSemanticChunks: false });
    expect(reads).toBe(1);
    for (let index = 0; index < 3; index += 1) {
      const rebound = bindSqliteWorkerBackend(
        { kind: "agent" },
        { database: db, databasePath: filename, admit() {} },
      );
      expect(rebound.execute(command)).toMatchObject({ hasSemanticChunks: false });
      const replacement = publicationReplacement(`version-${index}`);
      replacement.state.fts = { enabled: false, available: false };
      expect(rebound.execute({ type: "source.replace.group", input: replacement })).toMatchObject({
        ok: true,
        facts: { hasIndexedChunks: true, hasSemanticChunks: false, revision: index + 1 },
      });
      expect(
        rebound.execute({
          type: "index.writeMetadata",
          input: { provider: "none", model: "fts-only", chunkTokens: 400, chunkOverlap: 80 },
        }),
      ).toMatchObject({ ok: true });
      rebound.close();
    }
    expect(reads).toBe(1);
    expect(backend.execute(command)).toEqual(readMemoryDatabaseFacts(db));
  } finally {
    observer.restore();
  }
});

it("publishes invalidation and semantic transitions and reloads unclassified writes", () => {
  using fixture = createPublication();
  const { db, backend, admission } = fixture;
  const facts = () => backend.execute({ type: "index.facts", input: undefined });
  const check = (expected: object) => {
    expect(facts()).toMatchObject(expected);
    expect(facts()).toEqual(readMemoryDatabaseFacts(db));
  };
  const replace = (model: string, hash: string) => {
    const input = publicationReplacement(hash);
    input.state.fts = { enabled: false, available: false };
    for (const source of input.sources) {
      source.header.model = model;
    }
    return backend.execute({ type: "source.replace.group", input });
  };
  expect(replace("fts-only", "initial")).toMatchObject({ ok: true });
  check({ hasIndexedChunks: true, hasSemanticChunks: false, invalidatedSources: [] });
  expect(replace("fts-only", "")).toMatchObject({ ok: true });
  check({ invalidatedSources: ["memory"] });
  expect(replace("fts-only", "restored")).toMatchObject({ ok: true });
  check({ invalidatedSources: [] });
  expect(replace("semantic-model", "semantic")).toMatchObject({ ok: true });
  check({ hasSemanticChunks: true });
  admission.denied = true;
  expect(replace("fts-only", "refused")).toMatchObject({ ok: false, committed: false });
  check({ hasSemanticChunks: true });
  admission.denied = false;
  expect(replace("fts-only", "provider-switch")).toMatchObject({ ok: true });
  check({ hasSemanticChunks: false });
  db.exec("UPDATE memory_index_sources SET hash = ''");
  check({ invalidatedSources: ["memory"] });
  db.exec("DELETE FROM memory_index_chunks; DELETE FROM memory_index_sources");
  check({ hasIndexedChunks: false, hasSemanticChunks: false, invalidatedSources: [] });
});

it("refreshes session invalidation immediately and reloads ambiguous clearing once", () => {
  using fixture = createPublication();
  const { db, backend } = fixture;
  db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
    VALUES ('sessions/first', 'sessions', 'initial', 1, 1),
           ('sessions/second', 'sessions', '', 1, 1)`);
  let reads = 0;
  const observer = observeHostDataSql((query, database) => {
    if (database === undefined && /select .*hasSemanticChunks/i.test(query)) {
      reads += 1;
    }
  });
  const facts = () => backend.execute({ type: "index.facts", input: undefined });
  const refresh = (path: string, expectedHash: string, hash: string) =>
    backend.execute({
      type: "source.refresh",
      input: { path, expectedHash, hash, mtime: 2, size: 1 },
    });
  try {
    expect(facts()).toMatchObject({ invalidatedSources: ["sessions"] });
    expect(refresh("sessions/first", "initial", "")).toMatchObject({
      ok: true,
      value: true,
      facts: { invalidatedSources: ["sessions"] },
    });
    expect(reads).toBe(1);
    expect(refresh("sessions/first", "", "restored")).toMatchObject({
      ok: true,
      value: true,
      facts: { invalidatedSources: ["sessions"] },
    });
    expect(facts()).toMatchObject({ invalidatedSources: ["sessions"] });
    expect(reads).toBe(2);
    expect(refresh("sessions/second", "", "restored")).toMatchObject({
      ok: true,
      value: true,
      facts: { invalidatedSources: [] },
    });
    expect(refresh("sessions/second", "stale", "")).toMatchObject({ ok: true, value: false });
    expect(facts()).toMatchObject({ invalidatedSources: [], revision: 3 });
    expect(reads).toBe(3);
    expect(facts()).toEqual(readMemoryDatabaseFacts(db));
  } finally {
    observer.restore();
  }
});

it("uses the final replacement when a group writes the same path twice", () => {
  using fixture = createPublication();
  const { db, backend } = fixture;
  backend.execute({ type: "index.facts", input: undefined });
  const input = publicationReplacement("semantic");
  input.state.fts = { enabled: false, available: false };
  const first = input.sources[0]!;
  first.header.model = "semantic-model";
  const empty = memoryPublicationInline({
    ...first.header,
    model: "fts-only",
    chunks: [],
    embeddings: [],
  })!;
  input.sources = [first, empty];
  expect(backend.execute({ type: "source.replace.group", input })).toMatchObject({
    ok: true,
    facts: { hasIndexedChunks: false, hasSemanticChunks: false, revision: 1 },
  });
  expect(backend.execute({ type: "index.facts", input: undefined })).toEqual(
    readMemoryDatabaseFacts(db),
  );
});
