import { describe, expect, it } from "vitest";
import {
  createExchangeFile,
  EXCHANGE_FORMAT_VERSION,
  EXCHANGE_KIND,
  importProjectIntoDocument,
  parseExchangeText,
  rebuildImportedProject,
  serializeExchangeFile,
} from "../src/shared/domain/exchange";
import { saveScenario } from "../src/features/scenarios/scenarioViewModel";
import { restoreScenario } from "../src/features/scenarios/scenarioViewModel";
import { updateProject } from "../src/features/projects/projectViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

function documentWith(projects: LatencyProject[]): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: projects[0]?.id ?? "",
    projects,
  };
}

function projectWithSnapshots(): LatencyProject {
  const result = simulateProject(EXAMPLE_PROJECT);
  const once = saveScenario(EXAMPLE_PROJECT, result, "基线方案");
  return saveScenario(
    { ...once, concurrencyLimit: 2 },
    simulateProject({ ...once, concurrencyLimit: 2 }),
    "并发 2 路",
  );
}

describe("project exchange export", () => {
  it("packages a project with its scenario snapshots into a versioned file", () => {
    const project = projectWithSnapshots();
    const file = createExchangeFile(project, 123);
    expect(file.kind).toBe(EXCHANGE_KIND);
    expect(file.formatVersion).toBe(EXCHANGE_FORMAT_VERSION);
    expect(file.exportedAt).toBe(123);
    expect(file.project.scenarios).toHaveLength(2);
    // 导出使用深拷贝，后续改动不污染文件内容。
    file.project.title = "changed";
    expect(project.title).not.toBe("changed");
    expect(() => JSON.parse(serializeExchangeFile(file))).not.toThrow();
  });
});

