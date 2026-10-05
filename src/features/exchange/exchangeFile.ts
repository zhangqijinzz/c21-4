import {
  createExchangeFile,
  serializeExchangeFile,
} from "../../shared/domain/exchange";
import type { LatencyProject } from "../../shared/domain/types";

function safeFileName(title: string): string {
  const illegal = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);
  const chars = Array.from(title.trim(), (char) =>
    illegal.has(char) || char.charCodeAt(0) < 32 ? "-" : char,
  );
  const base = chars
    .join("")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "latency-lab-project";
}

/** 触发浏览器下载一份 .latency-lab.json 交换文件。 */
export function downloadProjectFile(
  project: LatencyProject,
  now = Date.now(),
): void {
  const file = createExchangeFile(project, now);
  const blob = new Blob([serializeExchangeFile(file)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(project.title)}.latency-lab.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 读取用户选择的交换文件文本。 */
export function readExchangeFile(file: File): Promise<string> {
  return file.text();
}
