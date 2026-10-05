import { describe, expect, it } from "vitest";
import {
  buildProjectTransfer,
  importProjectTransfer,
  reidentifyProject,
  uniqueProjectTitle,
  TransferFormatError,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_KIND,
} from "../src/shared/domain/transfer";
import { restoreScenario } from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import { saveScenario } from "../src/features/scenarios/scenarioViewModel";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import type {
  LatencyProject,
  ScenarioSnapshot,
} from "../src/shared/domain/types";

function exportText(project: LatencyProject): string {
  return JSON.stringify(buildProjectTransfer(project, 1_000));
}

function projectWithSnapshot(): LatencyProject {
  const result = simulateProject(EXAMPLE_PROJECT);
  return saveScenario(EXAMPLE_PROJECT, result, "基线方案");
}

describe("project transfer export", () => {
  it("writes a versioned transfer envelope containing the project and snapshots", () => {
    const file = buildProjectTransfer(projectWithSnapshot(), 1234);
    expect(file.kind).toBe(TRANSFER_KIND);
    expect(file.formatVersion).toBe(TRANSFER_FORMAT_VERSION);
    expect(file.exportedAt).toBe(1234);
    expect(file.project.id).toBe(EXAMPLE_PROJECT.id);
    expect(file.project.scenarios).toHaveLength(1);
  });

  it("is a deep copy, so later edits cannot mutate an exported payload", () => {
    const file = buildProjectTransfer(EXAMPLE_PROJECT, 1);
    file.project.title = "篡改";
    expect(EXAMPLE_PROJECT.title).not.toBe("篡改");
  });
});

