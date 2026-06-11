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
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent
} from "react";
import type { CodeEditorHandle } from "./CodeEditor";

const CodeEditor = lazy(() => import("./CodeEditor"));

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
  lineEnding?: "lf" | "crlf" | "cr";
};

type Meta = {
  version: string;
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
  size?: number;
  encoding?: string;
  hasBom?: boolean;
  lineEnding?: "lf" | "crlf" | "cr";
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

const DEFAULT_SIDEBAR_WIDTH = 306;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 560;
const EXTERNAL_OPEN_PARAM_KEYS = ["open", "file", "path", "filepath", "filePath", "absolutePath", "target", "uri"];
const INSTANCE_HEARTBEAT_MS = 1200;
const INSTANCE_TTL_MS = 4500;
const HANDOFF_ACK_TIMEOUT_MS = 1200;
const HANDLED_MESSAGE_TTL_MS = 30000;
const FIRST_FILE_REOPEN_FALLBACK_DELAY_MS = 220;
const INSTANCE_STORAGE_KEY = "fncode.activeInstance";
const INSTANCE_MESSAGE_KEY = "fncode.instanceMessage";
const INSTANCE_CHANNEL_NAME = "fncode.instance";
const LAUNCH_CONTEXT_STORAGE_KEY = "fncode.launchContext";
const WINDOW_LAUNCH_CONTEXT_PREFIX = "fncode-launch:";
const CURRENT_INSTANCE_ID = createInstanceId();

type InstanceRecord = {
  id: string;
  updatedAt: number;
};

type WindowLaunchContext = {
  initialExternalOpenPath: string;
  createdAt: number;
  requestId?: string;
};

type ExternalOpenRole = "deciding" | "primary" | "secondary";

type InstanceMessage =
  | {
      type: "open-file";
      id: string;
      sourceId: string;
      path: string;
      createdAt: number;
    }
  | {
      type: "open-file-ack";
      id: string;
      requestId: string;
      sourceId: string;
      createdAt: number;
    };

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function createInstanceId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseInstanceRecord(value: string | null): InstanceRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<InstanceRecord>;
    if (typeof parsed.id === "string" && typeof parsed.updatedAt === "number") {
      return { id: parsed.id, updatedAt: parsed.updatedAt };
    }
  } catch {
    return null;
  }

  return null;
}

function getFreshInstanceRecord() {
  const record = parseInstanceRecord(window.localStorage.getItem(INSTANCE_STORAGE_KEY));
  if (!record || Date.now() - record.updatedAt > INSTANCE_TTL_MS) {
    return null;
  }

  return record;
}

function writeInstanceRecord(instanceId: string) {
  window.localStorage.setItem(
    INSTANCE_STORAGE_KEY,
    JSON.stringify({
      id: instanceId,
      updatedAt: Date.now()
    } satisfies InstanceRecord)
  );
}

function removeInstanceRecord(instanceId: string) {
  const record = parseInstanceRecord(window.localStorage.getItem(INSTANCE_STORAGE_KEY));
  if (record?.id === instanceId) {
    window.localStorage.removeItem(INSTANCE_STORAGE_KEY);
  }
}

function parseInstanceMessage(value: unknown): InstanceMessage | null {
  const parsedValue = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsedValue || typeof parsedValue !== "object") {
    return null;
  }

  const message = parsedValue as Partial<InstanceMessage>;
  if (
    message.type === "open-file" &&
    typeof message.id === "string" &&
    typeof message.sourceId === "string" &&
    typeof message.path === "string" &&
    typeof message.createdAt === "number"
  ) {
    return message as InstanceMessage;
  }

  if (
    message.type === "open-file-ack" &&
    typeof message.id === "string" &&
    typeof message.requestId === "string" &&
    typeof message.sourceId === "string" &&
    typeof message.createdAt === "number"
  ) {
    return message as InstanceMessage;
  }

  return null;
}

function safeParseInstanceMessage(value: unknown) {
  try {
    return parseInstanceMessage(value);
  } catch {
    return null;
  }
}

function getOpenFileMessageKey(message: Extract<InstanceMessage, { type: "open-file" }>) {
  return `${message.id}:${message.createdAt}`;
}

function postInstanceMessage(message: InstanceMessage) {
  try {
    const channel = new BroadcastChannel(INSTANCE_CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch {
    // localStorage below is the fallback transport.
  }

  window.localStorage.setItem(INSTANCE_MESSAGE_KEY, JSON.stringify(message));
}

function parseWindowLaunchContext(value: string): WindowLaunchContext | null {
  if (!value.startsWith(WINDOW_LAUNCH_CONTEXT_PREFIX)) {
    return null;
  }

  return parseLaunchContextValue(value.slice(WINDOW_LAUNCH_CONTEXT_PREFIX.length));
}

function parseLaunchContextValue(value: string): WindowLaunchContext | null {
  try {
    const parsed = JSON.parse(value) as Partial<WindowLaunchContext>;
    if (
      typeof parsed.initialExternalOpenPath === "string" &&
      typeof parsed.createdAt === "number" &&
      Date.now() - parsed.createdAt <= HANDLED_MESSAGE_TTL_MS
    ) {
      return {
        initialExternalOpenPath: parsed.initialExternalOpenPath,
        createdAt: parsed.createdAt,
        requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined
      };
    }
  } catch {
    return null;
  }

  return null;
}

function readWindowLaunchContext() {
  try {
    return parseWindowLaunchContext(window.name || "");
  } catch {
    return null;
  }
}

function takeStoredLaunchContext() {
  try {
    const context = parseLaunchContextValue(window.localStorage.getItem(LAUNCH_CONTEXT_STORAGE_KEY) || "");
    window.localStorage.removeItem(LAUNCH_CONTEXT_STORAGE_KEY);
    return context;
  } catch {
    return null;
  }
}

function writeWindowLaunchContext(context: WindowLaunchContext) {
  try {
    window.name = `${WINDOW_LAUNCH_CONTEXT_PREFIX}${JSON.stringify(context)}`;
  } catch {
    // The localStorage copy below keeps the neutral redirect fallback available.
  }

  try {
    window.localStorage.setItem(LAUNCH_CONTEXT_STORAGE_KEY, JSON.stringify(context));
  } catch {
    // Losing this only disables the focus fallback if window.name is also unavailable.
  }
}

function closeHandoffWindow() {
  try {
    window.close();
  } catch {
    // Some fnOS windows do not allow script-initiated close.
  }

  try {
    window.open("", "_self")?.close();
  } catch {
    // Best-effort close fallback.
  }

  try {
    const parentWindow = window.parent;
    const frameElement = window.frameElement as HTMLElement | null;
    if (parentWindow && parentWindow !== window && frameElement) {
      const parentDocument = parentWindow.document;
      const closeSelectors = [
        '[aria-label*="关闭"]',
        '[title*="关闭"]',
        '[aria-label*="close" i]',
        '[title*="close" i]',
        '[class*="close" i]',
        '[class*="Close"]'
      ];
      const selectorText = closeSelectors.join(",");

      let current: HTMLElement | null = frameElement;
      for (let depth = 0; current && current !== parentWindow.document.body && depth < 12; depth += 1) {
        for (const selector of closeSelectors) {
          const button = current.querySelector<HTMLElement>(selector);
          if (button && !button.hasAttribute("disabled")) {
            button.click();
            return;
          }
        }
        current = current.parentElement;
      }

      const frameRect = frameElement.getBoundingClientRect();
      const closeCandidates = Array.from(parentDocument.querySelectorAll<HTMLElement>(selectorText));
      for (const candidate of closeCandidates) {
        const candidateRect = candidate.getBoundingClientRect();
        const isVisible = candidateRect.width > 0 && candidateRect.height > 0;
        const isNearFrame =
          candidateRect.right >= frameRect.left - 24 &&
          candidateRect.left <= frameRect.right + 24 &&
          candidateRect.bottom >= frameRect.top - 88 &&
          candidateRect.top <= frameRect.top + 56;
        if (isVisible && isNearFrame && !candidate.hasAttribute("disabled")) {
          candidate.click();
          return;
        }
      }

      const hitPoints = [
        [frameRect.right - 24, frameRect.top - 24],
        [frameRect.right - 20, frameRect.top - 18],
        [frameRect.right - 32, frameRect.top - 22],
        [frameRect.right - 18, Math.max(16, frameRect.top + 12)]
      ];
      for (const [x, y] of hitPoints) {
        const hit = parentDocument.elementFromPoint(x, y);
        let clickable = hit as HTMLElement | null;
        for (let depth = 0; clickable && depth < 5; depth += 1) {
          if (
            clickable.matches?.(
              'button, [role="button"], [aria-label], [title], [class*="close" i], [class*="Close"]'
            )
          ) {
            clickable.click();
            return;
          }
          clickable = clickable.parentElement;
        }
      }
    }
  } catch {
    // Cross-origin direct-port windows cannot close their fnOS parent.
  }
}

function decodeExternalOpenValue(value: string) {
  let decoded = value.trim();

  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded).trim();
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }

  if (decoded.startsWith("file://")) {
    try {
      const pathName = new URL(decoded).pathname;
      return decodeURIComponent(pathName);
    } catch {
      return decoded.replace(/^file:\/+/, "/");
    }
  }

  return decoded;
}

