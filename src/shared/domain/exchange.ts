import { analyzeGraph } from "./graph";
import { parseProject, isRecord } from "./parse";
import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  WorkspaceDocument,
} from "./types";

export const EXCHANGE_KIND = "latency-lab.project";
export const EXCHANGE_FORMAT_VERSION = 1;
export const EXCHANGE_APP_VERSION = "1.0.0";

export interface ProjectExchangeFile {
  kind: typeof EXCHANGE_KIND;
  formatVersion: number;
  appVersion: string;
  exportedAt: number;
  project: LatencyProject;
}

export type ImportFailureReason =
  "unreadable" | "unknown-kind" | "higher-version" | "corrupt";

export interface ImportFailure {
  ok: false;
  reason: ImportFailureReason;
  message: string;
}

export interface ImportSuccess {
  ok: true;
  document: WorkspaceDocument;
  project: LatencyProject;
  notes: string[];
}

export interface ImportOptions {
  now?: number;
  uuid?: () => string;
}

export function createExchangeFile(
  project: LatencyProject,
  now = Date.now(),
): ProjectExchangeFile {
  return {
    kind: EXCHANGE_KIND,
    formatVersion: EXCHANGE_FORMAT_VERSION,
    appVersion: EXCHANGE_APP_VERSION,
    exportedAt: now,
    project: structuredClone(project),
  };
}

export function serializeExchangeFile(file: ProjectExchangeFile): string {
  return JSON.stringify(file, null, 2);
}

function fail(reason: ImportFailureReason, message: string): ImportFailure {
  return { ok: false, reason, message };
}

function hasDuplicateNodeIds(rawProject: Record<string, unknown>): boolean {
  if (!Array.isArray(rawProject.nodes)) return false;
  const ids = new Set<string>();
  for (const node of rawProject.nodes) {
    if (!isRecord(node) || typeof node.id !== "string") continue;
    if (ids.has(node.id)) return true;
    ids.add(node.id);
  }
  return false;
}

/**
 * 解析并严格校验交换文件。任何无法完整重建项目主体的情况都返回失败，
 * 由调用方保证不触碰现有工作区。
 */
export function parseExchangeText(
  text: string,
): { ok: true; project: LatencyProject } | ImportFailure {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return fail(
      "unreadable",
      "文件无法解析，可能已损坏或不是 LatencyLab 的导出文件。",
    );
  }
  if (!isRecord(value))
    return fail("unreadable", "交换文件结构已损坏，找不到项目数据。");
  if (value.kind !== EXCHANGE_KIND)
    return fail(
      "unknown-kind",
      "这不是 LatencyLab 项目导出文件，请确认文件来源。",
    );
  if (typeof value.formatVersion !== "number")
    return fail("corrupt", "交换文件缺少格式版本信息，无法导入。");
  if (value.formatVersion > EXCHANGE_FORMAT_VERSION)
    return fail(
      "higher-version",
      `文件来自更新版本（格式 v${value.formatVersion}），请升级 LatencyLab 后再导入。`,
    );
  if (value.formatVersion < EXCHANGE_FORMAT_VERSION)
    return fail(
      "corrupt",
      `文件格式版本（v${value.formatVersion}）过旧，已不兼容当前版本。`,
    );
  if (!isRecord(value.project))
    return fail("corrupt", "交换文件缺少项目数据，无法导入。");
  if (hasDuplicateNodeIds(value.project))
    return fail(
      "corrupt",
      "文件中的节点标识出现重复，项目数据已损坏，无法导入。",
    );
  const parsed = parseProject(value.project);
  if (!parsed) return fail("corrupt", "项目数据不完整或已损坏，无法导入。");
  if (parsed.recovered)
    return fail(
      "corrupt",
      "文件中的节点或引用已损坏（存在无法识别的字段或失效连线），为避免破坏工作区已停止导入。",
    );
  return { ok: true, project: parsed.project };
}

function uniqueProjectTitle(title: string, existing: Set<string>): string {
  const base = title.trim() || "未命名链路";
  if (!existing.has(base)) return base;
  let candidate = `${base} · 导入`;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base} · 导入 ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function remapEdges(
  nodes: RequestNode[],
  idMap: Map<string, string>,
  onHealed: (message: string) => void,
  label: string,
): RequestNode[] {
  return nodes.map((node) => {
    const seen = new Set<string>();
    const dependencyIds: string[] = [];
    for (const dependencyId of node.dependencyIds) {
      const next = idMap.get(dependencyId);
      if (!next || next === node.id || seen.has(next)) {
        if (dependencyId !== node.id) onHealed(`${label}存在失效的依赖引用`);
        continue;
      }
      seen.add(next);
      dependencyIds.push(next);
    }
    let fallbackNodeId: string | undefined;
    const mappedFallback = node.fallbackNodeId
      ? idMap.get(node.fallbackNodeId)
      : undefined;
    if (
      node.fallbackNodeId &&
      (!mappedFallback || mappedFallback === node.id)
    ) {
      onHealed(`${label}存在失效的降级引用`);
    } else {
      fallbackNodeId = mappedFallback;
    }
    return {
      ...node,
      dependencyIds,
      ...(fallbackNodeId ? { fallbackNodeId } : { fallbackNodeId: undefined }),
    };
  });
}

