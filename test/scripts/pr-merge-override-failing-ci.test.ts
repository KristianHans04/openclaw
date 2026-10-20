import { join } from "node:path";
import { expect, it } from "vitest";
import { configureMerge, expectExit, pendingGates } from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, describePosix } = createMergeOutcomeFixtureHarness();

function failingCiFixture() {
  const f = fixture();
  const state = f.state();
  configureMerge(f, {
    restPolicy: "supported",
    restContexts: ["openclaw/ci-gate"],
    requiredCheckName: "openclaw/ci-gate",
    gates: "fail",
    pr: { mergeStateStatus: "BLOCKED" },
    priorCi: {
      ...state.priorCi,
      enabled: true,
      security: { ...state.priorCi.security, enabled: true, sourceSha: f.base },
    },
  });
  pendingGates(f);
  return f;
}

describePosix("maintainer-approved failing CI override", () => {
  it("requires explicit override, then merges once through the protected writer with truthful evidence", () => {
    const f = failingCiFixture();
    configureMerge(f, { protectedMerge: true });

    expectExit(f.run(true), 1);
    expect(f.state().mutations).toBe(0);

    expectExit(f.overrideFailingCi());
    expect(f.record()).toMatchObject({
      phase: "complete",
      route: "admin",
      overrideFailingCi: true,
      head: f.head,
      method: "squash",
    });
    expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
    const [comment] = f.state().comments;
    expect(comment?.body).toContain("maintainer-approved unrelated CI failures");
    expect(comment?.body).toContain("No current-head CI success is claimed");
    expectExit(f.run());
    expect(f.state().mutations).toBe(1);
  });

  it.each([
    {
      name: "pending CI",
      changes: { gates: "pending" },
    },
    {
      name: "rerunning failed CI suite",
      changes: { restSuite: "rerunning" },
      expected: "required check suite is not complete for the prepared head",
    },
    {
      name: "security clearance",
      changes: {},
      securityFault: "failed-guard",
      expected: "unsuccessful openclaw/security-sensitive-review",
    },
    {
      name: "another required check",
      changes: {
        restContexts: ["openclaw/ci-gate", "Security Review"],
        restFailedContext: "Security Review",
      },
      expected: "other required checks must pass",
    },
    { name: "conflicts", changes: { pr: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } } },
    { name: "draft PR", changes: { pr: { isDraft: true } } },
    { name: "changed head", changes: { pr: { headRefOid: "b".repeat(40) } } },
    {
      name: "required reviews",
      changes: { priorCi: { reviewCount: 1, reviewDecision: "REVIEW_REQUIRED" } },
      expected: "current enforced reviews must be satisfied",
    },
    {
      name: "policy changed during security verification",
      changes: { tightenPolicyAfterSecurity: true },
      expected: "branch policy changed while reading evidence",
    },
  ])("does not override $name", ({ changes, securityFault, expected }) => {
    const f = failingCiFixture();
    const state = f.state();
    const { priorCi, ...other } = changes;
    configureMerge(f, {
      ...other,
      priorCi: {
        ...state.priorCi,
        ...priorCi,
        security: { ...state.priorCi.security, fault: securityFault ?? "" },
      },
    });
    const result = expectExit(f.overrideFailingCi(), 1);
    if (expected) {
      expect(result.output).toContain(expected);
    }
    expect(f.state().mutations).toBe(0);
  });

  it.each(["failed", "rerunning"])(
    "admits a completed mixed-result CI suite, not an in-progress rerun (%s)",
    (restSuite) => {
      const f = fixture();
      configureMerge(f, {
        restPolicy: "supported",
        gates: "pass",
        restSuite,
        pr: { mergeStateStatus: "UNSTABLE" },
      });
      if (restSuite === "failed") {
        const ordinary = expectExit(f.run(), 1);
        expect(ordinary.output).toContain("required check suite is not freshly successful");
      }
      const admitted = restSuite === "failed";
      expectExit(f.overrideFailingCi(), admitted ? 0 : 1);
      expect(f.state().mutations).toBe(admitted ? 1 : 0);
    },
  );

  it.each([false, true])(
    "binds security proof to the final observed main (publisher changed=%s)",
    (changed) => {
      const f = failingCiFixture();
      let tree = f.tree("before\n", "advanced\n");
      if (changed) {
        const index = { GIT_INDEX_FILE: join(f.root, "publisher.index") };
        const blob = f.git(["hash-object", "-w", "--stdin"], "Changed publisher\n");
        f.git(["read-tree", tree], undefined, f.repo, index);
        f.git(
          ["update-index", "--cacheinfo", `100644,${blob},.github/workflows/security-review.yml`],
          undefined,
          f.repo,
          index,
        );
        tree = f.git(["write-tree"], undefined, f.repo, index);
      }
      const main = f.commit(tree, [f.base]);
      configureMerge(f, {
        protectedMerge: true,
        restMainAdvance: { boundary: "during-evidence", observed: false, main },
      });

      expectExit(f.overrideFailingCi(), changed ? 1 : 0);
      expect(f.state().restMainAdvance).toBeNull();
      expect(f.state().mutations).toBe(changed ? 0 : 1);
      if (changed) {
        expect(
          f
            .captures()
            .map(([, contents]) => contents)
            .join("\n"),
        ).toContain("Security Review publisher source differs from the current owner");
      } else {
        expect(f.record().phase).toBe("complete");
        expect(f.git(["show", `${f.record().landed}:sibling.txt`])).toBe("advanced");
      }
    },
  );

  it("retains an uncertain admin attempt without replaying it", () => {
    const f = failingCiFixture();
    configureMerge(f, { mode: "unapplied" });

    expectExit(f.overrideFailingCi(), 1);
    expect(f.record()).toMatchObject({ phase: "intent", overrideFailingCi: true });
    expect(f.state().mutations).toBe(1);
    expectExit(f.overrideFailingCi(), 1);
    expect(f.state().mutations).toBe(1);
  });
});
