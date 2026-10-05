import { useRef } from "react";
import { Upload } from "lucide-react";
import { readExchangeFile } from "./exchangeFile";

interface Props {
  onImportText: (text: string, fileName: string) => void;
  className?: string;
  label?: string;
  title?: string;
  disabled?: boolean;
}

export default function ImportProjectButton({
  onImportText,
  className = "button button-neutral",
  label = "导入项目",
  title = "从交换文件导入链路项目",
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        className={className}
        title={title}
        aria-label={label}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={15} /> {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          try {
            const text = await readExchangeFile(file);
            onImportText(text, file.name);
          } catch {
            onImportText("", file.name);
          }
        }}
      />
    </>
  );
}
