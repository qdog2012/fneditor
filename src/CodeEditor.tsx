import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useCallback, useEffect, useRef } from "react";

loader.config({ monaco });

(globalThis as unknown as { MonacoEnvironment: { getWorker: (_workerId: string, label: string) => Worker } }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "json") {
      return new jsonWorker();
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  }
};

export type CodeEditorHandle = {
  layout: () => void;
  getValue: () => string;
};

type CodeEditorProps = {
  filePath: string;
  language: string;
  value: string;
  themeMode: "dark" | "light";
  fontSize: number;
  wordWrap: "on" | "off";
  onChange: (value?: string) => void;
  onCursorChange: (cursor: { line: number; column: number }) => void;
  onSave: () => void;
  onEditorReady: (editor: CodeEditorHandle | null) => void;
};

const beforeMount: BeforeMount = (monacoInstance) => {
  monacoInstance.editor.defineTheme("fn-vscode-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6a9955" },
      { token: "keyword", foreground: "569cd6" },
      { token: "number", foreground: "b5cea8" },
      { token: "string", foreground: "ce9178" }
    ],
    colors: {
      "editor.background": "#1e1f22",
      "editor.foreground": "#d4d4d4",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#c9d1d9",
      "editorCursor.foreground": "#f4b860",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#2f3d4a",
      "editorIndentGuide.background1": "#30343a",
      "editorIndentGuide.activeBackground1": "#5d6470"
    }
  });

  monacoInstance.editor.defineTheme("fn-vscode-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5f7f5f" },
      { token: "keyword", foreground: "005cc5" },
      { token: "number", foreground: "0969da" },
      { token: "string", foreground: "a65e2e" }
    ],
    colors: {
      "editor.background": "#fbfcfd",
      "editor.foreground": "#20242a",
      "editorLineNumber.foreground": "#8a94a3",
      "editorLineNumber.activeForeground": "#2d333b",
      "editorCursor.foreground": "#0969da",
      "editor.selectionBackground": "#b7d7ff",
      "editor.inactiveSelectionBackground": "#d8e8fb",
      "editorIndentGuide.background1": "#e1e6ed",
      "editorIndentGuide.activeBackground1": "#aab4c0"
    }
  });
};

export default function CodeEditor({
  filePath,
  language,
  value,
  themeMode,
  fontSize,
  wordWrap,
  onChange,
  onCursorChange,
  onSave,
  onEditorReady
}: CodeEditorProps) {
  const disposablesRef = useRef<monaco.IDisposable[]>([]);

  useEffect(() => {
    return () => {
      for (const disposable of disposablesRef.current) {
        disposable.dispose();
      }
      disposablesRef.current = [];
      onEditorReady(null);
    };
  }, [onEditorReady]);

  const onEditorMount: OnMount = useCallback(
    (editor) => {
      for (const disposable of disposablesRef.current) {
        disposable.dispose();
      }
      disposablesRef.current = [];

      onEditorReady({
        layout: () => editor.layout(),
        getValue: () => editor.getValue()
      });

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSave();
      });

      const position = editor.getPosition();
      if (position) {
        onCursorChange({ line: position.lineNumber, column: position.column });
      }

      disposablesRef.current.push(
        editor.onDidChangeCursorPosition((event) => {
          onCursorChange({ line: event.position.lineNumber, column: event.position.column });
        })
      );
    },
    [onCursorChange, onEditorReady, onSave]
  );

  return (
    <Editor
      beforeMount={beforeMount}
      onMount={onEditorMount}
      theme={themeMode === "dark" ? "fn-vscode-dark" : "fn-vscode-light"}
      language={language}
      path={filePath}
      value={value}
      onChange={onChange}
      options={{
        automaticLayout: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
        fontLigatures: true,
        fontSize,
        lineHeight: Math.round(fontSize * 1.55),
        minimap: { enabled: false },
        padding: { top: 16, bottom: 16 },
        renderLineHighlight: "all",
        roundedSelection: false,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap
      }}
    />
  );
}