function rebuildScenario(
  scenario: ScenarioSnapshot,
  globalNodeMap: Map<string, string>,
  uuid: () => string,
  notes: string[],
): ScenarioSnapshot | undefined {
  const label = `方案「${scenario.name}」`;
  const scenarioIds = new Set(scenario.nodes.map((node) => node.id));
  if (scenarioIds.size !== scenario.nodes.length) {
    notes.push(`${label}的节点标识重复，已跳过该快照。`);
    return undefined;
  }
  const idMap = new Map(globalNodeMap);
  const nodes: RequestNode[] = scenario.nodes.map((node) => {
    const mapped = idMap.get(node.id) ?? `node-${uuid()}`;
    if (!idMap.has(node.id)) idMap.set(node.id, mapped);
    return { ...node, id: mapped };
  });
  let healed = false;
  const remappedNodes = remapEdges(
    nodes,
    idMap,
    () => {
      healed = true;
    },
    label,
  );
  if (healed) notes.push(`${label}中的失效连线已自动清理。`);
  const probe: LatencyProject = {
    id: "probe",
    title: label,
    nodes: remappedNodes,
    concurrencyLimit: scenario.concurrencyLimit,
    scenarios: [],
    createdAt: scenario.createdAt,
    updatedAt: scenario.createdAt,
  };
  if (analyzeGraph(probe).validation.errors.length) {
    notes.push(`${label}存在无法修复的链路问题，已跳过该快照。`);
    return undefined;
  }
  const criticalPath = scenario.criticalPath
    .map((id) => idMap.get(id))
    .filter((id): id is string => Boolean(id));
  return {
    ...scenario,
    id: uuid(),
    nodes: remappedNodes,
    criticalPath,
  };
}

/**
 * 基于解析后的项目重建全部对象标识：项目、节点、方案快照都会获得新 ID，
 * 依赖与降级引用按映射重写；项目重名时追加“导入”后缀。
 */
export function rebuildImportedProject(
  source: LatencyProject,
  existingTitles: Set<string>,
  options: ImportOptions = {},
): { project: LatencyProject; notes: string[] } {
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now();
  const notes: string[] = [];

  const projectId = `project-${uuid()}`;
  const nodeIdMap = new Map<string, string>();
  for (const node of source.nodes) nodeIdMap.set(node.id, `node-${uuid()}`);
  const rebuiltNodes = source.nodes.map((node) => ({
    ...node,
    id: nodeIdMap.get(node.id) ?? node.id,
  }));
  const remappedNodes = remapEdges(
    rebuiltNodes,
    nodeIdMap,
    (message) => notes.push(message),
    "项目",
  );

  const scenarios = source.scenarios
    .map((scenario) => rebuildScenario(scenario, nodeIdMap, uuid, notes))
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  if (scenarios.length !== source.scenarios.length)
    notes.unshift(
      `共跳过 ${source.scenarios.length - scenarios.length} 份无法读取的方案快照。`,
    );

  const project: LatencyProject = {
    ...structuredClone(source),
    id: projectId,
    title: uniqueProjectTitle(source.title, existingTitles),
    nodes: remappedNodes,
    scenarios,
    updatedAt: now,
  };
  return { project, notes };
}

/**
 * 把交换文本导入工作区。解析、校验、重建全部完成后才返回新文档，
 * 任何失败都不修改入参文档，现有工作区不受影响。
 */
export function importProjectIntoDocument(
  document: WorkspaceDocument,
  text: string,
  options: ImportOptions = {},
): ImportSuccess | ImportFailure {
  const parsed = parseExchangeText(text);
  if (!parsed.ok) return parsed;

  const existingTitles = new Set(document.projects.map((item) => item.title));
  const { project, notes } = rebuildImportedProject(
    parsed.project,
    existingTitles,
    options,
  );

  const graphErrors = analyzeGraph(project).validation.errors;
  if (graphErrors.length)
    return fail(
      "corrupt",
      `导入项目的链路无法推演：${graphErrors[0] ?? "配置有误"}。已停止导入，现有项目未受影响。`,
    );

  return {
    ok: true,
    project,
    notes,
    document: {
      ...document,
      activeProjectId: project.id,
      projects: [project, ...document.projects],
    },
  };
}
