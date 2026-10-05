import { analyzeGraph } from "./graph";
import { isRecord, parseProject } from "./codec";
import type { LatencyProject, ScenarioSnapshot } from "./types";

export const TRANSFER_KIND = "latency-lab.project-transfer";
export const TRANSFER_FORMAT_VERSION = 1;

export type TransferErrorCode =
  "invalid-json" | "unknown-format" | "unsupported-version" | "damaged";

export class TransferFormatError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransferFormatError";
  }
}

export interface ProjectTransferFile {
  kind: typeof TRANSFER_KIND;
  formatVersion: number;
  exportedAt: number;
  source: { app: string; appVersion: string };
  project: LatencyProject;
}

export interface ImportedProject {
  project: LatencyProject;
  warnings: string[];
}

export function buildProjectTransfer(
  project: LatencyProject,
  now = Date.now(),
): ProjectTransferFile {
  return {
    kind: TRANSFER_KIND,
    formatVersion: TRANSFER_FORMAT_VERSION,
    exportedAt: now,
    source: { app: "LatencyLab", appVersion: "1.0.0" },
    project: structuredClone(project),
  };
}

/** 与已有项目重名时，为导入项目取一个不冲突的名字。 */
export function uniqueProjectTitle(
  desired: string,
  existingTitles: Iterable<string>,
): string {
  const taken = new Set(
    [...existingTitles].map((title) => title.trim()).filter(Boolean),
  );
  const base = desired.trim() || "未命名链路";
  if (!taken.has(base)) return base;
  const first = `${base} · 导入`;
  if (!taken.has(first)) return first;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} · 导入 ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function assertUniqueNodeIds(nodes: { id: string }[], scope: string): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id))
      throw new TransferFormatError(
        "damaged",
        `文件已损坏：${scope}中存在重复的节点标识。`,
      );
    seen.add(node.id);
  }
}

function remapScenario(
  snapshot: ScenarioSnapshot,
  sharedNodeIdMap: Map<string, string>,
): ScenarioSnapshot {
  // 快照内节点同样先建好完整映射再改写引用，避免前向依赖丢失。
  const nodeIdMap = new Map(sharedNodeIdMap);
  for (const node of snapshot.nodes) {
    if (!nodeIdMap.has(node.id)) nodeIdMap.set(node.id, crypto.randomUUID());
  }
  const mappedNodes = snapshot.nodes.map((node) => ({
    ...node,
    id: nodeIdMap.get(node.id) ?? node.id,
  }));
  const mappedNodeIds = new Set(mappedNodes.map((node) => node.id));
  // 快照只对自身包含的节点成立：悬空或越界引用一律丢弃，
  // 与工作区恢复时的降级规则保持一致。
  const safeNodes = mappedNodes.map((node) => {
    const dependencyIds = node.dependencyIds
      .map((id) => nodeIdMap.get(id))
      .filter(
        (id): id is string =>
          id !== undefined && id !== node.id && mappedNodeIds.has(id),
      );
    const fallbackId = node.fallbackNodeId
      ? nodeIdMap.get(node.fallbackNodeId)
      : undefined;
    const fallbackNodeId =
      fallbackId && fallbackId !== node.id && mappedNodeIds.has(fallbackId)
        ? fallbackId
        : undefined;
    return {
      ...node,
      dependencyIds,
      ...(fallbackNodeId ? { fallbackNodeId } : { fallbackNodeId: undefined }),
    };
  });
  return {
    ...snapshot,
    id: crypto.randomUUID(),
    nodes: safeNodes,
    criticalPath: snapshot.criticalPath
      .map((id) => nodeIdMap.get(id))
      .filter((id): id is string => id !== undefined && mappedNodeIds.has(id)),
  };
}

/**
 * 重建项目内全部对象标识：项目、节点、方案快照都生成新 ID，
 * 依赖与降级引用、快照关键路径按同一映射表改写，保证导入的方案
 * 恢复后只会写回这份导入项目本身。
 */
