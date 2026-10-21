import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindFreshClientCredentialStore } from "./client-credential-migration.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "./client-credential-receipt.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "./client-credential-store.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const storeId = "00000000-0000-4000-8000-000000000001";
const namespace = "synthetic_state_0000000000004000";

function fixture() {
  const root = dirs.make("client-postgres-bootstrap-");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const material = generateStoredDeviceIdentity(17);
  const identity = {
    identity_key: "primary",
    device_id: material.deviceId,
    public_key_pem: material.publicKeyPem,
    private_key_pem: material.privateKeyPem,
    created_at_ms: 17,
    updated_at_ms: 19,
  };
  const token = {
    device_id: material.deviceId,
    role: "operator",
    token: "synthetic-existing-operator-token",
    scopes_json: '["operator.read"]',
    updated_at_ms: 23,
  };
  runClientCredentialOperation(env, { kind: "identity.create", identity });
  runClientCredentialOperation(env, { kind: "token.replace", key: token, token });
  const sourcePath = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  return { env, identity, token, sourcePath };
}

function createAnchor(source: DatabaseSync) {
  source.exec(
    "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)",
  );
  source
    .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
    .run(storeId, namespace);
}

function bind(source: DatabaseSync, f: ReturnType<typeof fixture>) {
  runSqliteImmediateTransactionSync(source, () =>
    bindFreshClientCredentialStore(source, { path: f.sourcePath, env: f.env }),
  );
}

function localSnapshot(env: NodeJS.ProcessEnv) {
  using owner = openClientCredentialCustody(env, { migration: true })!;
  return {
    receipt: readClientCredentialReceipt(owner.database),
    rawReceipt: owner.database.prepare("SELECT * FROM client_credential_migration").all(),
    identities: owner.database
      .prepare("SELECT * FROM device_identities ORDER BY identity_key")
      .all(),
    tokens: owner.database
      .prepare("SELECT * FROM device_auth_tokens ORDER BY device_id, role")
      .all(),
  };
}

function expectCredentialsReadable(f: ReturnType<typeof fixture>) {
  expect(
    runClientCredentialOperation(
      f.env,
      { kind: "identity.read", identity_key: "primary" },
      { readOnly: true },
    ),
  ).toEqual({ kind: "identity", identity: f.identity });
  expect(
    runClientCredentialOperation(f.env, { kind: "token.read", key: f.token }, { readOnly: true }),
  ).toEqual({ kind: "token", token: f.token });
}

describe("fresh PostgreSQL client credential binding", () => {
  it("publishes the durable anchor identity before any remote schema exists", () => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    runSqliteImmediateTransactionSync(source, () => {
      createAnchor(source);
      bindFreshClientCredentialStore(source, { path: f.sourcePath, env: f.env });
    });
    expect(
      source.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_meta'").get(),
    ).toBeUndefined();
    expect(localSnapshot(f.env).receipt).toMatchObject({
      phase: "complete",
      receipt: {
        source: {
          kind: "canonical",
          engine: "postgres",
          identity: storeId,
          generation: `bootstrap:${storeId}`,
        },
        sharedFile: readClientCredentialFileIdentity(f.sourcePath),
      },
    });
    expectCredentialsReadable(f);
  });

  it("allows the same bootstrap to bind again without replacing local keys or tokens", () => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    createAnchor(source);
    bind(source, f);
    const previous = localSnapshot(f.env);
    bind(source, f);
    expect(localSnapshot(f.env)).toMatchObject({
      receipt: previous.receipt,
      identities: previous.identities,
      tokens: previous.tokens,
    });
    expectCredentialsReadable(f);
  });

  it("refuses a different durable store identity without changing local credentials or receipts", () => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    createAnchor(source);
    bind(source, f);
    const previous = localSnapshot(f.env);
    source.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run("another-store");
    expect(() => bind(source, f)).toThrow(/previous shared database/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });

  it("refuses a replaced anchor file even when its durable store identity matches", () => {
    const f = fixture();
    {
      using source = openNodeSqliteDatabase(f.sourcePath);
      createAnchor(source);
      bind(source, f);
    }
    const previous = localSnapshot(f.env);
    fs.renameSync(f.sourcePath, `${f.sourcePath}.previous`);
    using replacement = openNodeSqliteDatabase(f.sourcePath);
    createAnchor(replacement);
    expect(readClientCredentialFileIdentity(f.sourcePath)).not.toEqual(
      previous.receipt?.receipt.sharedFile,
    );
    expect(() => bind(replacement, f)).toThrow(/previous shared database/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });

  it("refuses historical canonical migration provenance when the remote store looks fresh", () => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    createAnchor(source);
    bind(source, f);
    {
      using owner = openClientCredentialCustody(f.env, { migration: true })!;
      const stored = readClientCredentialReceipt(owner.database)!;
      stored.receipt.source!.generation = "7".repeat(64);
      stored.receipt.source!.sha256 = "8".repeat(64);
      owner.transaction(() =>
        writeClientCredentialReceipt(owner.database, stored.receipt, "complete"),
      );
    }
    const previous = localSnapshot(f.env);
    expect(() => bind(source, f)).toThrow(/previous shared database/);
    expect(localSnapshot(f.env)).toEqual(previous);
    expectCredentialsReadable(f);
  });

  it.each([
    { label: "an empty anchor", rows: [] },
    {
      label: "multiple anchor identities",
      rows: [
        [storeId, "postgres", namespace],
        ["another-store", "postgres", "another_schema"],
      ],
    },
    { label: "the wrong engine", rows: [[storeId, "sqlite", namespace]] },
    { label: "an empty store identity", rows: [["", "postgres", namespace]] },
    { label: "a non-string store identity", rows: [[42, "postgres", namespace]] },
    { label: "a blank schema", rows: [[storeId, "postgres", "  "]] },
    { label: "a non-string schema", rows: [[storeId, "postgres", 42]] },
  ])("rejects $label before changing the local receipt", ({ rows }) => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    source.exec("CREATE TABLE openclaw_engine_anchor (store_id, engine, schema)");
    for (const row of rows) {
      source.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)").run(...row);
    }
    const previous = localSnapshot(f.env);
    expect(() => bind(source, f)).toThrow(/Invalid PostgreSQL anchor identity/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });

  it("rejects missing anchor identity columns before changing the local receipt", () => {
    const f = fixture();
    using source = openNodeSqliteDatabase(f.sourcePath);
    source.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT)");
    const previous = localSnapshot(f.env);
    expect(() => bind(source, f)).toThrow(/no such column/);
    expect(localSnapshot(f.env)).toEqual(previous);
  });
});