function isAbsoluteExternalPath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizePathForComparison(value: string) {
  return decodeExternalOpenValue(value).replaceAll("\\", "/").replace(/\/+$/, "");
}

function areSameExternalPath(a: string, b: string) {
  const left = normalizePathForComparison(a);
  const right = normalizePathForComparison(b);
  if (/^[A-Za-z]:\//.test(left) || /^[A-Za-z]:\//.test(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function getExternalPathFromParams(params: URLSearchParams) {
  for (const key of EXTERNAL_OPEN_PARAM_KEYS) {
    const value = params.get(key);
    if (!value) {
      continue;
    }

    const decoded = decodeExternalOpenValue(value);
    if (isAbsoluteExternalPath(decoded)) {
      return decoded;
    }
  }

  for (const value of params.values()) {
    const decoded = decodeExternalOpenValue(value);
    if (isAbsoluteExternalPath(decoded)) {
      return decoded;
    }
  }

  return "";
}

function getExternalOpenPathFromLocation(location: Location) {
  const searches = [location.search];
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const hashQueryIndex = hash.indexOf("?");

  if (hash.startsWith("?")) {
    searches.push(hash);
  } else if (hashQueryIndex >= 0) {
    searches.push(hash.slice(hashQueryIndex));
  }

  for (const search of searches) {
    const pathName = getExternalPathFromParams(new URLSearchParams(search));
    if (pathName) {
      return pathName;
    }
  }

  return "";
}

function removeExternalOpenParams(url: URL) {
  let changed = false;
  for (const key of EXTERNAL_OPEN_PARAM_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashQueryIndex = hash.indexOf("?");
  if (hash.startsWith("?") || hashQueryIndex >= 0) {
    const prefix = hash.startsWith("?") ? "" : hash.slice(0, hashQueryIndex);
    const search = hash.startsWith("?") ? hash : hash.slice(hashQueryIndex);
    const params = new URLSearchParams(search);
    let hashChanged = false;

    for (const key of EXTERNAL_OPEN_PARAM_KEYS) {
      if (params.has(key)) {
        params.delete(key);
        hashChanged = true;
      }
    }

    if (hashChanged) {
      const nextSearch = params.toString();
      url.hash = prefix || nextSearch ? `${prefix}${nextSearch ? `?${nextSearch}` : ""}` : "";
      changed = true;
    }
  }

  return changed;
}

function getNeutralEditorUrlFromLocation(location: Location) {
  const url = new URL(location.href);
  removeExternalOpenParams(url);
  return `${url.pathname}${url.search}${url.hash}`;
}

function clearExternalOpenParamsFromLocation() {
  try {
    const url = new URL(window.location.href);
    const changed = removeExternalOpenParams(url);

    if (changed) {
      window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    // Keeping the original URL is harmless; it only affects repeated same-file launches in reused frames.
  }
}

function resolveApiUrl(url: string) {
  if (/^(?:[a-z]+:)?\/\//i.test(url)) {
    return url;
  }

  const relativeUrl = url.startsWith("/") ? url.slice(1) : url;
  const proxyIndex = window.location.pathname.indexOf("/proxy.cgi");
  if (proxyIndex >= 0) {
    return `${window.location.pathname.slice(0, proxyIndex)}/proxy.cgi/${relativeUrl}`;
  }

  return relativeUrl;
}

function postDiagnosticEvent(event: string, data: Record<string, unknown> = {}) {
  if (!INITIAL_EXTERNAL_OPEN_PATH && !INITIAL_FOCUS_FALLBACK_EXTERNAL_OPEN_PATH && event !== "manual-diagnostics") {
    return;
  }

  try {
    const body = JSON.stringify({
      source: "app",
      event,
      data: {
        instanceId: CURRENT_INSTANCE_ID,
        initialExternalOpenPath: INITIAL_EXTERNAL_OPEN_PATH,
        initialFocusFallbackExternalPath: INITIAL_FOCUS_FALLBACK_EXTERNAL_OPEN_PATH,
        href: window.location.href,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        ...data
      }
    });
    const url = resolveApiUrl("/api/diagnostics/events");

    if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) {
      return;
    }

    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true
    }).catch(() => undefined);
  } catch {
    // Diagnostics should never affect editor behavior.
  }
}