describe("project transfer import", () => {
  it("rebuilds every object id and remaps live dependencies and fallbacks", () => {
    const imported = importProjectTransfer(exportText(EXAMPLE_PROJECT), []);
    const project = imported.project;
    expect(project.id).not.toBe(EXAMPLE_PROJECT.id);
    expect(project.title).toBe(EXAMPLE_PROJECT.title);
    expect(imported.warnings).toEqual([]);

    const oldToNew = new Map(
      EXAMPLE_PROJECT.nodes.map((node, index) => [
        node.id,
        project.nodes[index]?.id,
      ]),
    );
    for (const oldNode of EXAMPLE_PROJECT.nodes) {
      expect(
        project.nodes.find((node) => node.id === oldNode.id),
      ).toBeUndefined();
      const nextNode = project.nodes.find(
        (node) => node.id === oldToNew.get(oldNode.id),
      );
      expect(nextNode).toBeDefined();
      expect(nextNode?.dependencyIds).toEqual(
        oldNode.dependencyIds.map((id) => oldToNew.get(id)),
      );
      if (oldNode.fallbackNodeId)
        expect(nextNode?.fallbackNodeId).toBe(
          oldToNew.get(oldNode.fallbackNodeId),
        );
    }
  });

  it("remaps scenario snapshots, including critical paths, with fresh ids", () => {
    const source = projectWithSnapshot();
    const imported = importProjectTransfer(exportText(source), []);
    const originalSnapshot = source.scenarios[0];
    const importedSnapshot = imported.project.scenarios[0];
    expect(importedSnapshot).toBeDefined();
    expect(importedSnapshot?.id).not.toBe(originalSnapshot?.id);
    expect(importedSnapshot?.name).toBe(originalSnapshot?.name);
    expect(importedSnapshot?.completionMs).toBe(originalSnapshot?.completionMs);

    const oldNodeIds = new Set(
      (originalSnapshot as ScenarioSnapshot).nodes.map((node) => node.id),
    );
    for (const node of importedSnapshot?.nodes ?? [])
      expect(oldNodeIds.has(node.id)).toBe(false);

    const newIds = new Set(
      (importedSnapshot?.nodes ?? []).map((node) => node.id),
    );
    for (const pathId of importedSnapshot?.criticalPath ?? [])
      expect(newIds.has(pathId)).toBe(true);
  });

  it("can re-import the same file many times without id collisions", () => {
    const text = exportText(projectWithSnapshot());
    const first = importProjectTransfer(text, []);
    const second = importProjectTransfer(text, [first.project.title]);
    expect(first.project.id).not.toBe(second.project.id);
    const firstNodeIds = new Set(first.project.nodes.map((node) => node.id));
    expect(second.project.nodes.some((node) => firstNodeIds.has(node.id))).toBe(
      false,
    );
    expect(first.project.scenarios[0]?.id).not.toBe(
      second.project.scenarios[0]?.id,
    );
  });

  it("resolves name collisions without overwriting existing projects", () => {
    expect(uniqueProjectTitle("商品页", ["商品页"])).toBe("商品页 · 导入");
    expect(uniqueProjectTitle("商品页", ["商品页", "商品页 · 导入"])).toBe(
      "商品页 · 导入 2",
    );
    const imported = importProjectTransfer(exportText(EXAMPLE_PROJECT), [
      EXAMPLE_PROJECT.title,
    ]);
    expect(imported.project.title).toBe(`${EXAMPLE_PROJECT.title} · 导入`);
    expect(imported.warnings.join(" ")).toContain("同名");
  });

  it("rejects garbage json, foreign files, and missing project payloads", () => {
    expect(() => importProjectTransfer("{not json", [])).toThrowError(
      TransferFormatError,
    );
    expect(() => importProjectTransfer("{not json", [])).toThrow(/已损坏|无法/);
    expect(() =>
      importProjectTransfer(JSON.stringify({ hello: "world" }), []),
    ).toThrow(/无法识别/);
    const foreign = buildProjectTransfer(EXAMPLE_PROJECT);
    expect(() =>
      importProjectTransfer(
        JSON.stringify({ ...foreign, kind: "something-else" }),
        [],
      ),
    ).toThrow(/无法识别/);
    expect(() =>
      importProjectTransfer(
        JSON.stringify({ ...foreign, project: { broken: true } }),
        [],
      ),
    ).toThrow(/已损坏/);
  });

  it("rejects files from a newer application version without touching anything", () => {
    const future = {
      ...buildProjectTransfer(EXAMPLE_PROJECT),
      formatVersion: TRANSFER_FORMAT_VERSION + 1,
    };
    const before = structuredClone(EXAMPLE_PROJECT);
    expect(() =>
      importProjectTransfer(JSON.stringify(future), []),
    ).toThrowError(expect.objectContaining({ code: "unsupported-version" }));
    // 现有项目保持原样
    expect(EXAMPLE_PROJECT).toEqual(before);
  });

  it("rejects duplicate node ids, which would make reference remapping ambiguous", () => {
    const session = EXAMPLE_PROJECT.nodes[0];
    const flags = EXAMPLE_PROJECT.nodes[1];
    if (!session || !flags) throw new Error("fixture missing nodes");
    const broken: LatencyProject = {
      ...EXAMPLE_PROJECT,
      nodes: [session, { ...flags, id: session.id }],
    };
    expect(() => importProjectTransfer(exportText(broken), [])).toThrowError(
      expect.objectContaining({ code: "damaged" }),
    );
  });

  it("repairs dangling references inside snapshots and warns instead of failing", () => {
    const source = projectWithSnapshot();
    const snapshot = source.scenarios[0] as ScenarioSnapshot;
    const tampered: LatencyProject = {
      ...source,
      scenarios: [
        {
          ...snapshot,
          nodes: snapshot.nodes.map((node, index) =>
            index === 0
              ? {
                  ...node,
                  fallbackNodeId: "ghost-node",
                  dependencyIds: ["ghost-node", ...node.dependencyIds],
                }
              : node,
          ),
          criticalPath: [...snapshot.criticalPath, "ghost-node"],
        },
      ],
    };
    const imported = importProjectTransfer(exportText(tampered), []);
    expect(imported.warnings.join(" ")).toContain("方案快照");
    const first = imported.project.scenarios[0]?.nodes[0];
    expect(first?.fallbackNodeId).toBeUndefined();
    expect(first?.dependencyIds).not.toContain("ghost-node");
    expect(imported.project.scenarios[0]?.criticalPath).not.toContain(
      "ghost-node",
    );
  });

  it("warns when the imported graph contains a cycle", () => {
    // parseProject 会先剥掉悬空边，所以用一个完整的两节点环。
    const cyclic: LatencyProject = {
      ...EXAMPLE_PROJECT,
      nodes: [
        {
          id: "a",
          name: "节点 A",
          durationMs: 100,
          jitterMs: 0,
          dependencyIds: ["b"],
          timeoutMs: 500,
          retryCount: 0,
          failureRate: 0,
        },
        {
          id: "b",
          name: "节点 B",
          durationMs: 100,
          jitterMs: 0,
          dependencyIds: ["a"],
          timeoutMs: 500,
          retryCount: 0,
          failureRate: 0,
        },
      ],
      scenarios: [],
    };
    const imported = importProjectTransfer(exportText(cyclic), []);
    expect(imported.warnings.join(" ")).toContain("循环依赖");
  });
});

