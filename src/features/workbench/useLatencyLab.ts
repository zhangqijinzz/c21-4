import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectRepository } from "../../shared/repositories/projectRepository";
import type {
  LatencyProject,
  SimulationMode,
  WorkspaceDocument,
} from "../../shared/domain/types";
import {
  addImportedProject,
  createProject,
  duplicateProject,
  removeProject,
  renameProject,
  selectProject,
  updateProject,
} from "../projects/projectViewModel";
import {
  addRequestNode,
  patchRequestNode,
  removeRequestNode,
  setConcurrency,
  toggleDependency,
  getGraphAnalysis,
} from "../graph-editor/graphViewModel";
import {
  compareScenarios,
  removeScenario,
  restoreScenario,
  saveScenario,
  type ScenarioComparison,
} from "../scenarios/scenarioViewModel";
import { simulateProject } from "../../shared/domain/simulation";
import {
  importProjectTransfer,
  TransferFormatError,
} from "../../shared/domain/transfer";
import {
  downloadProjectTransfer,
  pickAndReadTransferFile,
} from "../../shared/services/transferFileService";

export type LabStatus =
  "loading" | "ready" | "editing" | "simulating" | "error" | "completed";
export type LabModule =
  "projects" | "graph" | "simulation" | "scenarios" | "archive";

