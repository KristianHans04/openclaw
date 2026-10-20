import { describe, expect, it } from "vitest";
import {
  intersectOperatorScopes as intersect,
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
  roleScopesAllow,
} from "./operator-scope-compat.js";

function allows(role: string, requestedScopes: string[], allowedScopes: string[]) {
  return roleScopesAllow({ role, requestedScopes, allowedScopes });
}

describe("roleScopesAllow", () => {
  it("does not broaden session write authority to general writes", () => {
    expect(allows("operator", ["operator.write"], ["operator.sessions.write"])).toBe(false);
  });

  it("derives an explicitly selected session ceiling from existing grants without inventing write access", () => {
    expect(intersect(["operator.read", "operator.write"], ["operator.sessions.write"])).toEqual([
      "operator.sessions.write",
    ]);
    expect(intersect(["operator.admin"], ["operator.sessions.read"])).toEqual([
      "operator.sessions.read",
    ]);
    expect(intersect(["operator.read"], ["operator.sessions.write"])).toEqual([
      "operator.sessions.read",
    ]);
    expect(intersect(["operator.sessions.write"], ["operator.read"])).toEqual([
      "operator.sessions.read",
    ]);
    expect(intersect([], ["operator.sessions.write"])).toEqual([]);
    expect(intersect(["operator.write"], ["operator.write"])).toEqual(["operator.write"]);
  });
  it("treats operator.talk as satisfied by talk/write/admin scopes", () => {
    for (const allowedScope of ["operator.talk", "operator.write", "operator.admin"]) {
      expect(allows("operator", ["operator.talk"], [allowedScope])).toBe(true);
    }
    expect(allows("operator", ["operator.talk"], ["operator.read"])).toBe(false);
  });

  it("requires an exact grant or admin for operator.talk.secrets", () => {
    for (const grants of [["operator.talk.secrets"], ["operator.admin"]]) {
      expect(allows("operator", ["operator.talk.secrets"], grants)).toBe(true);
    }
    for (const grants of [[], ["operator.write"]]) {
      expect(allows("operator", ["operator.talk.secrets"], grants)).toBe(false);
    }
  });

  it("uses strict matching with role-prefix partitioning for non-operator roles", () => {
    expect(allows("node", ["node.exec"], ["operator.admin", "node.exec"])).toBe(true);
    expect(allows("node", ["node.exec"], ["operator.admin"])).toBe(false);
    expect(allows("node", ["operator.read"], ["operator.read", "node.exec"])).toBe(false);
    expect(
      allows(" node ", [" node.exec ", "node.exec", "  "], ["node.exec", "operator.admin"]),
    ).toBe(true);
  });

  it("returns the original first missing scope for a whitespace-padded role", () => {
    const params = {
      role: " node ",
      requestedScopes: [" \t", " node.exec ", "node.exec", " node.read \t", "operator.read"],
      allowedScopes: [" node.exec ", "node.exec", ""],
    };
    expect(resolveMissingRequestedScope(params)).toBe(" node.read \t");
    expect(roleScopesAllow(params)).toBe(false);
  });

  it("returns null when every requested scope belongs to one requested role", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["", " \t", "node.exec", "operator.read"],
      }),
    ).toBeNull();
  });

  it("returns the first scope outside the requested role set", () => {
    expect(
      resolveScopeOutsideRequestedRoles({
        requestedRoles: ["node", "operator"],
        requestedScopes: ["node.exec", " vault.admin \t", "operator.read"],
      }),
    ).toBe(" vault.admin \t");
  });

  it("returns the first scope with no requested roles", () => {
    expect(
      resolveScopeOutsideRequestedRoles({ requestedRoles: [], requestedScopes: ["", "node.exec"] }),
    ).toBe("");
  });
});

describe("intersectOperatorScopes", () => {
  it("excludes grants outside the operator ceiling", () => {
    expect(intersect(["node.exec"], ["operator.admin"])).toEqual([]);
  });
});