describe("restoring imported scenarios", () => {
  it("restores remapped nodes only into the imported project", () => {
    // 本地已有一个带方案的项目，其节点恰好使用导出前的旧 id。
    const local = projectWithSnapshot();
    const imported = importProjectTransfer(exportText(local), [
      local.title,
    ]).project;
    expect(imported.id).not.toBe(local.id);

    const snapshotId = imported.scenarios[0]?.id ?? "";
    const restoredImport = restoreScenario(imported, snapshotId);
    // 恢复后节点 id 全部属于导入项目，不会写回本地项目的对象。
    const importedIds = new Set(imported.nodes.map((node) => node.id));
    for (const node of restoredImport.nodes)
      expect(importedIds.has(node.id)).toBe(true);
    expect(restoredImport.id).toBe(imported.id);

    const restoredLocal = restoreScenario(local, local.scenarios[0]?.id ?? "");
    const localIds = new Set(local.nodes.map((node) => node.id));
    for (const node of restoredLocal.nodes)
      expect(localIds.has(node.id)).toBe(true);
    expect(restoredLocal.id).toBe(local.id);
    expect(restoredLocal.id).not.toBe(restoredImport.id);
  });

  it("keeps snapshot comparison working after import", () => {
    const source = projectWithSnapshot();
    const changedSource = saveScenario(
      {
        ...source,
        nodes: source.nodes.map((node, index) =>
          index === 0 ? { ...node, durationMs: 90 } : node,
        ),
      },
      simulateProject({
        ...source,
        nodes: source.nodes.map((node, index) =>
          index === 0 ? { ...node, durationMs: 90 } : node,
        ),
      }),
      "提速方案",
    );
    const imported = importProjectTransfer(
      exportText(changedSource),
      [],
    ).project;
    expect(imported.scenarios).toHaveLength(2);
    // 快照完成预算随文件保留，对比选择不依赖旧 id。
    expect(imported.scenarios[0]?.completionMs).toBeLessThan(
      imported.scenarios[1]?.completionMs ?? Infinity,
    );
    // 恢复任一导入方案后，链路仍可直接推演。
    const restored = restoreScenario(imported, imported.scenarios[0]?.id ?? "");
    const result = simulateProject(restored);
    expect(result.entries).toHaveLength(restored.nodes.length);
  });
});

describe("reidentifyProject", () => {
  it("gives snapshot-only nodes fresh ids and leaves internal refs intact", () => {
    const source = projectWithSnapshot();
    const reidentified = reidentifyProject(source, source.title, 5);
    expect(reidentified.createdAt).toBe(5);
    const liveIds = new Set(reidentified.nodes.map((node) => node.id));
    const snapshot = reidentified.scenarios[0];
    // 示例项目的快照包含全部 live 节点，因此快照 id 与 live 共享映射。
    for (const node of snapshot?.nodes ?? [])
      expect(liveIds.has(node.id)).toBe(true);
  });
});