export function reidentifyProject(
  source: LatencyProject,
  title: string,
  now = Date.now(),
): LatencyProject {
  assertUniqueNodeIds(source.nodes, "当前编排");
  // 先生成完整的节点标识映射，再改写引用，
  // 否则靠前的节点无法解析指向靠后节点的依赖。
  const nodeIdMap = new Map<string, string>();
  for (const node of source.nodes) nodeIdMap.set(node.id, crypto.randomUUID());
  const nodes = source.nodes.map((node) => {
    const dependencyIds = node.dependencyIds
      .map((id) => nodeIdMap.get(id))
      .filter((id): id is string => id !== undefined);
    const fallbackNodeId = node.fallbackNodeId
      ? nodeIdMap.get(node.fallbackNodeId)
      : undefined;
    return {
      ...node,
      id: nodeIdMap.get(node.id) ?? node.id,
      dependencyIds,
      ...(fallbackNodeId ? { fallbackNodeId } : { fallbackNodeId: undefined }),
    };
  });
  const scenarios = source.scenarios.map((snapshot) => {
    assertUniqueNodeIds(snapshot.nodes, `方案「${snapshot.name}」`);
    return remapScenario(snapshot, nodeIdMap);
  });
  return {
    ...source,
    id: `project-${crypto.randomUUID()}`,
    title,
    nodes,
    scenarios,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 解析交换文件并生成可直接加入工作区的项目。
 * 任何校验失败都会抛出 TransferFormatError，调用方在提交前捕获即可，
 * 现有工作区不会被改动。
 */
export function importProjectTransfer(
  text: string,
  existingTitles: Iterable<string>,
  now = Date.now(),
): ImportedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new TransferFormatError(
      "invalid-json",
      "文件已损坏或不是 LatencyLab 导出文件，无法读取。",
    );
  }
  if (!isRecord(raw) || raw.kind !== TRANSFER_KIND)
    throw new TransferFormatError(
      "unknown-format",
      "无法识别的文件：请选择 LatencyLab 导出的项目文件。",
    );
  const formatVersion = raw.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isFinite(formatVersion))
    throw new TransferFormatError("damaged", "文件已损坏：缺少导出格式版本。");
  if (formatVersion > TRANSFER_FORMAT_VERSION)
    throw new TransferFormatError(
      "unsupported-version",
      "文件来自更新版本的 LatencyLab，请先升级再导入。",
    );
  if (formatVersion < 1)
    throw new TransferFormatError("damaged", "文件已损坏：格式版本无效。");
  const parsed = parseProject(raw.project);
  if (!parsed)
    throw new TransferFormatError(
      "damaged",
      "文件已损坏：没有找到完整的链路项目。",
    );

  const warnings: string[] = [];
  if (parsed.recovered)
    warnings.push("文件中部分损坏的节点或引用已被忽略，导入前请检查编排。");
  const source = parsed.project;
  const snapshotRefsBroken = source.scenarios.some((snapshot) => {
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    return (
      snapshot.nodes.some(
        (node) =>
          node.dependencyIds.some((id) => id === node.id || !ids.has(id)) ||
          (node.fallbackNodeId !== undefined &&
            (node.fallbackNodeId === node.id || !ids.has(node.fallbackNodeId))),
      ) || snapshot.criticalPath.some((id) => !ids.has(id))
    );
  });
  if (snapshotRefsBroken)
    warnings.push("部分方案快照内的引用已损坏并被清理，请重新核对该方案。");
  const title = uniqueProjectTitle(source.title, existingTitles);
  if (title !== source.title.trim())
    warnings.push(`已有同名项目，导入后命名为「${title}」。`);
  const project = reidentifyProject(source, title, now);

  const analysis = analyzeGraph(project);
  if (analysis.cycle.length)
    warnings.push("导入的链路存在循环依赖，可在请求编排页修复后再推演。");
  return { project, warnings };
}
