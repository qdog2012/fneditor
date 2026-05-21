import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  Copy,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Settings,
  SplitSquareHorizontal,
  TerminalSquare,
  Trash2,
  X
} from "lucide-react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";

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

type TreeItem = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt: string;
};

type DirectoryState = {
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  items: TreeItem[];
  error?: string;
};

type OpenFile = {
  path: string;
  absolutePath?: string;
  name: string;
  content: string;
  savedContent: string;
  modifiedAt?: string;
  language: string;
  encoding?: string;
  hasBom?: boolean;
};

type Meta = {
  rootLabel: string;
  rootPath: string;
  maxFileBytes: number;
};

type SelectedEntry = {
  path: string;
  type: TreeItem["type"];
};

type SidebarMode = "explorer" | "search" | "settings";
type ThemeMode = "dark" | "light";

type SearchResult = {
  path: string;
  name: string;
  type: TreeItem["type"];
  matchedBy: "name" | "content";
  line?: number;
  preview?: string;
};

type FilePayload = {
  path: string;
  absolutePath?: string;
  name: string;
  content: string;
  modifiedAt: string;
  encoding?: string;
  hasBom?: boolean;
};

type OpenPathPayload = {
  meta: Meta;
  file: FilePayload;
};

type ContextMenuState =
  | {
      kind: "tree";
      x: number;
      y: number;
      item: TreeItem;
    }
  | {
      kind: "tab";
      x: number;
      y: number;
      file: OpenFile;
    }
  | null;

type InputDialogState =
  | {
      kind: "create-file";
      baseDir: string;
      value: string;
    }
  | {
      kind: "create-folder";
      baseDir: string;
      value: string;
    }
  | {
      kind: "rename";
      item: TreeItem;
      value: string;
    }
  | {
      kind: "choose-root";
      value: string;
    }
  | null;

const languageByExtension: Record<string, string> = {
  astro: "html",
  automount: "ini",
  bash: "shell",
  cjs: "javascript",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cnf: "ini",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cxx: "cpp",
  desktop: "ini",
  dockerfile: "dockerfile",
  env: "shell",
  fish: "shell",
  go: "go",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  less: "less",
  link: "ini",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  mount: "ini",
  netdev: "ini",
  network: "ini",
  path: "ini",
  php: "php",
  properties: "ini",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rules: "ini",
  rs: "rust",
  scss: "scss",
  service: "ini",
  sh: "shell",
  slice: "ini",
  socket: "ini",
  sql: "sql",
  scope: "ini",
  svelte: "html",
  target: "ini",
  timer: "ini",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml"
};

const initialDirectories: Record<string, DirectoryState> = {
  "": { expanded: true, loaded: false, loading: false, items: [] }
};

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error || message;
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

function getLanguage(filePath: string) {
  const normalized = filePath.toLowerCase();
  const name = normalized.split("/").pop() || normalized;
  const extension = name.includes(".") ? name.split(".").pop() || "" : name;
  return languageByExtension[extension] || "plaintext";
}

function toOpenFile(payload: FilePayload): OpenFile {
  return {
    path: payload.path,
    absolutePath: payload.absolutePath,
    name: payload.name,
    content: payload.content,
    savedContent: payload.content,
    modifiedAt: payload.modifiedAt,
    language: getLanguage(payload.path),
    encoding: payload.encoding,
    hasBom: payload.hasBom
  };
}

