import { buildProjectTransfer } from "../domain/transfer";
import type { LatencyProject } from "../domain/types";

const FILE_EXTENSION = ".latency-lab.json";

function sanitizeFileName(title: string): string {
  const withoutControlChars = Array.from(title)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("");
  return (
    withoutControlChars
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 80)
      .trim() || "latency-project"
  );
}

/** 触发浏览器下载，把项目（含方案快照）导出为一份交换文件。 */
export function downloadProjectTransfer(project: LatencyProject): void {
  const payload = JSON.stringify(buildProjectTransfer(project), null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sanitizeFileName(project.title)}${FILE_EXTENSION}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * 弹出文件选择并读取文本。取消选择时返回 null；
 * 读取失败时 reject，由调用方提示，不触碰工作区数据。
 */
export function pickAndReadTransferFile(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.hidden = true;
    let settled = false;
    const cleanup = () => {
      input.remove();
    };
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(null);
        }
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(typeof reader.result === "string" ? reader.result : null);
      };
      reader.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(reader.error ?? new Error("文件读取失败"));
      };
      reader.readAsText(file);
    };
    // 用户不选择任何文件直接关闭选择器时也要释放节点。
    window.addEventListener(
      "focus",
      () => {
        window.setTimeout(() => {
          if (settled) return;
          if (input.files && input.files.length > 0) return;
          settled = true;
          cleanup();
          resolve(null);
        }, 300);
      },
      { once: true },
    );
    document.body.append(input);
    input.click();
  });
}
