import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type WorkspaceDocument,
} from "../domain/types";
import { isRecord, parseProject } from "../domain/codec";
import { IndexedDbService } from "../services/indexedDbService";

const FALLBACK_KEY = "latency-lab.workspace.v1";

export function parseWorkspace(
  value: unknown,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects))
    return undefined;
  const parsed = value.projects.map(parseProject);
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => entry?.recovered);
  return { document: { version: 1, activeProjectId, projects }, recovered };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  write(value: WorkspaceDocument): Promise<void>;
}

export class ProjectRepository {
  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
  ) {}

  async load(): Promise<{ document: WorkspaceDocument; recovered: boolean }> {
    try {
      const stored = parseWorkspace(await this.storage.read());
      if (stored) return stored;
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) {
        try {
          const fallback = parseWorkspace(JSON.parse(local) as unknown);
          if (fallback) return { ...fallback, recovered: true };
        } catch {
          localStorage.removeItem(FALLBACK_KEY);
        }
      }
    } catch {
      const local = localStorage.getItem(FALLBACK_KEY);
      if (local) {
        try {
          const fallback = parseWorkspace(JSON.parse(local) as unknown);
          if (fallback) return { ...fallback, recovered: true };
        } catch {
          localStorage.removeItem(FALLBACK_KEY);
        }
      }
    }
    return {
      document: {
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      },
      recovered: true,
    };
  }

  async save(document: WorkspaceDocument): Promise<void> {
    let indexedDbError: unknown;
    try {
      await this.storage.write(document);
    } catch (error) {
      indexedDbError = error;
    }
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(document));
    } catch (error) {
      if (!indexedDbError) throw error;
    }
    if (indexedDbError) throw indexedDbError;
  }
}