function getParentPath(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function joinPath(base: string, name: string) {
  return [base, name].filter(Boolean).join("/").replaceAll("\\", "/");
}

function normalizeClientPathInput(input: string) {
  return input.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function buildDisplayAbsolutePath(rootPath: string | undefined, relativePath: string) {
  const normalizedRelative = normalizeClientPathInput(relativePath);
  if (!rootPath) {
    return normalizedRelative;
  }
  if (!normalizedRelative) {
    return rootPath;
  }

  const separator = rootPath.includes("\\") ? "\\" : "/";
  const displayRelative = normalizedRelative.replaceAll("/", separator);
  const trimmedRoot =
    rootPath.endsWith("\\") || rootPath.endsWith("/") ? rootPath.slice(0, rootPath.length - 1) : rootPath;

  return `${trimmedRoot}${separator}${displayRelative}`;
}

function resolvePathFromDirectory(input: string, baseDir: string) {
  const isRootRelative = input.trim().replaceAll("\\", "/").startsWith("/");
  const normalized = normalizeClientPathInput(input);
  if (!baseDir || isRootRelative || normalized === baseDir || normalized.startsWith(`${baseDir}/`)) {
    return normalized;
  }

  return joinPath(baseDir, normalized);
}

function getBaseName(filePath: string) {
  return filePath.split("/").filter(Boolean).at(-1) || filePath;
}

function pathIsInside(targetPath: string, parentPath: string) {
  return targetPath === parentPath || targetPath.startsWith(`${parentPath}/`);
}

function getFileIcon(fileName: string) {
  const language = getLanguage(fileName);
  if (["typescript", "javascript", "json", "css", "html"].includes(language)) {
    return <Braces size={15} aria-hidden="true" />;
  }
  if (language === "markdown" || language === "plaintext") {
    return <FileText size={15} aria-hidden="true" />;
  }
  return <FileCode2 size={15} aria-hidden="true" />;
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function App() {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("explorer");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>(initialDirectories);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<SelectedEntry>({ path: "", type: "directory" });
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [fontSize, setFontSize] = useState(() => {
    const storedFontSize = Number.parseInt(window.localStorage.getItem("fneditor.fontSize") ?? "", 10);
    if (!Number.isFinite(storedFontSize)) {
      return 14;
    }
    return Math.min(20, Math.max(12, storedFontSize));
  });
  const [wordWrap, setWordWrap] = useState<"on" | "off">(() =>
    window.localStorage.getItem("fneditor.wordWrap") === "off" ? "off" : "on"
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const storedTheme = window.localStorage.getItem("fneditor.theme");
    return storedTheme === "light" ? "light" : "dark";
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [inputDialog, setInputDialog] = useState<InputDialogState>(null);
  const [isInputDialogBusy, setIsInputDialogBusy] = useState(false);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const inputDialogInputRef = useRef<HTMLInputElement | null>(null);
  const directoriesRef = useRef(directories);
  const openFilesRef = useRef(openFiles);
  const activePathRef = useRef(activePath);
  const saveFileRef = useRef<(pathName?: string) => Promise<void>>(async () => undefined);
  const externalOpenHandledRef = useRef(false);
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    directoriesRef.current = directories;
  }, [directories]);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    window.localStorage.setItem("fneditor.theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem("fneditor.fontSize", String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    window.localStorage.setItem("fneditor.wordWrap", wordWrap);
  }, [wordWrap]);

  useEffect(() => {
    if (!inputDialog) {
      return;
    }

    window.setTimeout(() => {
      inputDialogInputRef.current?.focus();
      inputDialogInputRef.current?.select();
    }, 0);
  }, [inputDialog?.kind]);

  const activeFile = useMemo(
    () => openFiles.find((file) => file.path === activePath) ?? null,
    [activePath, openFiles]
  );

  const activeDisplayPath = useMemo(
    () => (activeFile ? activeFile.absolutePath || buildDisplayAbsolutePath(meta?.rootPath, activeFile.path) : ""),
    [activeFile, meta?.rootPath]
  );

  const dirtyCount = useMemo(
    () => openFiles.filter((file) => file.content !== file.savedContent).length,
    [openFiles]
  );

  const showMessage = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((current) => (current === text ? "" : current)), 3200);
  }, []);

  const loadDirectory = useCallback(
    async (dir: string, options?: { force?: boolean; expand?: boolean }) => {
      const current = directoriesRef.current[dir];
      if (current?.loading) {
        return;
      }

      if (current?.loaded && !options?.force) {
        setDirectories((previous) => ({
          ...previous,
          [dir]: { ...previous[dir], expanded: options?.expand ?? true }
        }));
        return;
      }

      setDirectories((previous) => ({
        ...previous,
        [dir]: {
          expanded: options?.expand ?? previous[dir]?.expanded ?? true,
          loaded: previous[dir]?.loaded ?? false,
          loading: true,
          items: previous[dir]?.items ?? []
        }
      }));

      try {
        const payload = await apiRequest<{ dir: string; items: TreeItem[] }>(
          `/api/tree?dir=${encodeURIComponent(dir)}`
        );
        setDirectories((previous) => ({
          ...previous,
          [dir]: {
            expanded: options?.expand ?? true,
            loaded: true,
            loading: false,
            items: payload.items
          }
        }));
      } catch (error) {
        setDirectories((previous) => ({
          ...previous,
          [dir]: {
            expanded: true,
            loaded: false,
            loading: false,
            items: previous[dir]?.items ?? [],
            error: error instanceof Error ? error.message : "读取目录失败"
          }
        }));
        showMessage(error instanceof Error ? error.message : "读取目录失败");
      }
    },
    [showMessage]
  );

  const resetWorkspace = useCallback(
    async (nextMeta: Meta) => {
      const nextDirectories = { ...initialDirectories };
      directoriesRef.current = nextDirectories;
      setMeta(nextMeta);
      setDirectories(nextDirectories);
      setOpenFiles([]);
      setActivePath("");
      setSelectedEntry({ path: "", type: "directory" });
      setSearchResults([]);
      await loadDirectory("", { force: true, expand: true });
    },
    [loadDirectory]
  );

  useEffect(() => {
    async function boot() {
      try {
        const payload = await apiRequest<Meta>("/api/meta");
        setMeta(payload);
        await loadDirectory("", { force: true, expand: true });
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "初始化失败");
      }
    }

    void boot();
  }, [loadDirectory, showMessage]);

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("click", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
    };
  }, []);

  const refreshDirectory = useCallback(
    async (dir: string) => {
      await loadDirectory(dir, { force: true, expand: true });
    },
    [loadDirectory]
  );

  const toggleDirectory = useCallback(
    async (pathName: string) => {
      const state = directories[pathName];
      setSelectedEntry({ path: pathName, type: "directory" });

      if (state?.expanded) {
        setDirectories((previous) => ({
          ...previous,
          [pathName]: { ...previous[pathName], expanded: false }
        }));
        return;
      }

      await loadDirectory(pathName, { expand: true });
    },
    [directories, loadDirectory]
  );

  const openFile = useCallback(
    async (item: TreeItem | { path: string; name: string }) => {
      setSelectedEntry({ path: item.path, type: "file" });
      const alreadyOpen = openFiles.find((file) => file.path === item.path);
      if (alreadyOpen) {
        if (!alreadyOpen.absolutePath) {
          setOpenFiles((previous) =>
            previous.map((file) =>
              file.path === alreadyOpen.path
                ? { ...file, absolutePath: buildDisplayAbsolutePath(meta?.rootPath, file.path) }
                : file
            )
          );
        }
        setActivePath(alreadyOpen.path);
        return;
      }

      try {
        const payload = await apiRequest<FilePayload>(`/api/file?path=${encodeURIComponent(item.path)}`);
        const file = toOpenFile(payload);
        setOpenFiles((previous) => [...previous, file]);
        setActivePath(file.path);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "打开文件失败");
      }
    },
    [meta?.rootPath, openFiles, showMessage]
  );

  const saveFile = useCallback(
    async (pathName = activePathRef.current) => {
      const file = openFilesRef.current.find((entry) => entry.path === pathName);
      if (!file) {
        return;
      }

      const latestContent =
        pathName === activePathRef.current ? editorRef.current?.getValue() ?? file.content : file.content;

      setIsSaving(true);
      try {
        const payload = await apiRequest<{ path: string; modifiedAt: string; size: number }>("/api/file", {
          method: "PUT",
          body: JSON.stringify({
            path: file.path,
            content: latestContent,
            encoding: file.encoding,
            hasBom: file.hasBom
          })
        });
        setOpenFiles((previous) =>
          previous.map((entry) =>
            entry.path === file.path
              ? {
                  ...entry,
                  content: latestContent,
                  savedContent: latestContent,
                  modifiedAt: payload.modifiedAt
                }
              : entry
          )
        );
        await refreshDirectory(getParentPath(file.path));
        showMessage(`已保存 ${file.name}`);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "保存失败");
      } finally {
        setIsSaving(false);
      }
    },
    [refreshDirectory, showMessage]
  );

  useEffect(() => {
    saveFileRef.current = saveFile;
  }, [saveFile]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFile();
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSidebarMode("search");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveFile]);

  const closeTab = useCallback(
    (pathName: string) => {
      const file = openFiles.find((entry) => entry.path === pathName);
      if (file && file.content !== file.savedContent) {
        const shouldClose = window.confirm(`${file.name} 尚未保存，仍然关闭？`);
        if (!shouldClose) {
          return;
        }
      }

      setOpenFiles((previous) => previous.filter((entry) => entry.path !== pathName));
      if (activePath === pathName) {
        const remaining = openFiles.filter((entry) => entry.path !== pathName);
        setActivePath(remaining.at(-1)?.path ?? "");
      }
    },
    [activePath, openFiles]
  );

  const closeOtherTabs = useCallback((pathName: string) => {
    setOpenFiles((previous) => previous.filter((entry) => entry.path === pathName));
    setActivePath(pathName);
  }, []);

  const closeAllTabs = useCallback(() => {
    const hasDirtyFile = openFiles.some((file) => file.content !== file.savedContent);
    if (hasDirtyFile) {
      const shouldClose = window.confirm("存在未保存文件，仍然关闭全部？");
      if (!shouldClose) {
        return;
      }
    }

    setOpenFiles([]);
    setActivePath("");
  }, [openFiles]);

  const updateActiveContent = useCallback(
    (value?: string) => {
      if (!activeFile) {
        return;
      }

      setOpenFiles((previous) =>
        previous.map((file) => (file.path === activeFile.path ? { ...file, content: value ?? "" } : file))
      );
    },
    [activeFile]
  );

  const currentWorkingDirectory = useMemo(() => {
    if (selectedEntry.type === "directory") {
      return selectedEntry.path;
    }

    if (selectedEntry.path) {
      return getParentPath(selectedEntry.path);
    }

    if (activePath) {
      return getParentPath(activePath);
    }

    return "";
  }, [activePath, selectedEntry]);

  const createFile = useCallback(
    (baseDir = currentWorkingDirectory) => {
      setInputDialog({
        kind: "create-file",
        baseDir,
        value: "untitled.ts"
      });
    },
    [currentWorkingDirectory]
  );

  const createFolder = useCallback(
    (baseDir = currentWorkingDirectory) => {
      setInputDialog({
        kind: "create-folder",
        baseDir,
        value: "新建文件夹"
      });
    },
    [currentWorkingDirectory]
  );

  const copyText = useCallback(
    async (text: string, successText = "已复制") => {
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {
        copied = false;
      }

      if (!copied) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try {
          copied = document.execCommand("copy");
        } catch {
          copied = false;
        } finally {
          document.body.removeChild(textarea);
        }
      }

      if (copied) {
        showMessage(successText);
        return;
      }

      window.prompt("复制路径", text);
    },
    [showMessage]
  );

  const revealPath = useCallback(
    async (pathName: string, type: TreeItem["type"] = "file") => {
      setSidebarMode("explorer");
      await loadDirectory("", { expand: true });

      const parentPath = type === "directory" ? pathName : getParentPath(pathName);
      let current = "";
      for (const segment of parentPath.split("/").filter(Boolean)) {
        current = joinPath(current, segment);
        await loadDirectory(current, { expand: true });
      }

      setSelectedEntry({ path: pathName, type });
      window.setTimeout(() => {
        const selector = `[data-tree-path="${encodeURIComponent(pathName)}"]`;
        const element = document.querySelector<HTMLElement>(selector);
        element?.scrollIntoView({ block: "center" });
        element?.focus({ preventScroll: true });
      }, 50);
    },
    [loadDirectory]
  );

  useEffect(() => {
    if (externalOpenHandledRef.current || !meta) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const externalPath = params.get("open") || params.get("file") || params.get("path");
    externalOpenHandledRef.current = true;

    if (!externalPath) {
      return;
    }

    async function openExternalPath() {
      try {
        const payload = await apiRequest<OpenPathPayload>("/api/open-path", {
          method: "POST",
          body: JSON.stringify({ path: externalPath })
        });
        const file = toOpenFile(payload.file);
        await resetWorkspace(payload.meta);
        setOpenFiles([file]);
        setActivePath(file.path);
        setSelectedEntry({ path: file.path, type: "file" });
        await revealPath(file.path, "file");
        showMessage(`已打开 ${file.name}`);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "打开外部文件失败");
      }
    }

    void openExternalPath();
  }, [meta, resetWorkspace, revealPath, showMessage]);

  const renameEntry = useCallback(
    (item: TreeItem) => {
      setInputDialog({
        kind: "rename",
        item,
        value: item.name
      });
    },
    []
  );

  const updateInputDialogValue = useCallback((value: string) => {
    setInputDialog((current) => (current ? { ...current, value } : current));
  }, []);

  const submitInputDialog = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (!inputDialog || isInputDialogBusy) {
        return;
      }

      const value = inputDialog.value.trim();
      if (!value) {
        showMessage("请输入名称");
        return;
      }

      setIsInputDialogBusy(true);
      try {
        if (inputDialog.kind === "choose-root") {
          const normalized = value.trim();
          if (dirtyCount > 0) {
            const confirmed = window.confirm("切换根目录会关闭当前打开的文件，未保存内容会丢失。继续？");
            if (!confirmed) {
              return;
            }
          }

          searchAbortRef.current?.abort();
          searchAbortRef.current = null;
          setIsSearching(false);
          const payload = await apiRequest<Meta>("/api/root", {
            method: "POST",
            body: JSON.stringify({ path: normalized })
          });
          await resetWorkspace(payload);
          setSidebarMode("explorer");
          setInputDialog(null);
          showMessage(`已切换根目录：${payload.rootPath}`);
          return;
        }

        if (inputDialog.kind === "create-file") {
          const normalized = resolvePathFromDirectory(value, inputDialog.baseDir);
          const parent = getParentPath(normalized);
          const payload = await apiRequest<{ path: string }>("/api/file", {
            method: "POST",
            body: JSON.stringify({ path: normalized, content: "" })
          });
          await refreshDirectory(parent);
          await openFile({ path: payload.path, name: getBaseName(payload.path) });
          setInputDialog(null);
          showMessage(`已创建 ${getBaseName(payload.path)}`);
          return;
        }

        if (inputDialog.kind === "create-folder") {
          const normalized = resolvePathFromDirectory(value, inputDialog.baseDir);
          const parent = getParentPath(normalized);
          const payload = await apiRequest<{ path: string }>("/api/folder", {
            method: "POST",
            body: JSON.stringify({ path: normalized })
          });
          await refreshDirectory(parent);
          await loadDirectory(payload.path, { force: true, expand: true });
          setSelectedEntry({ path: payload.path, type: "directory" });
          setInputDialog(null);
          showMessage(`已创建 ${getBaseName(payload.path)}`);
          return;
        }

        const { item } = inputDialog;
        const parent = getParentPath(item.path);
        const normalizedNextPath = resolvePathFromDirectory(value, parent);
        if (normalizedNextPath === item.path) {
          setInputDialog(null);
          return;
        }

        const payload = await apiRequest<{ path: string; type: TreeItem["type"] }>("/api/path", {
          method: "PATCH",
          body: JSON.stringify({ path: item.path, newPath: normalizedNextPath })
        });
        const oldParent = getParentPath(item.path);
        const newParent = getParentPath(payload.path);
        await refreshDirectory(oldParent);
        if (newParent !== oldParent) {
          await refreshDirectory(newParent);
        }

        setOpenFiles((previous) =>
          previous.map((file) => {
            const affected = item.type === "directory" ? pathIsInside(file.path, item.path) : file.path === item.path;
            if (!affected) {
              return file;
            }

            const nextFilePath =
              item.type === "directory" ? file.path.replace(item.path, payload.path) : payload.path;
            return {
              ...file,
              path: nextFilePath,
              absolutePath: buildDisplayAbsolutePath(meta?.rootPath, nextFilePath),
              name: getBaseName(nextFilePath),
              language: getLanguage(nextFilePath)
            };
          })
        );
        setActivePath((current) => {
          if (!current) {
            return current;
          }
          if (item.type === "directory" && pathIsInside(current, item.path)) {
            return current.replace(item.path, payload.path);
          }
          return current === item.path ? payload.path : current;
        });
        setSelectedEntry({ path: payload.path, type: payload.type });
        setInputDialog(null);
        showMessage(`已重命名为 ${getBaseName(payload.path)}`);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "操作失败");
      } finally {
        setIsInputDialogBusy(false);
      }
    },
    [
      dirtyCount,
      inputDialog,
      isInputDialogBusy,
      loadDirectory,
      meta?.rootPath,
      openFile,
      refreshDirectory,
      resetWorkspace,
      showMessage
    ]
  );

  const deleteEntry = useCallback(
    async (item: TreeItem) => {
      const affectedFiles = openFiles.filter((file) =>
        item.type === "directory" ? pathIsInside(file.path, item.path) : file.path === item.path
      );
      const hasDirtyFile = affectedFiles.some((file) => file.content !== file.savedContent);
      const suffix = hasDirtyFile ? "，其中包含未保存文件" : "";
      const confirmed = window.confirm(`确认删除 ${item.name}${suffix}？`);
      if (!confirmed) {
        return;
      }

      try {
        await apiRequest<{ path: string }>(`/api/path?path=${encodeURIComponent(item.path)}`, {
          method: "DELETE"
        });
        await refreshDirectory(getParentPath(item.path));

        setOpenFiles((previous) => {
          const next = previous.filter((file) =>
            item.type === "directory" ? !pathIsInside(file.path, item.path) : file.path !== item.path
          );
          setActivePath((current) => {
            const currentDeleted =
              item.type === "directory" ? Boolean(current && pathIsInside(current, item.path)) : current === item.path;
            return currentDeleted ? next.at(-1)?.path ?? "" : current;
          });
          return next;
        });
        setSelectedEntry({ path: getParentPath(item.path), type: "directory" });
        showMessage(`已删除 ${item.name}`);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "删除失败");
      }
    },
    [openFiles, refreshDirectory, showMessage]
  );

  const handleSearch = useCallback(async () => {
    const keyword = searchQuery.trim();
    if (!keyword) {
      setSearchResults([]);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchResults([]);
    setIsSearching(true);
    try {
      const payload = await apiRequest<{ items: SearchResult[] }>(
        `/api/search?query=${encodeURIComponent(keyword)}&limit=160`,
        { signal: controller.signal }
      );
      if (searchAbortRef.current !== controller) {
        return;
      }
      setSearchResults(payload.items);
      showMessage(`找到 ${payload.items.length} 个结果`);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (searchAbortRef.current === controller) {
          showMessage("已取消搜索");
        }
        return;
      }
      showMessage(error instanceof Error ? error.message : "搜索失败");
    } finally {
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
        setIsSearching(false);
      }
    }
  }, [searchQuery, showMessage]);

  const cancelSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setIsSearching(false);
    showMessage("已取消搜索");
  }, [showMessage]);

  const chooseRoot = useCallback(() => {
    setInputDialog({
      kind: "choose-root",
      value: meta?.rootPath || ""
    });
  }, [meta?.rootPath]);

  const openTreeContextMenu = useCallback((event: MouseEvent, item: TreeItem) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedEntry({ path: item.path, type: item.type });
    setContextMenu({
      kind: "tree",
      x: event.clientX,
      y: event.clientY,
      item
    });
  }, []);

  const openTabContextMenu = useCallback((event: MouseEvent, file: OpenFile) => {
    event.preventDefault();
    event.stopPropagation();
    setActivePath(file.path);
    setContextMenu({
      kind: "tab",
      x: event.clientX,
      y: event.clientY,
      file
    });
  }, []);

  const beforeMount: BeforeMount = useCallback((monacoInstance) => {
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
  }, []);

  const onEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveFileRef.current();
    });

    const position = editor.getPosition();
    if (position) {
      setCursor({ line: position.lineNumber, column: position.column });
    }

    editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
  }, []);

  const runContextMenuAction = useCallback((action: () => void | Promise<void>) => {
    setContextMenu(null);
    void action();
  }, []);

  const renderDirectory = (dir: string, depth = 0) => {
    const state = directories[dir] ?? { expanded: false, loaded: false, loading: false, items: [] };

    if (state.loading && !state.loaded) {
      return (
        <div className="tree-note" style={{ paddingLeft: 16 + depth * 14 }}>
          正在加载...
        </div>
      );
    }

    if (state.error) {
      return (
        <div className="tree-note is-error" style={{ paddingLeft: 16 + depth * 14 }}>
          {state.error}
        </div>
      );
    }

    if (state.loaded && state.items.length === 0) {
      return (
        <div className="tree-note" style={{ paddingLeft: 16 + depth * 14 }}>
          空文件夹
        </div>
      );
    }

    return state.items.map((item) => {
      const childState = directories[item.path];
      const isDirectory = item.type === "directory";
      const isActive = item.path === activePath;
      const isSelected = selectedEntry.path === item.path;

      return (
        <div key={item.path}>
          <button
            className={`tree-row ${isActive ? "is-active" : ""} ${isSelected ? "is-selected" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            type="button"
            title={item.path}
            data-tree-path={encodeURIComponent(item.path)}
            onClick={() => {
              if (isDirectory) {
                void toggleDirectory(item.path);
              } else {
                void openFile(item);
              }
            }}
            onContextMenu={(event) => openTreeContextMenu(event, item)}
          >
            <span className="tree-chevron">
              {isDirectory ? (
                childState?.expanded ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )
              ) : (
                <span />
              )}
            </span>
            <span className="tree-icon">
              {isDirectory ? (
                childState?.expanded ? (
                  <FolderOpen size={15} aria-hidden="true" />
                ) : (
                  <Folder size={15} aria-hidden="true" />
                )
              ) : (
                getFileIcon(item.name)
              )}
            </span>
            <span className="tree-name">{item.name}</span>
          </button>
          {isDirectory && childState?.expanded ? renderDirectory(item.path, depth + 1) : null}
        </div>
      );
    });
  };

  const renderSidebarContent = () => {
    if (sidebarMode === "search") {
      return (
        <>
          <div className="sidebar-titlebar">
            <span>搜索</span>
            <button
              className="icon-action"
              type="button"
              title={isSearching ? "取消搜索" : "执行搜索"}
              onClick={() => (isSearching ? cancelSearch() : void handleSearch())}
            >
              {isSearching ? <X size={15} aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}
            </button>
          </div>
          <div className="search-panel">
            <label className="field-label" htmlFor="workspace-search">
              当前根目录
            </label>
            <div className="path-hint" title={meta?.rootPath ?? ""}>
              {meta?.rootPath ?? "未连接"}
            </div>
            <div className="search-box">
              <Search size={15} aria-hidden="true" />
              <input
                id="workspace-search"
                value={searchQuery}
                placeholder="搜索文件名或内容"
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleSearch();
                  }
                }}
              />
            </div>
            <button
              className={`primary-action ${isSearching ? "is-cancel" : ""}`}
              type="button"
              onClick={() => (isSearching ? cancelSearch() : void handleSearch())}
            >
              {isSearching ? "取消搜索" : "搜索"}
            </button>
          </div>
          <div className="search-results">
            {isSearching ? (
              <div className="empty-state">正在搜索...</div>
            ) : searchResults.length === 0 ? (
              <div className="empty-state">输入关键词后搜索当前根目录。</div>
            ) : (
              searchResults.map((result) => (
                <button
                  className="search-result"
                  key={`${result.path}-${result.matchedBy}-${result.line ?? 0}`}
                  type="button"
                  title={result.path}
                  onClick={() => {
                    if (result.type === "file") {
                      void openFile({ path: result.path, name: result.name });
                    } else {
                      void revealPath(result.path, "directory");
                    }
                  }}
                >
                  <span className="result-title">
                    {result.type === "directory" ? <Folder size={15} /> : getFileIcon(result.name)}
                    {result.name}
                  </span>
                  <span className="result-path">{result.path}</span>
                  {result.preview ? (
                    <span className="result-preview">
                      {result.line ? `L${result.line}: ` : ""}
                      {result.preview}
                    </span>
                  ) : (
                    <span className="result-preview">{result.matchedBy === "name" ? "路径匹配" : "内容匹配"}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </>
      );
    }

    if (sidebarMode === "settings") {
      return (
        <>
          <div className="sidebar-titlebar">
            <span>设置</span>
          </div>
          <div className="settings-panel">
            <div className="setting-group">
              <label className="field-label" htmlFor="font-size">
                字号 {fontSize}px
              </label>
              <input
                id="font-size"
                min="12"
                max="20"
                step="1"
                type="range"
                value={fontSize}
                onChange={(event) => setFontSize(Number(event.target.value))}
              />
            </div>
            <div className="setting-row">
              <span>主题</span>
              <div className="theme-toggle" role="group" aria-label="主题">
                <button
                  className={`theme-option ${themeMode === "dark" ? "is-active" : ""}`}
                  type="button"
                  onClick={() => setThemeMode("dark")}
                >
                  深色
                </button>
                <button
                  className={`theme-option ${themeMode === "light" ? "is-active" : ""}`}
                  type="button"
                  onClick={() => setThemeMode("light")}
                >
                  浅色
                </button>
              </div>
            </div>
            <div className="setting-row">
              <span>自动换行</span>
              <button
                className={`switch-button ${wordWrap === "on" ? "is-on" : ""}`}
                type="button"
                onClick={() => setWordWrap((current) => (current === "on" ? "off" : "on"))}
              >
                <Check size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      );
    }

    return (
      <>
        <div className="sidebar-titlebar">
          <span>资源管理器</span>
          <div className="sidebar-actions">
            <button type="button" title="新建文件" onClick={() => void createFile()}>
              <FilePlus2 size={15} aria-hidden="true" />
            </button>
            <button type="button" title="新建文件夹" onClick={() => void createFolder()}>
              <FolderPlus size={15} aria-hidden="true" />
            </button>
            <button type="button" title="选择根目录" onClick={() => void chooseRoot()}>
              <FolderOpen size={15} aria-hidden="true" />
            </button>
            <button type="button" title="刷新" onClick={() => void refreshDirectory(currentWorkingDirectory)}>
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        <button
          className="workspace-title"
          type="button"
          onClick={() => void toggleDirectory("")}
          title={meta?.rootPath ?? ""}
        >
          {directories[""]?.expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span>{meta?.rootLabel ?? "我的文件"}</span>
        </button>

        <div className="tree" role="tree" aria-label="我的文件">
          {directories[""]?.expanded ? renderDirectory("") : null}
        </div>
      </>
    );
  };

  const renderContextMenu = () => {
    if (!contextMenu) {
      return null;
    }

    if (contextMenu.kind === "tree") {
      const { item } = contextMenu;
      const baseDir = item.type === "directory" ? item.path : getParentPath(item.path);
      return (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {item.type === "file" ? (
            <button type="button" onClick={() => runContextMenuAction(() => openFile(item))}>
              <FileCode2 size={14} /> 打开
            </button>
          ) : null}
          <button type="button" onClick={() => runContextMenuAction(() => createFile(baseDir))}>
            <FilePlus2 size={14} /> 新建文件
          </button>
          <button type="button" onClick={() => runContextMenuAction(() => createFolder(baseDir))}>
            <FolderPlus size={14} /> 新建文件夹
          </button>
          <span className="context-separator" />
          <button type="button" onClick={() => runContextMenuAction(() => renameEntry(item))}>
            <Pencil size={14} /> 重命名
          </button>
          <button type="button" onClick={() => runContextMenuAction(() => copyText(item.path, "已复制相对路径"))}>
            <Copy size={14} /> 复制相对路径
          </button>
          <button type="button" onClick={() => runContextMenuAction(() => refreshDirectory(baseDir))}>
            <RefreshCw size={14} /> 刷新
          </button>
          <span className="context-separator" />
          <button className="is-danger" type="button" onClick={() => runContextMenuAction(() => deleteEntry(item))}>
            <Trash2 size={14} /> 删除
          </button>
        </div>
      );
    }

    const { file } = contextMenu;
    const isDirty = file.content !== file.savedContent;
    return (
      <div
        className="context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" disabled={!isDirty} onClick={() => runContextMenuAction(() => saveFile(file.path))}>
          <Save size={14} /> 保存
        </button>
        <button type="button" onClick={() => runContextMenuAction(() => closeTab(file.path))}>
          <X size={14} /> 关闭
        </button>
        <button type="button" onClick={() => runContextMenuAction(() => closeOtherTabs(file.path))}>
          <SplitSquareHorizontal size={14} /> 关闭其他
        </button>
        <button type="button" onClick={() => runContextMenuAction(() => closeAllTabs())}>
          <X size={14} /> 关闭全部
        </button>
        <span className="context-separator" />
        <button type="button" onClick={() => runContextMenuAction(() => revealPath(file.path, "file"))}>
          <FolderOpen size={14} /> 在资源管理器中显示
        </button>
        <button type="button" onClick={() => runContextMenuAction(() => copyText(file.path, "已复制相对路径"))}>
          <Copy size={14} /> 复制相对路径
        </button>
      </div>
    );
  };

  const renderInputDialog = () => {
    if (!inputDialog) {
      return null;
    }

    const isRename = inputDialog.kind === "rename";
    const isChooseRoot = inputDialog.kind === "choose-root";
    const title =
      inputDialog.kind === "create-file"
        ? "新建文件"
        : inputDialog.kind === "create-folder"
          ? "新建文件夹"
          : isChooseRoot
            ? "选择根目录"
            : "重命名";
    const label =
      inputDialog.kind === "create-file"
        ? "文件名"
        : inputDialog.kind === "create-folder"
          ? "文件夹名"
          : isChooseRoot
            ? "根目录路径"
            : "新的名称";
    const location =
      isChooseRoot
        ? meta?.rootPath || "未连接"
        : inputDialog.kind === "rename"
        ? getParentPath(inputDialog.item.path) || "根目录"
        : inputDialog.baseDir || "根目录";

    return (
      <div
        className="modal-backdrop"
        role="presentation"
        onMouseDown={() => {
          if (!isInputDialogBusy) {
            setInputDialog(null);
          }
        }}
      >
        <form
          className="input-dialog"
          aria-label={title}
          onSubmit={(event) => void submitInputDialog(event)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="input-dialog-header">
            <span>{title}</span>
            <button
              className="icon-action"
              type="button"
              title="关闭"
              disabled={isInputDialogBusy}
              onClick={() => setInputDialog(null)}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <label className="field-label" htmlFor="file-operation-name">
            {label}
          </label>
          <input
            id="file-operation-name"
            ref={inputDialogInputRef}
            className="text-input"
            value={inputDialog.value}
            disabled={isInputDialogBusy}
            onChange={(event) => updateInputDialogValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !isInputDialogBusy) {
                event.preventDefault();
                setInputDialog(null);
              }
            }}
          />
          <div className="dialog-path-hint" title={location}>
            {isChooseRoot ? "当前：" : "位置："}
            {location}
          </div>
          {isRename ? <div className="dialog-path-hint">原名称：{inputDialog.item.name}</div> : null}
          <div className="input-dialog-actions">
            <button
              className="secondary-action"
              type="button"
              disabled={isInputDialogBusy}
              onClick={() => setInputDialog(null)}
            >
              取消
            </button>
            <button className="primary-action" type="submit" disabled={isInputDialogBusy}>
              {isInputDialogBusy ? "处理中..." : "确定"}
            </button>
          </div>
        </form>
      </div>
    );
  };

  return (
    <div className={`workbench theme-${themeMode}`}>
      <aside className="activity-bar" aria-label="活动栏">
        <button
          className={`activity-button ${sidebarMode === "explorer" ? "is-active" : ""}`}
          type="button"
          title="资源管理器"
          onClick={() => setSidebarMode("explorer")}
        >
          <FileCode2 size={22} aria-hidden="true" />
        </button>
        <button
          className={`activity-button ${sidebarMode === "search" ? "is-active" : ""}`}
          type="button"
          title="搜索"
          onClick={() => setSidebarMode("search")}
        >
          <Search size={22} aria-hidden="true" />
        </button>
        <button
          className={`activity-button push-bottom ${sidebarMode === "settings" ? "is-active" : ""}`}
          type="button"
          title="设置"
          onClick={() => setSidebarMode("settings")}
        >
          <Settings size={22} aria-hidden="true" />
        </button>
      </aside>

      <aside className="sidebar" aria-label="侧栏">{renderSidebarContent()}</aside>

      <main className="editor-shell">
        <header className="top-strip">
          <div className="command-center">
            <button
              className="path-copy-button"
              type="button"
              title="复制绝对路径"
              disabled={!activeDisplayPath}
              onClick={() => activeDisplayPath && void copyText(activeDisplayPath, "已复制绝对路径")}
            >
              <Copy size={14} aria-hidden="true" />
            </button>
            <Code2 size={16} aria-hidden="true" />
            <span title={activeDisplayPath}>{activeDisplayPath || "打开左侧“我的文件”中的代码文件"}</span>
          </div>
          <button
            className="toolbar-button"
            type="button"
            title="保存"
            disabled={!activeFile || isSaving}
            onClick={() => void saveFile()}
          >
            <Save size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="tabbar" role="tablist" aria-label="打开的文件">
          {openFiles.length === 0 ? (
            <div className="empty-tab">
              <SplitSquareHorizontal size={15} aria-hidden="true" />
              <span>未打开文件</span>
            </div>
          ) : (
            openFiles.map((file) => {
              const isDirty = file.content !== file.savedContent;
              return (
                <button
                  key={file.path}
                  className={`tab ${file.path === activePath ? "is-active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={file.path === activePath}
                  onClick={() => setActivePath(file.path)}
                  onContextMenu={(event) => openTabContextMenu(event, file)}
                  title={file.path}
                >
                  {getFileIcon(file.name)}
                  <span>{file.name}</span>
                  {isDirty ? <Circle className="dirty-dot" size={9} aria-label="未保存" /> : null}
                  <span
                    className="tab-close"
                    role="button"
                    tabIndex={0}
                    title="关闭"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(file.path);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTab(file.path);
                      }
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </span>
                </button>
              );
            })
          )}
        </div>

        <section className="editor-area">
          {activeFile ? (
            <Editor
              key={activeFile.path}
              beforeMount={beforeMount}
              onMount={onEditorMount}
              theme={themeMode === "dark" ? "fn-vscode-dark" : "fn-vscode-light"}
              language={activeFile.language}
              path={activeFile.path}
              value={activeFile.content}
              onChange={updateActiveContent}
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
          ) : (
            <div className="welcome">
              <div className="welcome-mark">
                <TerminalSquare size={42} aria-hidden="true" />
              </div>
              <h1>FnCode</h1>
              <p>左侧已连接到当前配置的“我的文件”目录。选择一个文本文件开始编辑。</p>
              <div className="welcome-actions">
                <button type="button" onClick={() => void createFile()}>
                  <FilePlus2 size={16} aria-hidden="true" />
                  新建文件
                </button>
                <button type="button" onClick={() => void chooseRoot()}>
                  <FolderOpen size={16} aria-hidden="true" />
                  选择根目录
                </button>
                <button type="button" onClick={() => void refreshDirectory("")}>
                  <RefreshCw size={16} aria-hidden="true" />
                  刷新列表
                </button>
              </div>
            </div>
          )}
        </section>

        <footer className="statusbar">
          <span>{meta?.rootLabel ?? "我的文件"}</span>
          <span>{activeFile ? activeFile.language : "ready"}</span>
          <span>{activeFile ? formatBytes(new Blob([activeFile.content]).size) : "0 B"}</span>
          <span>
            Ln {cursor.line}, Col {cursor.column}
          </span>
          {dirtyCount > 0 ? <span>{dirtyCount} 个未保存</span> : <span>已同步</span>}
        </footer>
      </main>

      {renderContextMenu()}
      {renderInputDialog()}
      {message ? <div className="toast">{message}</div> : null}
    </div>
  );
}