export function useLatencyLab() {
  const repository = useMemo(() => new ProjectRepository(), []);
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const documentRef = useRef<WorkspaceDocument | null>(null);
  const [status, setStatus] = useState<LabStatus>("loading");
  const [module, setModule] = useState<LabModule>("simulation");
  const [mode, setMode] = useState<SimulationMode>("expected");
  const [comparisonIds, setComparisonIds] = useState<{
    baselineId: string;
    comparisonId: string;
  }>({ baselineId: "", comparisonId: "" });
  const [notice, setNotice] = useState("");
  const [persisted, setPersisted] = useState<"saving" | "saved" | "error">(
    "saved",
  );
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const activeProject =
    document?.projects.find(
      (project) => project.id === document.activeProjectId,
    ) ?? document?.projects[0];
  const result = useMemo(
    () => (activeProject ? simulateProject(activeProject, mode) : undefined),
    [activeProject, mode],
  );
  const graphAnalysis = useMemo(
    () => (activeProject ? getGraphAnalysis(activeProject) : undefined),
    [activeProject],
  );
  const scenarioList = activeProject?.scenarios ?? [];
  const baselineScenario =
    scenarioList.find((scenario) => scenario.id === comparisonIds.baselineId) ??
    scenarioList[1] ??
    scenarioList[0];
  const comparisonScenario =
    scenarioList.find(
      (scenario) => scenario.id === comparisonIds.comparisonId,
    ) ?? scenarioList[0];
  const scenarioComparison: ScenarioComparison | undefined =
    baselineScenario && comparisonScenario
      ? compareScenarios(baselineScenario, comparisonScenario)
      : undefined;
  const simulationValid =
    Boolean(activeProject) &&
    result?.entries.length === activeProject?.nodes.length;

  const selectComparisonScenario = useCallback(
    (side: "baselineId" | "comparisonId", id: string) => {
      setComparisonIds((current) => ({ ...current, [side]: id }));
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    void repository
      .load()
      .then(({ document: loaded, recovered }) => {
        if (!mounted) return;
        documentRef.current = loaded;
        setDocument(loaded);
        setStatus("ready");
        if (recovered)
          setNotice("已载入示例工作区；后续修改会自动保存到此设备。");
      })
      .catch(() => {
        if (!mounted) return;
        setStatus("error");
        setNotice("本地项目读取失败，刷新页面可再次尝试。");
      });
    return () => {
      mounted = false;
    };
  }, [repository]);

  const commit = useCallback(
    (next: WorkspaceDocument, nextStatus: LabStatus = "editing") => {
      const currentRevision = ++revision.current;
      documentRef.current = next;
      setDocument(next);
      setStatus(nextStatus);
      setNotice("");
      setPersisted("saving");
      queue.current = queue.current
        .then(() => repository.save(next))
        .then(() => {
          if (revision.current === currentRevision) {
            setPersisted("saved");
            if (nextStatus === "editing") setStatus("completed");
          }
        })
        .catch(() => {
          if (revision.current === currentRevision) {
            setPersisted("error");
            setStatus("error");
            setNotice("保存失败。数据仍保留在当前页面，请重试保存。");
          }
        });
    },
    [repository],
  );

  const editProject = useCallback(
    (project: LatencyProject) => {
      const current = documentRef.current;
      if (current) commit(updateProject(current, project));
    },
    [commit],
  );

  const chooseProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current) commit(selectProject(current, id), "ready");
    },
    [commit],
  );

  const newProject = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(createProject(current), "editing");
  }, [commit]);

  const renameActive = useCallback(
    (title: string) => {
      if (activeProject) editProject(renameProject(activeProject, title));
    },
    [activeProject, editProject],
  );

  const duplicateActive = useCallback(() => {
    const current = documentRef.current;
    if (current && activeProject)
      commit(duplicateProject(current, activeProject), "editing");
  }, [activeProject, commit]);

  const deleteProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current && current.projects.length > 1)
        commit(removeProject(current, id), "editing");
      else setNotice("至少保留一个链路项目。");
    },
    [commit],
  );

  const addNode = useCallback(() => {
    if (activeProject) editProject(addRequestNode(activeProject));
  }, [activeProject, editProject]);
  const patchNode = useCallback(
    (id: string, patch: Parameters<typeof patchRequestNode>[2]) => {
      if (activeProject)
        editProject(patchRequestNode(activeProject, id, patch));
    },
    [activeProject, editProject],
  );
  const deleteNode = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeRequestNode(activeProject, id));
    },
    [activeProject, editProject],
  );
  const setNodeDependency = useCallback(
    (id: string, dependencyId: string) => {
      if (!activeProject) return;
      const outcome = toggleDependency(activeProject, id, dependencyId);
      if (outcome.error) setNotice(outcome.error);
      else editProject(outcome.project);
    },
    [activeProject, editProject],
  );
  const setLimit = useCallback(
    (limit: number | null) => {
      if (activeProject) editProject(setConcurrency(activeProject, limit));
    },
    [activeProject, editProject],
  );

  const simulate = useCallback(
    (nextMode = mode) => {
      if (!activeProject) return undefined;
      setStatus("simulating");
      const result = simulateProject(activeProject, nextMode);
      setMode(nextMode);
      setStatus(
        result.warnings.some((warning) => warning.includes("循环"))
          ? "error"
          : "completed",
      );
      return result;
    },
    [activeProject, mode],
  );

  const saveSnapshot = useCallback(
    (name: string): boolean => {
      if (!activeProject) return false;
      const result = simulateProject(activeProject, mode);
      if (result.entries.length !== activeProject.nodes.length) {
        setNotice(result.warnings[0] ?? "请先修复链路配置再保存方案。");
        return false;
      }
      const next = saveScenario(activeProject, result, name);
      editProject(next);
      setComparisonIds({
        baselineId: next.scenarios[1]?.id ?? next.scenarios[0]?.id ?? "",
        comparisonId: next.scenarios[0]?.id ?? "",
      });
      setNotice("方案快照已保存。");
      return true;
    },
    [activeProject, editProject, mode],
  );

  const removeSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeScenario(activeProject, id));
    },
    [activeProject, editProject],
  );
  const restoreSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) editProject(restoreScenario(activeProject, id));
    },
    [activeProject, editProject],
  );

  const retrySave = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(current);
  }, [commit]);

  const exportActiveProject = useCallback(() => {
    if (!activeProject) return;
    try {
      downloadProjectTransfer(activeProject);
      setNotice(`已导出「${activeProject.title}」，可把文件发给同事导入。`);
    } catch {
      setNotice("导出失败，请重试或更换浏览器下载目录。");
    }
  }, [activeProject]);

  const exportProjectById = useCallback((id: string) => {
    const project = documentRef.current?.projects.find(
      (item) => item.id === id,
    );
    if (!project) return;
    try {
      downloadProjectTransfer(project);
      setNotice(`已导出「${project.title}」，可把文件发给同事导入。`);
    } catch {
      setNotice("导出失败，请重试或更换浏览器下载目录。");
    }
  }, []);

  const importProjectFile = useCallback(async (): Promise<boolean> => {
    const current = documentRef.current;
    if (!current) return false;
    let text: string | null;
    try {
      text = await pickAndReadTransferFile();
    } catch {
      setNotice("文件读取失败，请重新选择导出文件。");
      return false;
    }
    if (text === null) return false; // 用户取消选择
    try {
      // 先在内存里完成全部解析与标识重建，成功后才提交，
      // 任何失败都不会触碰现有工作区。
      const imported = importProjectTransfer(
        text,
        current.projects.map((project) => project.title),
      );
      setComparisonIds({ baselineId: "", comparisonId: "" });
      commit(addImportedProject(current, imported.project), "editing");
      setNotice(
        imported.warnings.length
          ? `已导入「${imported.project.title}」。${imported.warnings.join(" ")}`
          : `已导入「${imported.project.title}」，可直接继续推演。`,
      );
      return true;
    } catch (error) {
      const message =
        error instanceof TransferFormatError
          ? error.message
          : "导入失败：文件无法解析，现有项目未受影响。";
      setNotice(message);
      return false;
    }
  }, [commit]);

  return {
    document,
    activeProject,
    result,
    graphAnalysis,
    simulationValid,
    status,
    module,
    setModule,
    mode,
    setMode,
    notice,
    setNotice,
    persisted,
    chooseProject,
    newProject,
    renameActive,
    duplicateActive,
    deleteProject,
    addNode,
    patchNode,
    deleteNode,
    setNodeDependency,
    setLimit,
    simulate,
    saveSnapshot,
    removeSavedScenario,
    restoreSavedScenario,
    retrySave,
    scenarioList,
    baselineScenario,
    comparisonScenario,
    scenarioComparison,
    selectComparisonScenario,
    exportActiveProject,
    exportProjectById,
    importProjectFile,
  };
}