async function getDiagnosticEventsText() {
  const response = await fetch(resolveApiUrl("/api/diagnostics/events.txt"), {
    headers: { Accept: "text/plain" }
  });
  if (!response.ok) {
    throw new Error(response.statusText || "Failed to read diagnostics");
  }
  return response.text();
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(url), {
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

async function postServerHandoffRequest(request: Extract<InstanceMessage, { type: "open-file" }>) {
  await apiRequest<{ ok: boolean }>("/api/handoff/open", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

async function acknowledgeServerHandoff(requestId: string) {
  await apiRequest<{ ok: boolean }>("/api/handoff/ack", {
    method: "POST",
    body: JSON.stringify({ id: requestId })
  });
}

async function getServerHandoffStatus(requestId: string) {
  return apiRequest<{ acknowledged: boolean }>(`/api/handoff/status?id=${encodeURIComponent(requestId)}`);
}

async function getPendingServerHandoffs(instanceId: string) {
  return apiRequest<{ items: Array<Extract<InstanceMessage, { type: "open-file" }>> }>(
    `/api/handoff/pending?sourceId=${encodeURIComponent(instanceId)}`
  );
}

function createOpenFileRequest(pathName: string, sourceId: string): Extract<InstanceMessage, { type: "open-file" }> {
  return {
    type: "open-file",
    id: createInstanceId(),
    sourceId,
    path: pathName,
    createdAt: Date.now()
  };
}

async function restartAsNeutralPrimaryWithPendingOpen(pathName: string, sourceId: string) {
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const neutralUrl = getNeutralEditorUrlFromLocation(window.location);
  if (!pathName || neutralUrl === currentUrl) {
    postDiagnosticEvent("restart-neutral-skipped", { pathName, sourceId, currentUrl, neutralUrl });
    return false;
  }

  const request = createOpenFileRequest(pathName, sourceId);
  postDiagnosticEvent("restart-neutral", { pathName, sourceId, currentUrl, neutralUrl, requestId: request.id });
  writeWindowLaunchContext({
    initialExternalOpenPath: pathName,
    createdAt: Date.now(),
    requestId: request.id
  });
  await postServerHandoffRequest(request);
  window.location.replace(neutralUrl);
  return true;
}

async function sendServerInstanceHeartbeat(instanceId: string) {
  await apiRequest<{ ok: boolean }>("/api/instances/heartbeat", {
    method: "POST",
    body: JSON.stringify({ id: instanceId })
  });
}

async function claimServerPrimaryInstance(instanceId: string) {
  return apiRequest<{ active: boolean; id: string; ageMs?: number }>("/api/instances/claim", {
    method: "POST",
    body: JSON.stringify({ id: instanceId })
  });
}

async function getServerPrimaryInstance(instanceId: string) {
  return apiRequest<{ active: boolean; id: string; ageMs?: number }>(
    `/api/instances/primary?sourceId=${encodeURIComponent(instanceId)}`
  );
}

function removeServerInstance(instanceId: string) {
  return fetch(resolveApiUrl(`/api/instances/${encodeURIComponent(instanceId)}`), { method: "DELETE" }).catch(
    () => undefined
  );
}

function releaseServerInstance(instanceId: string) {
  const body = JSON.stringify({ id: instanceId });
  const url = resolveApiUrl("/api/instances/release");

  try {
    navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
  } catch {
    // fetch with keepalive is the fallback below.
  }

  return fetch(url, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body
  }).catch(() => undefined);
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
    hasBom: payload.hasBom,
    lineEnding: payload.lineEnding
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

const INITIAL_STORED_LAUNCH_CONTEXT = takeStoredLaunchContext();
const INITIAL_WINDOW_LAUNCH_CONTEXT = readWindowLaunchContext() || INITIAL_STORED_LAUNCH_CONTEXT;
const INITIAL_EXTERNAL_OPEN_PATH = getExternalOpenPathFromLocation(window.location);
const INITIAL_FOCUS_FALLBACK_EXTERNAL_OPEN_PATH =
  INITIAL_EXTERNAL_OPEN_PATH || INITIAL_WINDOW_LAUNCH_CONTEXT?.initialExternalOpenPath || "";
const INITIAL_EXTERNAL_OPEN_ROLE: ExternalOpenRole = INITIAL_EXTERNAL_OPEN_PATH ? "deciding" : "primary";

export default function App() {
  const initialExternalOpenPath = INITIAL_EXTERNAL_OPEN_PATH;
  const initialFocusFallbackExternalPath = INITIAL_FOCUS_FALLBACK_EXTERNAL_OPEN_PATH;
  const [externalOpenRole, setExternalOpenRole] = useState<ExternalOpenRole>(INITIAL_EXTERNAL_OPEN_ROLE);
  const shouldUseExternalSecondaryMode = externalOpenRole === "secondary";
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(
    () => !initialExternalOpenPath && window.localStorage.getItem("fncode.sidebarVisible") !== "false"
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = Number.parseInt(window.localStorage.getItem("fncode.sidebarWidth") ?? "", 10);
    if (!Number.isFinite(storedWidth)) {
      return DEFAULT_SIDEBAR_WIDTH;
    }
    return clampSidebarWidth(storedWidth);
  });
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
    const storedFontSize = Number.parseInt(window.localStorage.getItem("fncode.fontSize") ?? "", 10);
    if (!Number.isFinite(storedFontSize)) {
      return 14;
    }
    return Math.min(20, Math.max(12, storedFontSize));
  });
  const [wordWrap, setWordWrap] = useState<"on" | "off">(() =>
    window.localStorage.getItem("fncode.wordWrap") === "off" ? "off" : "on"
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const storedTheme = window.localStorage.getItem("fncode.theme");
    return storedTheme === "light" ? "light" : "dark";
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [inputDialog, setInputDialog] = useState<InputDialogState>(null);
  const [isInputDialogBusy, setIsInputDialogBusy] = useState(false);
  const [handoffState, setHandoffState] = useState<"none" | "pending" | "sent">("none");
  const [secondaryOpenStatus, setSecondaryOpenStatus] = useState<"sending" | "opened" | "failed">("sending");
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const inputDialogInputRef = useRef<HTMLInputElement | null>(null);
  const directoriesRef = useRef(directories);
  const openFilesRef = useRef(openFiles);
  const activePathRef = useRef(activePath);
  const saveFileRef = useRef<(pathName?: string) => Promise<void>>(async () => undefined);
  const externalOpenHandledRef = useRef(false);
  const instanceIdRef = useRef(CURRENT_INSTANCE_ID);
  const isPrimaryInstanceRef = useRef(false);
  const handledOpenMessageKeysRef = useRef(new Map<string, number>());
  const sidebarVisibleRef = useRef(sidebarVisible);
  const skipNextSidebarVisiblePersistRef = useRef(Boolean(initialExternalOpenPath));
  const searchAbortRef = useRef<AbortController | null>(null);
  const initialExternalClientPathRef = useRef("");
  const initialExternalAbsolutePathRef = useRef(initialFocusFallbackExternalPath);
  const lastExternalHandoffAtRef = useRef(0);
  const lastWindowBlurAtRef = useRef(0);
  const lastParentPointerAtRef = useRef(0);
  const initialReopenFallbackArmedAtRef = useRef(0);
  const initialReopenFallbackArmedUntilRef = useRef(0);
  const parentSurfaceSignatureRef = useRef("");
  const focusFallbackTimerRef = useRef<number | null>(null);
  const parentActivationFallbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    postDiagnosticEvent("app-role-state", {
      externalOpenRole,
      handoffState,
      activePath,
      openFiles: openFiles.map((file) => ({
        path: file.path,
        absolutePath: file.absolutePath,
        active: file.path === activePath
      })),
      parentFrame: (() => {
        try {
          return Boolean(window.frameElement);
        } catch {
          return false;
        }
      })()
    });
  }, [activePath, externalOpenRole, handoffState, openFiles]);

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
    sidebarVisibleRef.current = sidebarVisible;
  }, [sidebarVisible]);

  useEffect(() => {
    if (!initialExternalOpenPath || externalOpenRole !== "deciding") {
      return;
    }

    let cancelled = false;
    postDiagnosticEvent("decide-primary-start", { initialExternalOpenPath });
    void claimServerPrimaryInstance(instanceIdRef.current)
      .then(async (payload) => {
        if (cancelled) {
          return;
        }
        postDiagnosticEvent("decide-primary-result", {
          active: payload.active,
          primaryId: payload.id,
          ageMs: payload.ageMs
        });
        if (payload.active) {
          setExternalOpenRole("secondary");
          return;
        }

        const restarting = await restartAsNeutralPrimaryWithPendingOpen(
          initialExternalOpenPath,
          instanceIdRef.current
        );
        if (!cancelled && !restarting) {
          setExternalOpenRole("primary");
        }
      })
      .catch((error) => {
        postDiagnosticEvent("decide-primary-failed", {
          message: error instanceof Error ? error.message : String(error)
        });
        if (!cancelled) {
          setExternalOpenRole("primary");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [externalOpenRole, initialExternalOpenPath]);

  useEffect(() => {
    if (handoffState !== "none" || externalOpenRole !== "primary") {
      isPrimaryInstanceRef.current = false;
      return;
    }

    const instanceId = instanceIdRef.current;
    const heartbeat = () => {
      isPrimaryInstanceRef.current = true;
      writeInstanceRecord(instanceId);
      void sendServerInstanceHeartbeat(instanceId).catch(() => undefined);
    };
    const releaseInstance = () => {
      removeInstanceRecord(instanceId);
      void releaseServerInstance(instanceId);
    };

    heartbeat();
    const intervalId = window.setInterval(heartbeat, INSTANCE_HEARTBEAT_MS);
    window.addEventListener("pagehide", releaseInstance);
    window.addEventListener("beforeunload", releaseInstance);

    return () => {
      window.clearInterval(intervalId);
      isPrimaryInstanceRef.current = false;
      window.removeEventListener("pagehide", releaseInstance);
      window.removeEventListener("beforeunload", releaseInstance);
      releaseInstance();
      void removeServerInstance(instanceId);
    };
  }, [externalOpenRole, handoffState]);

  useEffect(() => {
    if (handoffState !== "pending" || !initialExternalOpenPath) {
      return;
    }

    const request: InstanceMessage = {
      type: "open-file",
      id: createInstanceId(),
      sourceId: instanceIdRef.current,
      path: initialExternalOpenPath,
      createdAt: Date.now()
    };
    let acked = false;
    const markAcknowledged = () => {
      if (acked) {
        return;
      }

      acked = true;
      setHandoffState("sent");
      closeHandoffWindow();
      window.setTimeout(closeHandoffWindow, 80);
      window.setTimeout(closeHandoffWindow, 220);
      window.setTimeout(closeHandoffWindow, 600);
    };

    const handleMessage = (message: InstanceMessage | null) => {
      if (
        !message ||
        message.type !== "open-file-ack" ||
        message.requestId !== request.id ||
        message.sourceId === instanceIdRef.current
      ) {
        return;
      }

      markAcknowledged();
    };

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(INSTANCE_CHANNEL_NAME);
      channel.addEventListener("message", (event) => handleMessage(safeParseInstanceMessage(event.data)));
    } catch {
      channel = null;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === INSTANCE_MESSAGE_KEY) {
        handleMessage(safeParseInstanceMessage(event.newValue));
      }
    };

    window.addEventListener("storage", handleStorage);
    postInstanceMessage(request);
    void postServerHandoffRequest(request).catch(() => undefined);

    const pollId = window.setInterval(() => {
      void getServerHandoffStatus(request.id)
        .then((payload) => {
          if (payload.acknowledged) {
            markAcknowledged();
          }
        })
        .catch(() => undefined);
    }, 180);

    const timeoutId = window.setTimeout(() => {
      if (!acked) {
        setHandoffState("none");
      }
    }, HANDOFF_ACK_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(pollId);
      window.removeEventListener("storage", handleStorage);
      channel?.close();
    };
  }, [handoffState, initialExternalOpenPath]);

  useEffect(() => {
    window.localStorage.setItem("fncode.theme", themeMode);
    document.documentElement.dataset.fncodeTheme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem("fncode.fontSize", String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    window.localStorage.setItem("fncode.wordWrap", wordWrap);
  }, [wordWrap]);

  useEffect(() => {
    if (skipNextSidebarVisiblePersistRef.current) {
      skipNextSidebarVisiblePersistRef.current = false;
      window.requestAnimationFrame(() => editorRef.current?.layout());
      return;
    }

    window.localStorage.setItem("fncode.sidebarVisible", String(sidebarVisible));
    window.requestAnimationFrame(() => editorRef.current?.layout());
  }, [sidebarVisible]);

  useEffect(() => {
    window.localStorage.setItem("fncode.sidebarWidth", String(sidebarWidth));
    window.requestAnimationFrame(() => editorRef.current?.layout());
  }, [sidebarWidth]);

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

  const activateSidebarMode = useCallback(
    (mode: SidebarMode) => {
      if (sidebarMode === mode && sidebarVisible) {
        setSidebarVisible(false);
        return;
      }

      setSidebarMode(mode);
      setSidebarVisible(true);
    },
    [sidebarMode, sidebarVisible]
  );

  const hideSidebarForExternalOpen = useCallback(() => {
    if (sidebarVisibleRef.current) {
      skipNextSidebarVisiblePersistRef.current = true;
      setSidebarVisible(false);
    }

    window.requestAnimationFrame(() => editorRef.current?.layout());
  }, []);

  const startSidebarResize = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
        setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
      };

      const stopResize = () => {
        document.body.classList.remove("is-resizing-sidebar");
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", stopResize);
      };

      document.body.classList.add("is-resizing-sidebar");
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", stopResize);
    },
    [sidebarWidth]
  );

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
    async (nextMeta: Meta, options?: { loadExplorerRoot?: boolean }) => {
      const nextDirectories = { ...initialDirectories };
      directoriesRef.current = nextDirectories;
      setMeta(nextMeta);
      setDirectories(nextDirectories);
      setOpenFiles([]);
      setActivePath("");
      setSelectedEntry({ path: "", type: "directory" });
      setSearchResults([]);
      if (options?.loadExplorerRoot !== false) {
        await loadDirectory("", { force: true, expand: true });
      }
    },
    [loadDirectory]
  );

  useEffect(() => {
    if (handoffState !== "none" || externalOpenRole !== "primary") {
      return;
    }

    async function boot() {
      try {
        const payload = await apiRequest<Meta>("/api/meta");
        setMeta(payload);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "初始化失败");
      }
    }

    void boot();
  }, [externalOpenRole, handoffState, showMessage]);

  useEffect(() => {
    if (handoffState !== "none" || externalOpenRole !== "primary" || sidebarMode !== "explorer" || !sidebarVisible) {
      return;
    }

    const rootState = directoriesRef.current[""];
    if (!rootState?.loaded && !rootState?.loading) {
      void loadDirectory("", { expand: true });
    }
  }, [externalOpenRole, handoffState, loadDirectory, sidebarMode, sidebarVisible]);

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

      const editor = editorRef.current;
      const latestContent = editor?.filePath === pathName ? editor.getValue() : file.content;
      if (!file.path || typeof latestContent !== "string") {
        showMessage("保存失败：当前标签缺少路径或内容，请关闭此标签后重新打开文件");
        return;
      }

      setIsSaving(true);
      try {
        const payload = await apiRequest<FilePayload>("/api/file/save", {
          method: "POST",
          body: JSON.stringify({
            path: file.path,
            absolutePath: file.absolutePath,
            content: latestContent,
            encoding: file.encoding,
            hasBom: file.hasBom,
            lineEnding: file.lineEnding
          })
        });
        setOpenFiles((previous) =>
          previous.map((entry) =>
            entry.path === file.path
              ? {
                  ...entry,
                  content: payload.content,
                  savedContent: payload.content,
                  absolutePath: payload.absolutePath || entry.absolutePath,
                  modifiedAt: payload.modifiedAt,
                  encoding: payload.encoding,
                  hasBom: payload.hasBom,
                  lineEnding: payload.lineEnding
                }
              : entry
          )
        );
        try {
          await refreshDirectory(getParentPath(payload.path || file.path));
        } catch {
          // Saving succeeded; refreshing the explorer can fail if the file is outside the current root.
        }
        const savedPath = payload.absolutePath || file.absolutePath || file.name;
        showMessage(`已保存 ${savedPath}`);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "保存失败");
      } finally {
        setIsSaving(false);
      }
    },
    [refreshDirectory, showMessage]
  );

  const reloadFile = useCallback(
    async (pathName: string) => {
      const file = openFilesRef.current.find((entry) => entry.path === pathName);
      if (!file) {
        return;
      }

      const editor = editorRef.current;
      const latestContent = editor?.filePath === pathName ? editor.getValue() : file.content;
      if (latestContent !== file.savedContent) {
        const shouldReload = window.confirm(`${file.name} 尚未保存，重新加载会丢弃当前修改，继续？`);
        if (!shouldReload) {
          return;
        }
      }

      try {
        const payload = await apiRequest<FilePayload>(`/api/file?path=${encodeURIComponent(file.path)}`);
        const reloadedFile = toOpenFile(payload);
        setOpenFiles((previous) =>
          previous.map((entry) =>
            entry.path === file.path
              ? {
                  ...reloadedFile,
                  absolutePath: reloadedFile.absolutePath || entry.absolutePath
                }
              : entry
          )
        );
        setActivePath(reloadedFile.path);
        setSelectedEntry({ path: reloadedFile.path, type: "file" });
        try {
          await refreshDirectory(getParentPath(reloadedFile.path));
        } catch {
          // Reloading succeeded; refreshing the explorer can fail if the file is outside the current root.
        }
        showMessage(`已重新加载 ${reloadedFile.absolutePath || file.absolutePath || reloadedFile.name}`);
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "重新加载失败");
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

  const copyDiagnosticLogs = useCallback(async () => {
    try {
      postDiagnosticEvent("manual-diagnostics", { action: "copy-start" });
      const diagnostics = await getDiagnosticEventsText();
      await copyText(diagnostics || "No diagnostic events", "已复制诊断日志");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "复制诊断日志失败");
    }
  }, [copyText, showMessage]);

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

  const openExternalAbsolutePath = useCallback(
    async (externalPath: string, options?: { revealInExplorer?: boolean }) => {
      const revealInExplorer = options?.revealInExplorer ?? false;
      postDiagnosticEvent("open-external-start", {
        externalPath,
        revealInExplorer,
        activePath: activePathRef.current,
        openFiles: openFilesRef.current.map((file) => ({ path: file.path, absolutePath: file.absolutePath }))
      });
      try {
        const payload = await apiRequest<OpenPathPayload>("/api/open-path", {
          method: "POST",
          body: JSON.stringify({ path: externalPath })
        });
        const file = toOpenFile(payload.file);
        postDiagnosticEvent("open-external-loaded", {
          externalPath,
          filePath: file.path,
          absolutePath: file.absolutePath,
          rootPath: payload.meta.rootPath
        });
        if (
          initialFocusFallbackExternalPath &&
          areSameExternalPath(
            externalPath,
            initialExternalAbsolutePathRef.current || initialFocusFallbackExternalPath
          )
        ) {
          initialExternalClientPathRef.current = file.path;
          initialExternalAbsolutePathRef.current = file.absolutePath || externalPath;
        }
        const rootChanged = !meta || payload.meta.rootPath !== meta.rootPath;

        if (rootChanged) {
          const hasDirtyFile = openFilesRef.current.some((entry) => entry.content !== entry.savedContent);
          if (hasDirtyFile) {
            postDiagnosticEvent("open-external-blocked", { reason: "dirty-root-change", externalPath });
            showMessage("当前有未保存文件，请保存后再从其他根目录打开文件");
            return false;
          }

          await resetWorkspace(payload.meta, { loadExplorerRoot: revealInExplorer });
          setOpenFiles([file]);
        } else {
          setMeta(payload.meta);
          setOpenFiles((previous) => {
            const alreadyOpen = previous.some((entry) => entry.path === file.path);
            if (alreadyOpen) {
              return previous.map((entry) =>
                entry.path === file.path
                  ? {
                      ...entry,
                      absolutePath: file.absolutePath || entry.absolutePath,
                      modifiedAt: file.modifiedAt
                    }
                  : entry
              );
            }

            return [...previous, file];
          });
        }

        setActivePath(file.path);
        setSelectedEntry({ path: file.path, type: "file" });
        if (revealInExplorer) {
          await revealPath(file.path, "file");
        }
        hideSidebarForExternalOpen();
        showMessage(`已打开 ${file.name}`);
        postDiagnosticEvent("open-external-complete", {
          externalPath,
          filePath: file.path,
          absolutePath: file.absolutePath,
          activePath: file.path
        });
        return true;
      } catch (error) {
        postDiagnosticEvent("open-external-failed", {
          externalPath,
          message: error instanceof Error ? error.message : String(error)
        });
        showMessage(error instanceof Error ? error.message : "打开外部文件失败");
        return false;
      }
    },
    [hideSidebarForExternalOpen, initialFocusFallbackExternalPath, meta, resetWorkspace, revealPath, showMessage]
  );

  useEffect(() => {
    if (handoffState !== "none" || externalOpenRole !== "primary") {
      return;
    }

    const handleMessage = (message: InstanceMessage | null) => {
      if (!message) {
        postDiagnosticEvent("handoff-message-ignored", { reason: "empty-or-invalid" });
        return;
      }
      if (message.type !== "open-file") {
        postDiagnosticEvent("handoff-message-ignored", { reason: "not-open-file", type: message.type });
        return;
      }
      if (message.sourceId === instanceIdRef.current) {
        postDiagnosticEvent("handoff-message-ignored", { reason: "same-source", requestId: message.id });
        return;
      }
      if (!isPrimaryInstanceRef.current) {
        postDiagnosticEvent("handoff-message-ignored", { reason: "not-primary", requestId: message.id });
        return;
      }

      postDiagnosticEvent("handoff-message-received", {
        requestId: message.id,
        sourceId: message.sourceId,
        path: message.path,
        activePath: activePathRef.current,
        openFiles: openFilesRef.current.map((file) => ({ path: file.path, absolutePath: file.absolutePath }))
      });
      const now = Date.now();
      for (const [key, handledAt] of handledOpenMessageKeysRef.current) {
        if (now - handledAt > HANDLED_MESSAGE_TTL_MS) {
          handledOpenMessageKeysRef.current.delete(key);
        }
      }

      const messageKey = getOpenFileMessageKey(message);
      if (handledOpenMessageKeysRef.current.has(messageKey)) {
        postDiagnosticEvent("handoff-message-ignored", { reason: "duplicate", requestId: message.id });
        return;
      }

      lastExternalHandoffAtRef.current = now;
      handledOpenMessageKeysRef.current.set(messageKey, now);
      void openExternalAbsolutePath(message.path).then((opened) => {
        postDiagnosticEvent("handoff-message-opened", {
          requestId: message.id,
          path: message.path,
          opened,
          activePath: activePathRef.current
        });
        if (!opened) {
          handledOpenMessageKeysRef.current.delete(messageKey);
          return;
        }

        postInstanceMessage({
          type: "open-file-ack",
          id: createInstanceId(),
          requestId: message.id,
          sourceId: instanceIdRef.current,
          createdAt: Date.now()
        });
        void acknowledgeServerHandoff(message.id).catch(() => undefined);
      });
    };

    let channel: BroadcastChannel | null = null;
    let handoffEvents: EventSource | null = null;
    try {
      channel = new BroadcastChannel(INSTANCE_CHANNEL_NAME);
      channel.addEventListener("message", (event) => handleMessage(safeParseInstanceMessage(event.data)));
    } catch {
      channel = null;
    }

    try {
      handoffEvents = new EventSource(
        resolveApiUrl(`/api/handoff/events?instanceId=${encodeURIComponent(instanceIdRef.current)}`)
      );
      handoffEvents.addEventListener("open-file", (event) => {
        handleMessage(safeParseInstanceMessage((event as MessageEvent).data));
      });
    } catch {
      handoffEvents = null;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === INSTANCE_MESSAGE_KEY) {
        handleMessage(safeParseInstanceMessage(event.newValue));
      }
    };

    const pollPendingHandoffs = () => {
      void getPendingServerHandoffs(instanceIdRef.current)
        .then((payload) => {
          for (const item of payload.items) {
            handleMessage(safeParseInstanceMessage(item));
          }
        })
        .catch(() => undefined);
    };

    window.addEventListener("storage", handleStorage);
    handleMessage(safeParseInstanceMessage(window.localStorage.getItem(INSTANCE_MESSAGE_KEY)));
    pollPendingHandoffs();
    const pendingPollId = window.setInterval(pollPendingHandoffs, 180);

    return () => {
      window.clearInterval(pendingPollId);
      window.removeEventListener("storage", handleStorage);
      channel?.close();
      handoffEvents?.close();
    };
  }, [externalOpenRole, handoffState, openExternalAbsolutePath]);

  useEffect(() => {
    if (!initialFocusFallbackExternalPath || handoffState !== "none" || externalOpenRole !== "primary") {
      return;
    }

    postDiagnosticEvent("focus-fallback-install", {
      initialFocusFallbackExternalPath,
      activePath: activePathRef.current,
      openFiles: openFilesRef.current.map((file) => ({ path: file.path, absolutePath: file.absolutePath }))
    });

    const clearFocusFallbackTimer = () => {
      if (focusFallbackTimerRef.current !== null) {
        window.clearTimeout(focusFallbackTimerRef.current);
        focusFallbackTimerRef.current = null;
      }
    };

    const clearParentActivationFallbackTimer = () => {
      if (parentActivationFallbackTimerRef.current !== null) {
        window.clearTimeout(parentActivationFallbackTimerRef.current);
        parentActivationFallbackTimerRef.current = null;
      }
    };

    const clearFallbackTimers = () => {
      clearFocusFallbackTimer();
      clearParentActivationFallbackTimer();
    };

    const isInitialReopenFallbackArmed = () => Date.now() <= initialReopenFallbackArmedUntilRef.current;

    const armInitialReopenFallback = (reason: string, durationMs = 2400) => {
      const armedAt = Date.now();
      initialReopenFallbackArmedAtRef.current = armedAt;
      initialReopenFallbackArmedUntilRef.current = armedAt + durationMs;
      postDiagnosticEvent("focus-fallback-armed", {
        reason,
        durationMs,
        targetPath: initialExternalAbsolutePathRef.current || initialFocusFallbackExternalPath,
        activePath: activePathRef.current
      });
    };

    const disarmInitialReopenFallback = (reason: string) => {
      if (!initialReopenFallbackArmedUntilRef.current && focusFallbackTimerRef.current === null) {
        return;
      }
      initialReopenFallbackArmedAtRef.current = 0;
      initialReopenFallbackArmedUntilRef.current = 0;
      clearFallbackTimers();
      postDiagnosticEvent("focus-fallback-disarmed", {
        reason,
        activePath: activePathRef.current
      });
    };

    let lastKnownFocused = document.hasFocus();

    const markBlur = (reason = "blur") => {
      lastKnownFocused = false;
      lastWindowBlurAtRef.current = Date.now();
      clearFocusFallbackTimer();
      postDiagnosticEvent("focus-fallback-blur", {
        reason,
        activePath: activePathRef.current,
        documentHasFocus: document.hasFocus(),
        visibilityState: document.visibilityState
      });
    };

    const scheduleInitialFileFocusFallback = (
      reason = "focus",
      options?: { delayMs?: number; handoffCancelAfterMs?: number; minBlurAgeMs?: number; requireBlur?: boolean }
    ) => {
      lastKnownFocused = true;
      const delayMs = options?.delayMs ?? 450;
      const minBlurAgeMs = options?.minBlurAgeMs ?? 200;
      const requireBlur = options?.requireBlur ?? true;
      if ((activePathRef.current || initialExternalClientPathRef.current) && !isInitialReopenFallbackArmed()) {
        postDiagnosticEvent("focus-fallback-skip", {
          reason,
          skip: "not-armed",
          activePath: activePathRef.current
        });
        return;
      }

      const blurredAt = lastWindowBlurAtRef.current;
      if (!blurredAt || document.visibilityState === "hidden") {
        const canContinueWithoutIframeBlur = !blurredAt && !requireBlur && document.visibilityState !== "hidden";
        if (!canContinueWithoutIframeBlur) {
          postDiagnosticEvent("focus-fallback-skip", {
            reason,
            skip: !blurredAt ? "no-blur-recorded" : "document-hidden",
            activePath: activePathRef.current
          });
          return;
        }
      }

      const blurAge = blurredAt ? Date.now() - blurredAt : Number.POSITIVE_INFINITY;
      if ((blurredAt && blurAge < minBlurAgeMs) || blurAge > 30000) {
        postDiagnosticEvent("focus-fallback-skip", {
          reason,
          skip: "blur-age-out-of-range",
          blurAge,
          minBlurAgeMs,
          activePath: activePathRef.current
        });
        return;
      }

      clearFocusFallbackTimer();
      postDiagnosticEvent("focus-fallback-scheduled", {
        reason,
        blurAge,
        targetPath: initialExternalAbsolutePathRef.current || initialFocusFallbackExternalPath,
        activePath: activePathRef.current
      });
      focusFallbackTimerRef.current = window.setTimeout(() => {
        focusFallbackTimerRef.current = null;
        const handoffAge = Date.now() - lastExternalHandoffAtRef.current;
        const hasBlockingHandoff =
          typeof options?.handoffCancelAfterMs === "number"
            ? lastExternalHandoffAtRef.current >= options.handoffCancelAfterMs
            : handoffAge < 1200;
        if (hasBlockingHandoff) {
          postDiagnosticEvent("focus-fallback-cancelled", {
            reason,
            cancelled: "recent-handoff",
            handoffAge,
            handoffCancelAfterMs: options?.handoffCancelAfterMs
          });
          disarmInitialReopenFallback("recent-handoff");
          return;
        }

        const initialClientPath = initialExternalClientPathRef.current;
        if (initialClientPath && activePathRef.current === initialClientPath) {
          postDiagnosticEvent("focus-fallback-cancelled", {
            reason,
            cancelled: "already-active",
            initialClientPath,
            activePath: activePathRef.current
          });
          disarmInitialReopenFallback("already-active");
          return;
        }

        disarmInitialReopenFallback("opening-initial-file");
        postDiagnosticEvent("focus-fallback-open", {
          reason,
          targetPath: initialExternalAbsolutePathRef.current || initialFocusFallbackExternalPath,
          activePath: activePathRef.current,
          initialClientPath
        });
        void openExternalAbsolutePath(initialExternalAbsolutePathRef.current || initialFocusFallbackExternalPath);
      }, delayMs);
    };

    const pollFocusState = () => {
      const isFocused = document.hasFocus();
      if (!isFocused) {
        if (lastKnownFocused || !lastWindowBlurAtRef.current) {
          markBlur("document-focus-poll");
        }
        return;
      }

      if (!lastKnownFocused) {
        scheduleInitialFileFocusFallback("document-focus-poll");
      }
    };

    const getParentFrameElement = () => {
      try {
        return window.frameElement as HTMLElement | null;
      } catch {
        return null;
      }
    };

    const isParentFrameFocused = () => {
      const frameElement = getParentFrameElement();
      if (!frameElement) {
        return document.hasFocus();
      }

      try {
        return frameElement.ownerDocument.activeElement === frameElement;
      } catch {
        return false;
      }
    };

    const readClassName = (element: Element) => {
      if (typeof element.className === "string") {
        return element.className;
      }
      return element.getAttribute("class") || "";
    };

    const readParentElementSummary = (element: HTMLElement | null) => {
      if (!element || typeof element.getBoundingClientRect !== "function") {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      return {
        tag: element.tagName,
        id: element.id,
        className: readClassName(element).slice(0, 220),
        role: element.getAttribute("role") || "",
        title: element.getAttribute("title") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        dataState: element.getAttribute("data-state") || "",
        dataActive: element.getAttribute("data-active") || "",
        style: element.style.cssText.slice(0, 220),
        display: style?.display || "",
        visibility: style?.visibility || "",
        opacity: style?.opacity || "",
        zIndex: style?.zIndex || "",
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    };

    const readParentFrameSnapshot = () => {
      const frameElement = getParentFrameElement();
      if (!frameElement) {
        return { frame: null, ancestors: [] };
      }

      const ancestors = [];
      let element: HTMLElement | null = frameElement;
      for (let depth = 0; element && element !== frameElement.ownerDocument.body && depth < 8; depth += 1) {
        ancestors.push(readParentElementSummary(element));
        element = element.parentElement;
      }
      return { frame: readParentElementSummary(frameElement), ancestors };
    };

    const readParentActiveElementSummary = () => {
      const frameElement = getParentFrameElement();
      if (!frameElement) {
        return null;
      }

      return readParentElementSummary(frameElement.ownerDocument.activeElement as HTMLElement | null);
    };

    const parentEventTargetMatchesInitialFile = (target: EventTarget | null) => {
      const initialFileName = getBaseName(initialExternalAbsolutePathRef.current || initialFocusFallbackExternalPath);
      if (
        !initialFileName ||
        !target ||
        typeof (target as Element).getAttribute !== "function" ||
        !("parentElement" in (target as Element))
      ) {
        return false;
      }

      let element: Element | null = target as Element;
      for (let depth = 0; element && depth < 7; depth += 1) {
        const candidates = [
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("data-name"),
          element.getAttribute("data-file-name"),
          element.textContent?.trim().slice(0, 300)
        ].filter((value): value is string => Boolean(value));

        if (candidates.some((value) => value === initialFileName || value.includes(initialFileName))) {
          return true;
        }

        element = element.parentElement;
      }

      return false;
    };

    const readParentSurfaceSignature = () => {
      const frameElement = getParentFrameElement();
      if (!frameElement) {
        return "";
      }

      const parentDocument = frameElement.ownerDocument;
      const parentWindow = parentDocument.defaultView;
      const parts: string[] = [];
      let element: HTMLElement | null = frameElement;

      for (let depth = 0; element && element !== parentDocument.body && depth < 8; depth += 1) {
        const rect = element.getBoundingClientRect();
        const style = parentWindow?.getComputedStyle(element);
        const parent = element.parentElement;
        const zIndexes =
          depth === 0 && parent
            ? Array.from(parent.children)
                .slice(0, 80)
                .map((child) => {
                  const childElement = child as HTMLElement;
                  const childStyle = parentWindow?.getComputedStyle(childElement);
                  return childStyle?.zIndex || childElement.style.zIndex || "";
                })
                .join(",")
            : "";

        parts.push(
          [
            element.tagName,
            element.id,
            readClassName(element).slice(0, 160),
            element.getAttribute("aria-hidden") || "",
            element.getAttribute("data-state") || "",
            element.getAttribute("data-active") || "",
            element.style.cssText.slice(0, 180),
            style?.display || "",
            style?.visibility || "",
            style?.opacity || "",
            style?.zIndex || "",
            Math.round(rect.left),
            Math.round(rect.top),
            Math.round(rect.width),
            Math.round(rect.height),
            zIndexes
          ].join("\u001f")
        );

        element = element.parentElement;
      }

      return parts.join("\u001e");
    };

    const isParentSurfaceRendered = () => {
      const frameElement = getParentFrameElement();
      if (!frameElement) {
        return true;
      }

      const parentDocument = frameElement.ownerDocument;
      const parentWindow = parentDocument.defaultView;
      let element: HTMLElement | null = frameElement;

      for (let depth = 0; element && element !== parentDocument.body && depth < 8; depth += 1) {
        const style = parentWindow?.getComputedStyle(element);
        if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") {
          return false;
        }
        element = element.parentElement;
      }

      const rect = frameElement.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };

    const scheduleFallbackFromParentActivation = (event: Event) => {
      if (event.type !== "dblclick") {
        return;
      }
      if (!parentEventTargetMatchesInitialFile(event.target)) {
        postDiagnosticEvent("parent-activation-fallback-skip", {
          reason: "target-mismatch",
          eventType: event.type,
          target: readParentElementSummary(event.target as HTMLElement | null)
        });
        return;
      }
      if (!isParentSurfaceRendered()) {
        postDiagnosticEvent("parent-activation-fallback-skip", { reason: "surface-hidden", eventType: event.type });
        return;
      }

      clearParentActivationFallbackTimer();
      armInitialReopenFallback("parent-dblclick");
      const scheduledAt = Date.now();
      postDiagnosticEvent("parent-activation-fallback-scheduled", {
        eventType: event.type,
        delayMs: FIRST_FILE_REOPEN_FALLBACK_DELAY_MS,
        targetPath: initialExternalAbsolutePathRef.current || initialFocusFallbackExternalPath,
        activePath: activePathRef.current
      });
      parentActivationFallbackTimerRef.current = window.setTimeout(() => {
        parentActivationFallbackTimerRef.current = null;
        if (lastExternalHandoffAtRef.current >= scheduledAt) {
          postDiagnosticEvent("parent-activation-fallback-cancelled", {
            reason: "recent-handoff",
            handoffAge: Date.now() - lastExternalHandoffAtRef.current,
            scheduledAt
          });
          disarmInitialReopenFallback("recent-handoff");
          return;
        }

        const initialClientPath = initialExternalClientPathRef.current;
        const alreadyOpen = initialClientPath
          ? openFilesRef.current.some((file) => file.path === initialClientPath)
          : false;
        if (alreadyOpen && activePathRef.current !== initialClientPath) {
          setActivePath(initialClientPath);
          setSelectedEntry({ path: initialClientPath, type: "file" });
          postDiagnosticEvent("parent-activation-fast-tab-switch", {
            initialClientPath,
            previousActivePath: activePathRef.current
          });
        }

        scheduleInitialFileFocusFallback("parent-dblclick", {
          delayMs: 0,
          handoffCancelAfterMs: scheduledAt,
          minBlurAgeMs: 0,
          requireBlur: false
        });
      }, FIRST_FILE_REOPEN_FALLBACK_DELAY_MS);
    };

    const scheduleFallbackFromParentSurface = () => {
      if (!isInitialReopenFallbackArmed()) {
        postDiagnosticEvent("parent-surface-fallback-skip", { reason: "not-armed" });
        return;
      }
      if (!initialExternalClientPathRef.current && !initialExternalAbsolutePathRef.current) {
        postDiagnosticEvent("parent-surface-fallback-skip", { reason: "no-initial-path" });
        return;
      }
      if (Date.now() - lastExternalHandoffAtRef.current < 1200) {
        postDiagnosticEvent("parent-surface-fallback-skip", {
          reason: "recent-handoff",
          handoffAge: Date.now() - lastExternalHandoffAtRef.current
        });
        return;
      }
      if (Date.now() - lastParentPointerAtRef.current > 2500) {
        postDiagnosticEvent("parent-surface-fallback-skip", {
          reason: "no-recent-parent-pointer",
          pointerAge: Date.now() - lastParentPointerAtRef.current
        });
        return;
      }
      if (!isParentSurfaceRendered()) {
        postDiagnosticEvent("parent-surface-fallback-skip", { reason: "surface-hidden" });
        return;
      }

      const delay = Date.now() - lastWindowBlurAtRef.current < 220 ? 260 : 0;
      postDiagnosticEvent("parent-surface-fallback-scheduled", { delay });
      window.setTimeout(
        () =>
          scheduleInitialFileFocusFallback("parent-surface", {
            handoffCancelAfterMs: initialReopenFallbackArmedAtRef.current,
            minBlurAgeMs: 0,
            requireBlur: false
          }),
        delay
      );
    };

    const pollParentSurfaceState = () => {
      const nextSignature = readParentSurfaceSignature();
      const previousSignature = parentSurfaceSignatureRef.current;
      if (!nextSignature) {
        return;
      }

      if (!previousSignature) {
        parentSurfaceSignatureRef.current = nextSignature;
        postDiagnosticEvent("parent-surface-initial", {
          activeElement: readParentActiveElementSummary(),
          snapshot: readParentFrameSnapshot()
        });
        return;
      }

      if (nextSignature !== previousSignature) {
        parentSurfaceSignatureRef.current = nextSignature;
        postDiagnosticEvent("parent-surface-change", {
          activeElement: readParentActiveElementSummary(),
          snapshot: readParentFrameSnapshot()
        });
        scheduleFallbackFromParentSurface();
      }
    };

    let lastKnownParentFrameFocused = isParentFrameFocused();

    const pollParentFrameFocusState = () => {
      const isFocused = isParentFrameFocused();
      if (!isFocused) {
        if (lastKnownParentFrameFocused || !lastWindowBlurAtRef.current) {
          markBlur("parent-frame-focus-poll");
        }
        lastKnownParentFrameFocused = false;
        return;
      }

      if (!lastKnownParentFrameFocused) {
        lastKnownParentFrameFocused = true;
        postDiagnosticEvent("parent-frame-focused", { activeElement: readParentActiveElementSummary() });
        scheduleInitialFileFocusFallback("parent-frame-focus-poll");
      }
    };

    const handleParentFocusIn = () => {
      postDiagnosticEvent("parent-focusin", { activeElement: readParentActiveElementSummary() });
      window.setTimeout(pollParentFrameFocusState, 0);
      window.setTimeout(pollParentFrameFocusState, 180);
    };

    const handleParentPointer = (event: Event) => {
      const frameElement = getParentFrameElement();
      try {
        const target = event.target as Node | null;
        if (frameElement && target && (target === frameElement || frameElement.contains(target))) {
          return;
        }
      } catch {
        // Treat unknown parent events as outside the editor frame.
      }

      const now = Date.now();
      lastParentPointerAtRef.current = now;
      lastWindowBlurAtRef.current = now;
      clearFocusFallbackTimer();
      const targetElement =
        event.target && typeof (event.target as HTMLElement).getBoundingClientRect === "function"
          ? (event.target as HTMLElement)
          : null;
      postDiagnosticEvent("parent-pointer", {
        eventType: event.type,
        target: readParentElementSummary(targetElement),
        activeElement: readParentActiveElementSummary()
      });
      scheduleFallbackFromParentActivation(event);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        markBlur("visibility-hidden");
        return;
      }
      scheduleInitialFileFocusFallback("visibility-visible");
    };

    const handleEditorInteraction = (event: Event) => {
      if (!isInitialReopenFallbackArmed() && focusFallbackTimerRef.current === null) {
        return;
      }
      lastParentPointerAtRef.current = 0;
      disarmInitialReopenFallback(`editor-${event.type}`);
    };

    const handleWindowBlur = () => markBlur("window-blur");
    const handleWindowFocus = () => scheduleInitialFileFocusFallback("window-focus");
    const handlePageShow = () => scheduleInitialFileFocusFallback("pageshow");

    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("pointerdown", handleEditorInteraction, true);
    document.addEventListener("keydown", handleEditorInteraction, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const focusPollId = window.setInterval(pollFocusState, 500);
    const parentFrameFocusPollId = window.setInterval(pollParentFrameFocusState, 220);
    const parentSurfacePollId = window.setInterval(pollParentSurfaceState, 300);
    let parentDocument: Document | null = null;
    let parentSurfaceObserver: MutationObserver | null = null;

    try {
      const frameElement = getParentFrameElement();
      if (frameElement) {
        parentDocument = frameElement.ownerDocument;
        postDiagnosticEvent("parent-monitor-attached", {
          activeElement: readParentActiveElementSummary(),
          snapshot: readParentFrameSnapshot()
        });
        parentDocument.addEventListener("focusin", handleParentFocusIn, true);
        parentDocument.addEventListener("pointerdown", handleParentPointer, true);
        parentDocument.addEventListener("dblclick", handleParentPointer, true);
        parentSurfaceObserver = new MutationObserver(pollParentSurfaceState);

        let element: HTMLElement | null = frameElement;
        for (let depth = 0; element && element !== parentDocument.body && depth < 8; depth += 1) {
          parentSurfaceObserver.observe(element, {
            attributes: true,
            attributeFilter: ["class", "style", "aria-hidden", "data-state", "data-active"]
          });
          element = element.parentElement;
        }
      } else {
        postDiagnosticEvent("parent-monitor-unavailable", { reason: "no-frame-element" });
      }
    } catch (error) {
      postDiagnosticEvent("parent-monitor-unavailable", {
        reason: "exception",
        message: error instanceof Error ? error.message : String(error)
      });
      parentDocument = null;
      parentSurfaceObserver = null;
    }
    pollParentFrameFocusState();
    pollParentSurfaceState();

    return () => {
      clearFocusFallbackTimer();
      clearParentActivationFallbackTimer();
      window.clearInterval(focusPollId);
      window.clearInterval(parentFrameFocusPollId);
      window.clearInterval(parentSurfacePollId);
      parentSurfaceObserver?.disconnect();
      parentDocument?.removeEventListener("focusin", handleParentFocusIn, true);
      parentDocument?.removeEventListener("pointerdown", handleParentPointer, true);
      parentDocument?.removeEventListener("dblclick", handleParentPointer, true);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("pointerdown", handleEditorInteraction, true);
      document.removeEventListener("keydown", handleEditorInteraction, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [externalOpenRole, handoffState, initialFocusFallbackExternalPath, openExternalAbsolutePath]);

  useEffect(() => {
    if (!shouldUseExternalSecondaryMode || externalOpenHandledRef.current) {
      return;
    }

    const externalPath = initialExternalOpenPath || getExternalOpenPathFromLocation(window.location);
    externalOpenHandledRef.current = true;

    if (!externalPath) {
      postDiagnosticEvent("secondary-open-failed", { reason: "no-external-path" });
      setSecondaryOpenStatus("failed");
      return;
    }
    clearExternalOpenParamsFromLocation();

    const request = createOpenFileRequest(externalPath, instanceIdRef.current);
    postDiagnosticEvent("secondary-open-start", { externalPath, requestId: request.id });

    let completed = false;
    let checkingPrimary = false;
    const completeAndClose = () => {
      if (completed) {
        return;
      }
      completed = true;
      setSecondaryOpenStatus("opened");
      postDiagnosticEvent("secondary-open-acked", { requestId: request.id });
      closeHandoffWindow();
      window.setTimeout(closeHandoffWindow, 80);
      window.setTimeout(closeHandoffWindow, 220);
      window.setTimeout(closeHandoffWindow, 700);
    };

    const promoteToPrimary = () => {
      if (completed) {
        return;
      }

      completed = true;
      externalOpenHandledRef.current = false;
      postDiagnosticEvent("secondary-promote-primary", { requestId: request.id, externalPath });
      setExternalOpenRole("primary");
    };

    const pollStatus = () => {
      void getServerHandoffStatus(request.id)
        .then((payload) => {
          if (payload.acknowledged) {
            completeAndClose();
          }
        })
        .catch(() => undefined);
    };

    const promoteOnlyWhenNoPrimaryExists = () => {
      if (completed || checkingPrimary) {
        return;
      }

      checkingPrimary = true;
      void getServerPrimaryInstance(instanceIdRef.current)
        .then(async (primary) => {
          postDiagnosticEvent("secondary-primary-check", {
            requestId: request.id,
            active: primary.active,
            primaryId: primary.id,
            ageMs: primary.ageMs
          });
          if (completed || primary.active) {
            return;
          }

          const claim = await claimServerPrimaryInstance(instanceIdRef.current);
          postDiagnosticEvent("secondary-primary-claim", {
            requestId: request.id,
            active: claim.active,
            primaryId: claim.id,
            ageMs: claim.ageMs
          });
          if (!completed && !claim.active) {
            promoteToPrimary();
          }
        })
        .catch((error) => {
          postDiagnosticEvent("secondary-primary-check-failed", {
            requestId: request.id,
            message: error instanceof Error ? error.message : String(error)
          });
          if (!completed) {
            setSecondaryOpenStatus("failed");
          }
        })
        .finally(() => {
          checkingPrimary = false;
        });
    };

    postInstanceMessage(request);
    void postServerHandoffRequest(request).catch(() => undefined);
    pollStatus();
    const pollId = window.setInterval(pollStatus, 200);
    const primaryCheckTimeoutId = window.setTimeout(promoteOnlyWhenNoPrimaryExists, HANDOFF_ACK_TIMEOUT_MS);
    const primaryCheckIntervalId = window.setInterval(promoteOnlyWhenNoPrimaryExists, HANDOFF_ACK_TIMEOUT_MS);

    return () => {
      window.clearInterval(pollId);
      window.clearTimeout(primaryCheckTimeoutId);
      window.clearInterval(primaryCheckIntervalId);
    };
  }, [initialExternalOpenPath, shouldUseExternalSecondaryMode]);

  useEffect(() => {
    if (handoffState !== "none" || externalOpenRole !== "primary" || externalOpenHandledRef.current || !meta) {
      return;
    }

    const externalPath = initialExternalOpenPath || getExternalOpenPathFromLocation(window.location);
    externalOpenHandledRef.current = true;

    if (!externalPath) {
      postDiagnosticEvent("primary-initial-open-skipped", { reason: "no-external-path" });
      return;
    }

    postDiagnosticEvent("primary-initial-open-start", { externalPath });
    void openExternalAbsolutePath(externalPath).then((opened) => {
      postDiagnosticEvent("primary-initial-open-complete", { externalPath, opened });
      if (opened) {
        clearExternalOpenParamsFromLocation();
      }
    });
  }, [externalOpenRole, handoffState, initialExternalOpenPath, meta, openExternalAbsolutePath]);

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

  const onEditorReady = useCallback((editor: CodeEditorHandle | null) => {
    editorRef.current = editor;
  }, []);

  const handleEditorCursorChange = useCallback((nextCursor: { line: number; column: number }) => {
    setCursor(nextCursor);
  }, []);

  const handleEditorSave = useCallback(() => {
    void saveFileRef.current();
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
            <div className="setting-row">
              <span>版本</span>
              <span className="setting-value">FnEditor {meta?.version ?? "unknown"}</span>
            </div>
            <button className="secondary-action" type="button" onClick={() => void copyDiagnosticLogs()}>
              <Copy size={14} aria-hidden="true" />
              复制诊断日志
            </button>
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
        <button type="button" onClick={() => runContextMenuAction(() => reloadFile(file.path))}>
          <RefreshCw size={14} /> 重新加载文件
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

  if (externalOpenRole === "deciding") {
    return (
      <div className={`handoff-screen theme-${themeMode}`}>
        <div className="handoff-message">正在打开文件...</div>
      </div>
    );
  }

  if (shouldUseExternalSecondaryMode) {
    const text =
      secondaryOpenStatus === "opened"
        ? "已在已打开的 FnEditor 窗口中新建标签，可关闭此窗口。"
        : secondaryOpenStatus === "failed"
          ? "已发送到已打开的 FnEditor 窗口。若没有自动关闭，可手动关闭此窗口。"
          : "正在发送到已打开的 FnEditor 窗口...";
    return (
      <div className={`handoff-screen theme-${themeMode}`}>
        <div className="handoff-message">{text}</div>
      </div>
    );
  }

  if (handoffState !== "none") {
    return (
      <div className={`handoff-screen theme-${themeMode}`}>
        <div className="handoff-message">正在加入已打开的 FnEditor 窗口...</div>
      </div>
    );
  }

  return (
    <div
      className={`workbench theme-${themeMode} ${sidebarVisible ? "" : "is-sidebar-hidden"}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="activity-bar" aria-label="活动栏">
        <button
          className={`activity-button ${sidebarMode === "explorer" && sidebarVisible ? "is-active" : ""}`}
          type="button"
          title="资源管理器"
          aria-pressed={sidebarMode === "explorer" && sidebarVisible}
          onClick={() => activateSidebarMode("explorer")}
        >
          <FileCode2 size={22} aria-hidden="true" />
        </button>
        <button
          className={`activity-button ${sidebarMode === "search" && sidebarVisible ? "is-active" : ""}`}
          type="button"
          title="搜索"
          aria-pressed={sidebarMode === "search" && sidebarVisible}
          onClick={() => activateSidebarMode("search")}
        >
          <Search size={22} aria-hidden="true" />
        </button>
        <button
          className={`activity-button push-bottom ${sidebarMode === "settings" && sidebarVisible ? "is-active" : ""}`}
          type="button"
          title="设置"
          aria-pressed={sidebarMode === "settings" && sidebarVisible}
          onClick={() => activateSidebarMode("settings")}
        >
          <Settings size={22} aria-hidden="true" />
        </button>
      </aside>

      <aside className="sidebar" aria-label="侧栏" aria-hidden={!sidebarVisible}>
        <div className="sidebar-content">{renderSidebarContent()}</div>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整资源管理器宽度"
          title="拖动调整宽度"
          onMouseDown={startSidebarResize}
        />
      </aside>

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
            <Suspense fallback={<div className="editor-loading">正在加载编辑器...</div>}>
              <CodeEditor
                filePath={activeFile.path}
                language={activeFile.language}
                lineEnding={activeFile.lineEnding}
                value={activeFile.content}
                themeMode={themeMode}
                fontSize={fontSize}
                wordWrap={wordWrap}
                onChange={updateActiveContent}
                onCursorChange={handleEditorCursorChange}
                onSave={handleEditorSave}
                onEditorReady={onEditorReady}
              />
            </Suspense>
          ) : (
            <div className="welcome">
              <div className="welcome-mark">
                <TerminalSquare size={42} aria-hidden="true" />
              </div>
              <h1>FnEditor</h1>
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