describe("project exchange import", () => {
  it("round-trips a project, rebuilding every object identity and remapping edges", () => {
    const project = projectWithSnapshots();
    const file = serializeExchangeFile(createExchangeFile(project, 1));
    const document = documentWith([
      {
        id: "project-local",
        title: "本地项目",
        nodes: [],
        concurrencyLimit: null,
        scenarios: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    let counter = 0;
    const outcome = importProjectIntoDocument(document, file, {
      now: 999,
      uuid: () => `id-${++counter}`,
    });
    if (!outcome.ok) throw new Error(outcome.message);

    expect(outcome.document.projects).toHaveLength(2);
    const imported = outcome.project;
    expect(imported.id).toBe("project-id-1");
    expect(imported.id).not.toBe(project.id);
    expect(outcome.document.activeProjectId).toBe(imported.id);

    const byOldId = new Map(
      project.nodes.map((node, index) => [node.id, imported.nodes[index]?.id]),
    );
    for (const node of imported.nodes) expect(node.id).toMatch(/^node-id-/);
    expect(new Set(imported.nodes.map((node) => node.id)).size).toBe(
      imported.nodes.length,
    );
    // 依赖引用被重写到新标识。
    const profile = imported.nodes.find((node) => node.name === "用户资料");
    expect(profile?.dependencyIds).toEqual([byOldId.get("session")]);
    const recommend = imported.nodes.find((node) => node.name === "个性推荐");
    expect(recommend?.dependencyIds.sort()).toEqual(
      ["flags", "profile"].map((id) => byOldId.get(id)).sort(),
    );
    expect(recommend?.fallbackNodeId).toBe(byOldId.get("catalog"));

    // 方案快照同样重建标识，且同一节点在快照间保持同一新标识，便于对比。
    expect(imported.scenarios).toHaveLength(2);
    for (const scenario of imported.scenarios) {
      expect(scenario.id).not.toBe(
        project.scenarios.find((item) => item.name === scenario.name)?.id,
      );
      const sessionSnapshot = scenario.nodes.find(
        (node) => node.name === "会话校验",
      );
      expect(sessionSnapshot?.id).toBe(byOldId.get("session"));
      const recommendSnapshot = scenario.nodes.find(
        (node) => node.name === "个性推荐",
      );
      expect(recommendSnapshot?.fallbackNodeId).toBe(byOldId.get("catalog"));
      expect(
        scenario.criticalPath.every((id) => id.startsWith("node-id-")),
      ).toBe(true);
    }
    // 导入后可以直接推演。
    expect(simulateProject(imported).entries).toHaveLength(
      imported.nodes.length,
    );
  });

  it("never mutates the existing workspace when import succeeds or fails", () => {
    const local = structuredClone(EXAMPLE_PROJECT);
    local.id = "project-local";
    local.title = "本地项目";
    const document = documentWith([local]);

    const file = serializeExchangeFile(
      createExchangeFile(projectWithSnapshots()),
    );
    const outcome = importProjectIntoDocument(document, file);
    if (!outcome.ok) throw new Error(outcome.message);
    // 入参文档保持原样。
    expect(document.projects).toHaveLength(1);
    expect(document.projects[0]?.id).toBe("project-local");
    expect(document.activeProjectId).toBe("project-local");

    const failure = importProjectIntoDocument(document, "{not json");
    expect(failure.ok).toBe(false);
    expect(document.projects).toHaveLength(1);
  });

  it("renames an imported project when the title already exists locally", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    const existing = new Set([project.title]);

    const first = rebuildImportedProject(project, existing, {
      uuid: () => crypto.randomUUID(),
    });
    expect(first.project.title).toBe(`${project.title} · 导入`);
    const existingTwice = new Set([project.title, first.project.title]);
    const second = rebuildImportedProject(project, existingTwice, {
      uuid: () => crypto.randomUUID(),
    });
    expect(second.project.title).toBe(`${project.title} · 导入 2`);
  });

  it("rejects unreadable, foreign, and higher-version files", () => {
    const document = documentWith([structuredClone(EXAMPLE_PROJECT)]);
    const unreadable = importProjectIntoDocument(document, "not json at all");
    expect(unreadable).toMatchObject({ ok: false, reason: "unreadable" });

    const foreign = importProjectIntoDocument(
      document,
      JSON.stringify({ kind: "other-app", formatVersion: 1 }),
    );
    expect(foreign).toMatchObject({ ok: false, reason: "unknown-kind" });

    const higher = importProjectIntoDocument(
      document,
      JSON.stringify({
        kind: EXCHANGE_KIND,
        formatVersion: EXCHANGE_FORMAT_VERSION + 1,
        project: {},
      }),
    );
    expect(higher).toMatchObject({ ok: false, reason: "higher-version" });
    expect(document.projects).toHaveLength(1);
  });

  it("rejects a tampered project body with broken edges or duplicated ids", () => {
    const document = documentWith([structuredClone(EXAMPLE_PROJECT)]);
    const tamperedEdges = structuredClone(EXAMPLE_PROJECT);
    tamperedEdges.nodes[0] = {
      ...tamperedEdges.nodes[0]!,
      dependencyIds: ["node-that-does-not-exist"],
    };
    const broken = importProjectIntoDocument(
      document,
      serializeExchangeFile(createExchangeFile(tamperedEdges)),
    );
    expect(broken).toMatchObject({ ok: false, reason: "corrupt" });

    const duplicateIds = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: [
        EXAMPLE_PROJECT.nodes[0]!,
        { ...EXAMPLE_PROJECT.nodes[1]!, id: EXAMPLE_PROJECT.nodes[0]!.id },
      ],
    };
    const duplicated = importProjectIntoDocument(
      document,
      serializeExchangeFile(createExchangeFile(duplicateIds)),
    );
    expect(duplicated).toMatchObject({ ok: false, reason: "corrupt" });
    expect(document.projects).toHaveLength(1);
  });

  it("heals snapshots that contain nodes absent from the live graph", () => {
    // 先在五节点图上保存快照，之后活动图删掉了三个节点。
    const full = structuredClone(EXAMPLE_PROJECT);
    const oldResult = simulateProject(full);
    const withSnapshot = saveScenario(full, oldResult, "旧五节点方案");
    const live: LatencyProject = {
      ...withSnapshot,
      nodes: withSnapshot.nodes.slice(0, 2),
    };
    const file = serializeExchangeFile(createExchangeFile(live));
    const outcome = importProjectIntoDocument(
      documentWith([structuredClone(EXAMPLE_PROJECT)]),
      file,
      { uuid: () => crypto.randomUUID() },
    );
    if (!outcome.ok) throw new Error(outcome.message);
    const imported = outcome.project;
    const snapshot = imported.scenarios[0];
    if (!snapshot) throw new Error("imported project should keep the snapshot");
    expect(snapshot.nodes).toHaveLength(5);
    // 快照独有节点拿到唯一新标识；恢复后整张图仍可推演。
    const liveIds = new Set(imported.nodes.map((node) => node.id));
    const snapshotIds = new Set(snapshot.nodes.map((node) => node.id));
    for (const id of liveIds) expect(snapshotIds.has(id)).toBe(true);
    expect(snapshotIds.size).toBe(5);
    const probe = simulateProject({
      ...imported,
      nodes: snapshot.nodes,
      concurrencyLimit: snapshot.concurrencyLimit,
    });
    expect(probe.entries).toHaveLength(5);
  });

  it("drops snapshots that cannot form a valid DAG and reports notes", () => {
    const result = simulateProject(EXAMPLE_PROJECT);
    const saved = saveScenario(EXAMPLE_PROJECT, result, "正常方案");
    const cyclicSnapshot = structuredClone(saved.scenarios[0]!);
    cyclicSnapshot.id = "snapshot-cyclic";
    cyclicSnapshot.name = "被改坏的方案";
    cyclicSnapshot.nodes = cyclicSnapshot.nodes.map((node) =>
      node.id === "session" ? { ...node, dependencyIds: ["catalog"] } : node,
    );
    const damaged: LatencyProject = {
      ...saved,
      scenarios: [cyclicSnapshot, ...saved.scenarios],
    };
    const outcome = importProjectIntoDocument(
      documentWith([structuredClone(EXAMPLE_PROJECT)]),
      serializeExchangeFile(createExchangeFile(damaged)),
      { uuid: () => crypto.randomUUID() },
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.project.scenarios).toHaveLength(1);
    expect(outcome.project.scenarios[0]?.name).toBe("正常方案");
    expect(outcome.notes.join(" ")).toContain("跳过");
  });

  it("restoring an imported snapshot never writes nodes into another project", () => {
    const local = structuredClone(EXAMPLE_PROJECT);
    local.id = "project-local";
    local.title = "本地项目";
    const localNodeIds = local.nodes.map((node) => node.id);
    const document = documentWith([local]);

    const outcome = importProjectIntoDocument(
      document,
      serializeExchangeFile(createExchangeFile(projectWithSnapshots())),
      { uuid: () => crypto.randomUUID() },
    );
    if (!outcome.ok) throw new Error(outcome.message);
    const imported = outcome.project;
    const restored = restoreScenario(imported, imported.scenarios[0]!.id);
    expect(restored.id).toBe(imported.id);
    expect(restored.nodes.map((node) => node.id)).not.toEqual(localNodeIds);

    // 通过仓储式更新提交后，只替换同 id 项目，本地项目原样保留。
    const merged = updateProject(outcome.document, restored);
    const untouchedLocal = merged.projects.find(
      (project) => project.id === "project-local",
    );
    expect(untouchedLocal?.nodes.map((node) => node.id)).toEqual(localNodeIds);
    const storedImport = merged.projects.find(
      (project) => project.id === imported.id,
    );
    expect(storedImport?.nodes.map((node) => node.id)).toEqual(
      restored.nodes.map((node) => node.id),
    );
  });

  it("stays a plain parse helper for valid payloads", () => {
    const parsed = parseExchangeText(
      serializeExchangeFile(createExchangeFile(EXAMPLE_PROJECT)),
    );
    expect(parsed.ok).toBe(true);
  });
});
