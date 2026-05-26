import express from "express";
import compression from "compression";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const maxFileBytes = Number.parseInt(process.env.FNEDITOR_MAX_FILE_BYTES ?? String(5 * 1024 * 1024), 10);
const statePath = path.resolve(process.env.FNEDITOR_STATE_PATH ?? path.join(projectRoot, ".fneditor-state.json"));
const restrictRootSelection = ["1", "true", "yes"].includes(
  String(process.env.FNEDITOR_RESTRICT_ROOTS ?? "").trim().toLowerCase()
);
const handoffTtlMs = 15000;
const instanceTtlMs = 3000;

const app = express();
app.disable("x-powered-by");
app.use(
  compression({
    filter: (req, res) => {
      if (req.path === "/api/handoff/events") {
        return false;
      }
      return compression.filter(req, res);
    }
  })
);
app.use(express.json({ limit: "12mb" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
const handoffClients = new Set();
const handoffRequests = new Map();
const activeInstances = new Map();

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanupHandoffRequests() {
  const now = Date.now();
  for (const [id, request] of handoffRequests) {
    if (now - request.createdAt > handoffTtlMs) {
      handoffRequests.delete(id);
    }
  }
}

function cleanupActiveInstances() {
  const now = Date.now();
  for (const [id, instance] of activeInstances) {
    if (now - instance.updatedAt > instanceTtlMs) {
      activeInstances.delete(id);
    }
  }
}

function sendHandoffEvent(client, event, data) {
  client.write(`event: ${event}\n`);
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastHandoffRequest(request) {
  for (const client of handoffClients) {
    sendHandoffEvent(client, "open-file", request);
  }
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readState() {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    console.warn(`failed to read state file: ${error.message}`);
    return {};
  }
}

async function writeState(nextState) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isFilesystemPermissionError(error) {
  return error?.code === "EACCES" || error?.code === "EPERM";
}

function getConfiguredUserIds() {
  return uniqueNonEmpty([
    process.env.FNEDITOR_USER_ID,
    process.env.TRIM_USER_ID,
    process.env.TRIM_UID,
    process.env.PUID,
    "1000"
  ]);
}

async function directoryHasEntries(candidatePath) {
  try {
    const entries = await fs.readdir(candidatePath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function getFnOSVolumeNames() {
  try {
    const rootEntries = await fs.readdir("/", { withFileTypes: true });
    return rootEntries
      .filter((entry) => entry.isDirectory() && /^vol\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch {
    return [];
  }
}

async function getVolumeUserRootCandidates(userIds, options = {}) {
  const candidates = [];
  const volumeNames = await getFnOSVolumeNames();

  for (const volumeName of volumeNames) {
    for (const userId of userIds) {
      const candidate = `/${volumeName}/${userId}`;
      if (!options.requireEntries || (await directoryHasEntries(candidate))) {
        candidates.push(candidate);
      }
    }
  }

  return uniqueNonEmpty(candidates);
}

async function resolveExistingDirectory(candidatePath, options = {}) {
  if (!candidatePath) {
    return null;
  }

  const absolute = path.resolve(String(candidatePath).trim());
  if (!(await exists(absolute))) {
    if (options.throwIfMissing) {
      throw new Error(`${options.label ?? "root"} does not exist: ${absolute}`);
    }
    return null;
  }

  const real = await fs.realpath(absolute);
  if (path.resolve(real) === path.parse(real).root) {
    if (options.throwIfMissing) {
      throw new Error(`${options.label ?? "root"} cannot be the filesystem root: ${absolute}`);
    }
    return null;
  }

  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    if (options.throwIfMissing) {
      throw new Error(`${options.label ?? "root"} is not a directory: ${absolute}`);
    }
    return null;
  }

  return real;
}

async function getAllowedRootBases() {
  const candidates = [
    ...(await getFnOSDefaultRootCandidates()),
    path.dirname(statePath),
    path.join(path.dirname(statePath), "files")
  ];

  const bases = [];
  for (const candidate of uniqueNonEmpty(candidates)) {
    const resolved = await resolveExistingDirectory(candidate);
    if (resolved) {
      bases.push(resolved);
    }
  }

  return uniqueNonEmpty(bases.map((base) => path.resolve(base)));
}

async function isAllowedEditorRoot(candidatePath) {
  if (!restrictRootSelection) {
    return true;
  }

  const absolute = path.resolve(candidatePath);
  const allowedBases = await getAllowedRootBases();
  return allowedBases.some((base) => isPathInside(base, absolute));
}

async function resolveDirectoryRoot(candidatePath, options = {}) {
  const real = await resolveExistingDirectory(candidatePath, options);
  if (!real) {
    return null;
  }

  if (await isAllowedEditorRoot(real)) {
    return real;
  }

  if (options.throwIfMissing || options.throwIfDisallowed) {
    throw createHttpError(403, "只能选择飞牛“我的文件”目录，例如 /vol2/1000 或 /vol2/1000/docker");
  }

  return null;
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

async function getFnOSDefaultRootCandidates() {
  const userIds = getConfiguredUserIds();

  const candidates = [
    ...(await getVolumeUserRootCandidates(["1000"], { requireEntries: true })),
    ...(await getVolumeUserRootCandidates(userIds.filter((userId) => userId !== "1000"), { requireEntries: true }))
  ];

  for (const userId of userIds) {
    candidates.push(
      `/share/home/${userId}/webdav`,
      `/share/home/${userId}`
    );
  }

  candidates.push(...(await getVolumeUserRootCandidates(userIds)));

  return uniqueNonEmpty(candidates);
}

async function resolveRoot() {
  const state = await readState();
  const saved = await resolveDirectoryRoot(state.lastRootPath);
  if (saved) {
    return saved;
  }

  const configured = process.env.FNEDITOR_ROOT || process.env.FILES_ROOT;
  if (configured) {
    return resolveDirectoryRoot(configured, { throwIfMissing: true, label: "FNEDITOR_ROOT" });
  }

  const candidates = [
    ...(await getFnOSDefaultRootCandidates()),
    path.join(os.homedir(), "我的文件"),
    path.join(os.homedir(), "My Files"),
    process.cwd()
  ];

  for (const candidate of candidates) {
    const resolved = await resolveDirectoryRoot(candidate);
    if (resolved) {
      return resolved;
    }
  }

  const fallbackRoot = path.join(path.dirname(statePath), "files");
  await fs.mkdir(fallbackRoot, { recursive: true });
  return resolveDirectoryRoot(fallbackRoot, { throwIfMissing: true, label: "fallback root" });
}

let rootPath = await resolveRoot();
let rootLabel = process.env.FNEDITOR_ROOT_LABEL || path.basename(rootPath) || rootPath;

function getMetaPayload() {
  return {
    rootLabel,
    rootPath,
    maxFileBytes
  };
}

async function setRootPath(nextRootPath) {
  const normalized = String(nextRootPath ?? "").trim();
  if (!normalized) {
    throw createHttpError(400, "缺少根目录路径");
  }

  const absolute = path.resolve(normalized);
  if (!(await exists(absolute))) {
    throw createHttpError(404, "根目录不存在");
  }

  const real = await fs.realpath(absolute);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw createHttpError(400, "根目录必须是文件夹");
  }
  if (path.resolve(real) === path.parse(real).root) {
    throw createHttpError(400, "根目录不能设置为系统根目录");
  }

  if (!(await isAllowedEditorRoot(real))) {
    throw createHttpError(403, "只能选择飞牛“我的文件”目录，例如 /vol2/1000 或 /vol2/1000/docker");
  }

  const nextLabel = path.basename(real) || real;
  const state = await readState();
  await writeState({
    ...state,
    lastRootPath: real,
    lastRootLabel: nextLabel,
    updatedAt: new Date().toISOString()
  });

  rootPath = real;
  rootLabel = nextLabel;
  return getMetaPayload();
}

function normalizeClientPath(input = "") {
  const value = String(input ?? "").replaceAll("\\", "/").trim();
  const withoutLeadingSlash = value.replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);

  if (normalized === ".") {
    return "";
  }

  if (normalized === ".." || normalized.startsWith("../")) {
    throw createHttpError(400, "路径不能越过根目录");
  }

  return normalized;
}

function ensureInsideRoot(absolutePath) {
  const relative = path.relative(rootPath, absolutePath);
  if (relative === "") {
    return;
  }

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw createHttpError(403, "路径不在允许访问的目录内");
  }
}

function toAbsolutePath(clientPath = "") {
  const normalized = normalizeClientPath(clientPath);
  const absolute = path.resolve(rootPath, ...normalized.split("/").filter(Boolean));
  ensureInsideRoot(absolute);
  return { absolute, relative: normalized };
}

function toClientPath(absolutePath) {
  const relative = path.relative(rootPath, absolutePath);
  return relative.split(path.sep).filter(Boolean).join("/");
}

function toClientPathFromRoot(rootDirectory, absolutePath) {
  const relative = path.relative(rootDirectory, absolutePath);
  return relative.split(path.sep).filter(Boolean).join("/");
}

async function getRootForAbsolutePath(realPath) {
  if (isPathInside(rootPath, realPath)) {
    return rootPath;
  }

  if (!restrictRootSelection) {
    return path.dirname(realPath);
  }

  const allowedBases = await getAllowedRootBases();
  const matchingBases = allowedBases
    .filter((base) => isPathInside(base, realPath))
    .sort((a, b) => b.length - a.length);

  if (matchingBases.length === 0) {
    throw createHttpError(403, "只能打开飞牛“我的文件”目录内的文本文件");
  }

  return matchingBases[0];
}

async function readTextFilePayload(real, relative) {
  const stat = await fs.stat(real);

  if (!stat.isFile()) {
    throw createHttpError(400, "目标路径不是文件");
  }

  if (stat.size > maxFileBytes) {
    throw createHttpError(413, `文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已阻止打开`);
  }

  const buffer = await fs.readFile(real);
  const decoded = decodeTextBuffer(buffer);
  if (!decoded) {
    throw createHttpError(415, "二进制文件暂不支持直接编辑");
  }

  return {
    path: relative,
    absolutePath: real,
    name: path.basename(real),
    content: decoded.content,
    encoding: decoded.encoding,
    hasBom: decoded.hasBom,
    modifiedAt: stat.mtime.toISOString(),
    size: stat.size
  };
}

async function getExistingPath(clientPath = "") {
  const { absolute, relative } = toAbsolutePath(clientPath);
  const real = await fs.realpath(absolute);
  ensureInsideRoot(real);
  return { absolute, real, relative };
}

async function getWritablePath(clientPath = "") {
  const { absolute, relative } = toAbsolutePath(clientPath);
  const parent = path.dirname(absolute);
  const parentReal = await fs.realpath(parent);
  ensureInsideRoot(parentReal);
  return { absolute, relative };
}

async function getWritableFilePath(clientPath = "") {
  const { absolute, relative } = toAbsolutePath(clientPath);

  if (await exists(absolute)) {
    const real = await fs.realpath(absolute);
    ensureInsideRoot(real);
    const stat = await fs.stat(real);
    if (!stat.isFile()) {
      throw createHttpError(400, "目标路径不是文件");
    }
    return { absolute, relative };
  }

  return getWritablePath(clientPath);
}

async function getWritableFileTarget(clientPath = "", requestedAbsolutePath = "") {
  const absoluteInput = String(requestedAbsolutePath ?? "").trim();
  if (!absoluteInput) {
    return getWritableFilePath(clientPath);
  }

  if (!path.isAbsolute(absoluteInput)) {
    throw createHttpError(400, "absolutePath 必须是绝对路径");
  }

  const absolute = path.resolve(absoluteInput);
  let targetPath = absolute;
  if (await exists(absolute)) {
    targetPath = await fs.realpath(absolute);
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      throw createHttpError(400, "目标路径不是文件");
    }
  } else {
    const parent = path.dirname(absolute);
    const parentReal = await fs.realpath(parent);
    if (!(await isAllowedEditorRoot(parentReal))) {
      throw createHttpError(403, "保存路径不在允许访问的目录内");
    }
  }

  if (!(await isAllowedEditorRoot(targetPath))) {
    throw createHttpError(403, "保存路径不在允许访问的目录内");
  }

  const relative = isPathInside(rootPath, targetPath)
    ? toClientPath(targetPath)
    : normalizeClientPath(clientPath) || path.basename(targetPath);
  return { absolute: targetPath, relative };
}

function compareTreeItems(a, b) {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }

  return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

function detectTextEncoding(buffer) {
  if (buffer.length === 0) {
    return { encoding: "utf8", hasBom: false };
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: "utf8", hasBom: true };
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: "utf16le", hasBom: true };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: "utf16be", hasBom: true };
  }

  const sampleSize = Math.min(buffer.length, 4096);
  let nulCount = 0;
  let evenNulCount = 0;
  let oddNulCount = 0;
  let pairCount = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    if (buffer[index] !== 0) {
      continue;
    }

    nulCount += 1;
    if (index % 2 === 0) {
      evenNulCount += 1;
    } else {
      oddNulCount += 1;
    }
  }

  for (let index = 0; index + 1 < sampleSize; index += 2) {
    pairCount += 1;
  }

  if (pairCount >= 4) {
    const evenRatio = evenNulCount / pairCount;
    const oddRatio = oddNulCount / pairCount;
    if (oddRatio > 0.35 && evenRatio < 0.12) {
      return { encoding: "utf16le", hasBom: false };
    }
    if (evenRatio > 0.35 && oddRatio < 0.12) {
      return { encoding: "utf16be", hasBom: false };
    }
  }

  if (nulCount > 0) {
    return null;
  }

  return { encoding: "utf8", hasBom: false };
}

function decodeUtf16be(buffer) {
  const start = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff ? 2 : 0;
  const swapped = Buffer.alloc(buffer.length - start);
  for (let index = start; index + 1 < buffer.length; index += 2) {
    swapped[index - start] = buffer[index + 1];
    swapped[index - start + 1] = buffer[index];
  }

  return swapped.toString("utf16le").replace(/^\uFEFF/, "");
}

function encodeUtf16be(content, hasBom) {
  const source = Buffer.from(content, "utf16le");
  const target = Buffer.alloc(source.length + (hasBom ? 2 : 0));
  let offset = 0;
  if (hasBom) {
    target[0] = 0xfe;
    target[1] = 0xff;
    offset = 2;
  }

  for (let index = 0; index + 1 < source.length; index += 2) {
    target[offset + index] = source[index + 1];
    target[offset + index + 1] = source[index];
  }

  return target;
}

function decodeTextBuffer(buffer) {
  const detected = detectTextEncoding(buffer);
  if (!detected) {
    return null;
  }

  const { encoding, hasBom } = detected;
  if (encoding === "utf16le") {
    const start = hasBom ? 2 : 0;
    return {
      content: buffer.subarray(start).toString("utf16le").replace(/^\uFEFF/, ""),
      encoding,
      hasBom
    };
  }

  if (encoding === "utf16be") {
    return {
      content: decodeUtf16be(buffer),
      encoding,
      hasBom
    };
  }

  const start = hasBom ? 3 : 0;
  return {
    content: buffer.subarray(start).toString("utf8").replace(/^\uFEFF/, ""),
    encoding,
    hasBom
  };
}

function encodeTextContent(content, encoding = "utf8", hasBom = false) {
  if (encoding === "utf16le") {
    const prefix = hasBom ? "\uFEFF" : "";
    return Buffer.from(`${prefix}${content}`, "utf16le");
  }

  if (encoding === "utf16be") {
    return encodeUtf16be(content, hasBom);
  }

  const prefix = hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  return Buffer.concat([prefix, Buffer.from(content, "utf8")]);
}

async function writeFileAndSync(filePath, data) {
  const handle = await fs.open(filePath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createHttpError(499, "搜索已取消");
  }
}

async function readDirectory(clientPath = "") {
  const { real, relative } = await getExistingPath(clientPath);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw createHttpError(400, "目标路径不是文件夹");
  }

  let entries = [];
  try {
    entries = await fs.readdir(real, { withFileTypes: true });
  } catch (error) {
    if (isFilesystemPermissionError(error)) {
      throw createHttpError(403, `没有权限读取目录：${real}`);
    }
    throw error;
  }

  const entriesWithStats = await Promise.all(
    entries.map(async (entry) => {
      try {
        const absolute = path.join(real, entry.name);
        const itemReal = await fs.realpath(absolute);
        ensureInsideRoot(itemReal);
        const itemStat = await fs.stat(itemReal);
        const itemPath = [relative, entry.name].filter(Boolean).join("/");
        return {
          name: entry.name,
          path: itemPath,
          type: itemStat.isDirectory() ? "directory" : "file",
          size: itemStat.size,
          modifiedAt: itemStat.mtime.toISOString()
        };
      } catch {
        return null;
      }
    })
  );
  const items = entriesWithStats.filter(Boolean);

  items.sort(compareTreeItems);
  return items;
}

async function searchInRoot(query, startDir = "", limit = 120, signal) {
  const keyword = String(query ?? "").trim();
  if (!keyword) {
    return [];
  }

  throwIfAborted(signal);
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 120, 300));
  const lowerKeyword = keyword.toLowerCase();
  const { real, relative } = await getExistingPath(startDir);
  throwIfAborted(signal);
  const rootStat = await fs.stat(real);
  if (!rootStat.isDirectory()) {
    throw createHttpError(400, "搜索起点必须是文件夹");
  }

  const results = [];
  const visitedDirectories = new Set();

  async function walk(directoryPath, clientDir) {
    throwIfAborted(signal);
    if (results.length >= normalizedLimit) {
      return;
    }

    const directoryReal = await fs.realpath(directoryPath);
    throwIfAborted(signal);
    if (visitedDirectories.has(directoryReal)) {
      return;
    }
    visitedDirectories.add(directoryReal);

    let entries = [];
    try {
      entries = await fs.readdir(directoryReal, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      throwIfAborted(signal);
      if (results.length >= normalizedLimit) {
        return;
      }

      const absolute = path.join(directoryReal, entry.name);
      let itemReal;
      let stat;
      try {
        itemReal = await fs.realpath(absolute);
        ensureInsideRoot(itemReal);
        stat = await fs.stat(itemReal);
      } catch {
        continue;
      }

      const itemPath = [clientDir, entry.name].filter(Boolean).join("/");
      const nameMatched = entry.name.toLowerCase().includes(lowerKeyword) || itemPath.toLowerCase().includes(lowerKeyword);

      if (stat.isDirectory()) {
        if (nameMatched) {
          results.push({
            path: itemPath,
            name: entry.name,
            type: "directory",
            matchedBy: "name"
          });
        }
        await walk(itemReal, itemPath);
        continue;
      }

      if (!stat.isFile()) {
        continue;
      }

      if (nameMatched) {
        results.push({
          path: itemPath,
          name: entry.name,
          type: "file",
          matchedBy: "name"
        });
        if (results.length >= normalizedLimit) {
          return;
        }
      }

      if (stat.size > maxFileBytes) {
        continue;
      }

      try {
        throwIfAborted(signal);
        const buffer = await fs.readFile(itemReal);
        throwIfAborted(signal);
        const decoded = decodeTextBuffer(buffer);
        if (!decoded) {
          continue;
        }

        const lines = decoded.content.split(/\r?\n/);
        const matchedLineIndex = lines.findIndex((line) => line.toLowerCase().includes(lowerKeyword));
        if (matchedLineIndex >= 0) {
          results.push({
            path: itemPath,
            name: entry.name,
            type: "file",
            matchedBy: "content",
            line: matchedLineIndex + 1,
            preview: lines[matchedLineIndex].trim().slice(0, 180)
          });
        }
      } catch {
        // Skip files that cannot be read as text.
      }
    }
  }

  await walk(real, relative);
  return results;
}

app.get(
  "/api/meta",
  asyncRoute(async (_req, res) => {
    res.json(getMetaPayload());
  })
);

app.post(
  "/api/instances/heartbeat",
  asyncRoute(async (req, res) => {
    cleanupActiveInstances();
    const id = String(req.body?.id ?? "").trim();
    if (!id) {
      throw createHttpError(400, "缺少实例 id");
    }

    activeInstances.set(id, { id, updatedAt: Date.now() });
    res.json({ ok: true });
  })
);

app.post(
  "/api/instances/claim",
  asyncRoute(async (req, res) => {
    cleanupActiveInstances();
    const id = String(req.body?.id ?? "").trim();
    if (!id) {
      throw createHttpError(400, "缺少实例 id");
    }

    const primary = [...activeInstances.values()]
      .filter((instance) => instance.id !== id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (primary) {
      res.json({ active: true, id: primary.id, ageMs: Date.now() - primary.updatedAt });
      return;
    }

    activeInstances.set(id, { id, updatedAt: Date.now() });
    res.json({ active: false, id, ageMs: 0 });
  })
);

app.get("/api/instances/primary", (req, res) => {
  cleanupActiveInstances();
  const sourceId = String(req.query.sourceId ?? "").trim();
  const primary = [...activeInstances.values()]
    .filter((instance) => instance.id !== sourceId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  res.json({ active: Boolean(primary), id: primary?.id ?? "", ageMs: primary ? Date.now() - primary.updatedAt : 0 });
});

app.delete("/api/instances/:id", (req, res) => {
  activeInstances.delete(String(req.params.id ?? ""));
  res.json({ ok: true });
});

app.post("/api/instances/release", (req, res) => {
  const id = String(req.body?.id ?? "").trim();
  if (id) {
    activeInstances.delete(id);
  }
  res.json({ ok: true });
});

app.post(
  "/api/root",
  asyncRoute(async (req, res) => {
    const { path: nextRootPath } = req.body ?? {};
    if (typeof nextRootPath !== "string") {
      throw createHttpError(400, "缺少根目录路径");
    }

    res.json(await setRootPath(nextRootPath));
  })
);

app.get(
  "/api/tree",
  asyncRoute(async (req, res) => {
    const dir = normalizeClientPath(req.query.dir ?? "");
    const items = await readDirectory(dir);
    res.json({ dir, items });
  })
);

app.get(
  "/api/search",
  asyncRoute(async (req, res) => {
    const controller = new AbortController();
    req.on("aborted", () => {
      controller.abort();
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    const query = String(req.query.query ?? "");
    const dir = normalizeClientPath(req.query.dir ?? "");
    const limit = Number.parseInt(String(req.query.limit ?? "120"), 10);
    let items = [];
    try {
      items = await searchInRoot(query, dir, limit, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      throw error;
    }

    if (controller.signal.aborted) {
      return;
    }

    res.json({ query, dir, items });
  })
);

app.get(
  "/api/file",
  asyncRoute(async (req, res) => {
    const targetPath = normalizeClientPath(req.query.path ?? "");
    const { real, relative } = await getExistingPath(targetPath);
    res.json(await readTextFilePayload(real, relative));
    return;
    const stat = await fs.stat(real);

    if (!stat.isFile()) {
      throw createHttpError(400, "目标路径不是文件");
    }

    if (stat.size > maxFileBytes) {
      throw createHttpError(413, `文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已阻止打开`);
    }

    const buffer = await fs.readFile(real);
    const decoded = decodeTextBuffer(buffer);
    if (!decoded) {
      throw createHttpError(415, "二进制文件暂不支持直接编辑");
    }

    res.json({
      path: relative,
      absolutePath: real,
      name: path.basename(real),
      content: decoded.content,
      encoding: decoded.encoding,
      hasBom: decoded.hasBom,
      modifiedAt: stat.mtime.toISOString(),
      size: stat.size
    });
  })
);

app.post(
  "/api/open-path",
  asyncRoute(async (req, res) => {
    const requestedPath = String(req.body?.path ?? "").trim();
    if (!requestedPath) {
      throw createHttpError(400, "缺少 path");
    }

    if (!path.isAbsolute(requestedPath)) {
      throw createHttpError(400, "path 必须是绝对路径");
    }

    const absolute = path.resolve(requestedPath);
    if (!(await exists(absolute))) {
      throw createHttpError(404, "文件不存在");
    }

    const real = await fs.realpath(absolute);
    if (!(await isAllowedEditorRoot(real))) {
      throw createHttpError(403, "只能打开飞牛“我的文件”目录内的文本文件");
    }

    const nextRoot = await getRootForAbsolutePath(real);
    if (path.resolve(nextRoot) !== path.resolve(rootPath)) {
      await setRootPath(nextRoot);
    }

    ensureInsideRoot(real);
    const relative = toClientPathFromRoot(rootPath, real);
    const file = await readTextFilePayload(real, relative);
    res.json({
      meta: getMetaPayload(),
      file
    });
  })
);

app.get("/api/handoff/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  handoffClients.add(res);
  sendHandoffEvent(res, "ready", { ok: true });

  const ping = setInterval(() => {
    sendHandoffEvent(res, "ping", { now: Date.now() });
  }, 20000);

  req.on("close", () => {
    clearInterval(ping);
    handoffClients.delete(res);
  });
});

app.post(
  "/api/handoff/open",
  asyncRoute(async (req, res) => {
    cleanupHandoffRequests();
    const id = String(req.body?.id ?? "").trim();
    const sourceId = String(req.body?.sourceId ?? "").trim();
    const requestedPath = String(req.body?.path ?? "").trim();
    if (!id || !sourceId || !requestedPath) {
      throw createHttpError(400, "缺少打开请求参数");
    }

    const request = {
      type: "open-file",
      id,
      sourceId,
      path: requestedPath,
      createdAt: Date.now(),
      acknowledged: false
    };
    handoffRequests.set(id, request);
    broadcastHandoffRequest(request);
    res.json({ ok: true });
  })
);

app.get("/api/handoff/status", (req, res) => {
  cleanupHandoffRequests();
  const id = String(req.query.id ?? "").trim();
  const request = handoffRequests.get(id);
  res.json({ acknowledged: Boolean(request?.acknowledged) });
});

app.get("/api/handoff/pending", (req, res) => {
  cleanupHandoffRequests();
  const sourceId = String(req.query.sourceId ?? "").trim();
  const items = [];
  for (const request of handoffRequests.values()) {
    if (!request.acknowledged && request.sourceId !== sourceId) {
      items.push(request);
    }
  }
  res.json({ items: items.slice(-20) });
});

app.post(
  "/api/handoff/ack",
  asyncRoute(async (req, res) => {
    cleanupHandoffRequests();
    const id = String(req.body?.id ?? "").trim();
    if (!id) {
      throw createHttpError(400, "缺少请求 id");
    }

    const request = handoffRequests.get(id);
    if (request) {
      request.acknowledged = true;
      request.acknowledgedAt = Date.now();
    }
    res.json({ ok: true });
  })
);

async function saveFileRequest(req, res) {
  const { path: clientPath, absolutePath, content, encoding = "utf8", hasBom = false } = req.body ?? {};
  if (typeof clientPath !== "string" || typeof content !== "string") {
    throw createHttpError(400, "缺少 path 或 content");
  }

  const encoded = encodeTextContent(content, encoding, Boolean(hasBom));
  if (encoded.length > maxFileBytes) {
    throw createHttpError(413, `文件超过 ${Math.round(maxFileBytes / 1024 / 1024)}MB，已阻止保存`);
  }

  const { absolute, relative } = await getWritableFileTarget(clientPath, absolutePath);
  await writeFileAndSync(absolute, encoded);
  const stat = await fs.stat(absolute);
  return res.json({
    path: relative,
    absolutePath: absolute,
    name: path.basename(absolute),
    content,
    encoding,
    hasBom: Boolean(hasBom),
    modifiedAt: stat.mtime.toISOString(),
    size: stat.size
  });
}

app.post("/api/file/save", asyncRoute(saveFileRequest));
app.put("/api/file", asyncRoute(saveFileRequest));

app.post(
  "/api/file",
  asyncRoute(async (req, res) => {
    const { path: clientPath, content = "" } = req.body ?? {};
    if (typeof clientPath !== "string" || typeof content !== "string") {
      throw createHttpError(400, "缺少 path");
    }

    const { absolute, relative } = await getWritablePath(clientPath);
    if (await exists(absolute)) {
      throw createHttpError(409, "同名文件已存在");
    }

    await fs.writeFile(absolute, content, "utf8");
    const stat = await fs.stat(absolute);
    res.status(201).json({
      path: relative,
      modifiedAt: stat.mtime.toISOString(),
      size: stat.size
    });
  })
);

app.post(
  "/api/folder",
  asyncRoute(async (req, res) => {
    const { path: clientPath } = req.body ?? {};
    if (typeof clientPath !== "string") {
      throw createHttpError(400, "缺少 path");
    }

    const { absolute, relative } = await getWritablePath(clientPath);
    await fs.mkdir(absolute, { recursive: false });
    res.status(201).json({ path: relative });
  })
);

app.delete(
  "/api/path",
  asyncRoute(async (req, res) => {
    const targetPath = normalizeClientPath(req.query.path ?? "");
    if (!targetPath) {
      throw createHttpError(400, "不能删除根目录");
    }

    const { absolute, real, relative } = await getExistingPath(targetPath);
    ensureInsideRoot(real);
    await fs.rm(absolute, { recursive: true, force: false });
    res.json({ path: relative });
  })
);

app.patch(
  "/api/path",
  asyncRoute(async (req, res) => {
    const { path: clientPath, newPath } = req.body ?? {};
    if (typeof clientPath !== "string" || typeof newPath !== "string") {
      throw createHttpError(400, "缺少 path 或 newPath");
    }

    const targetPath = normalizeClientPath(clientPath);
    const nextPath = normalizeClientPath(newPath);
    if (!targetPath || !nextPath) {
      throw createHttpError(400, "不能重命名根目录");
    }

    const { absolute, real } = await getExistingPath(targetPath);
    ensureInsideRoot(real);

    const { absolute: nextAbsolute, relative } = await getWritablePath(nextPath);
    if (await exists(nextAbsolute)) {
      throw createHttpError(409, "目标路径已存在");
    }

    await fs.rename(absolute, nextAbsolute);
    const stat = await fs.stat(nextAbsolute);
    res.json({
      path: relative,
      type: stat.isDirectory() ? "directory" : "file",
      modifiedAt: stat.mtime.toISOString(),
      size: stat.size
    });
  })
);

app.get("/open-with", (req, res) => {
  const requestedPath = String(req.query.path ?? req.query.open ?? req.query.file ?? "");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FnCode</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
        background: #1e1f22;
        color: #c9d1d9;
        font: 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        display: grid;
        place-items: center;
      }
    </style>
  </head>
  <body>
    <div>正在用 FnCode 打开...</div>
    <script>
      (function () {
        var requestedPath = ${JSON.stringify(requestedPath)};
        var instanceId =
          (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
          String(Date.now()) + "-" + Math.random().toString(36).slice(2);

        function apiUrl(path) {
          var proxyIndex = window.location.pathname.indexOf("/proxy.cgi");
          if (proxyIndex >= 0) {
            return window.location.pathname.slice(0, proxyIndex) + "/proxy.cgi" + path;
          }
          return path;
        }

        function editorUrl(path) {
          var proxyIndex = window.location.pathname.indexOf("/proxy.cgi");
          var base = proxyIndex >= 0 ? window.location.pathname.slice(0, proxyIndex) + "/proxy.cgi/" : "/";
          return base + (path ? "?open=" + encodeURIComponent(path) : "");
        }

        function closeWindow() {
          try {
            window.close();
          } catch (_) {}
          try {
            var selfWindow = window.open("", "_self");
            if (selfWindow) {
              selfWindow.close();
            }
          } catch (_) {}
          try {
            var parentWindow = window.parent;
            var frameElement = window.frameElement;
            if (!parentWindow || parentWindow === window || !frameElement) {
              return;
            }
            var selectors = [
              '[aria-label*="关闭"]',
              '[title*="关闭"]',
              '[aria-label*="close" i]',
              '[title*="close" i]',
              '[class*="close" i]',
              '[class*="Close"]'
            ];
            var current = frameElement;
            for (var depth = 0; current && current !== parentWindow.document.body && depth < 12; depth += 1) {
              for (var index = 0; index < selectors.length; index += 1) {
                var button = current.querySelector(selectors[index]);
                if (button && !button.hasAttribute("disabled")) {
                  button.click();
                  return;
                }
              }
              current = current.parentElement;
            }
          } catch (_) {}
        }

        function fetchJson(url, options) {
          return fetch(url, options).then(function (response) {
            if (!response.ok) {
              throw new Error(response.statusText || "Request failed");
            }
            return response.json();
          });
        }

        function sleep(ms) {
          return new Promise(function (resolve) {
            window.setTimeout(resolve, ms);
          });
        }

        async function run() {
          if (!requestedPath) {
            window.location.replace(editorUrl(""));
            return;
          }

          try {
            var primary = await fetchJson(
              apiUrl("/api/instances/primary?sourceId=" + encodeURIComponent(instanceId))
            );
            var primaryAge = Number(primary.ageMs == null ? Number.POSITIVE_INFINITY : primary.ageMs);
            if (primary.active && primaryAge <= 3000) {
              var requestId = instanceId + "-open";
              await fetchJson(apiUrl("/api/handoff/open"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "open-file",
                  id: requestId,
                  sourceId: instanceId,
                  path: requestedPath,
                  createdAt: Date.now()
                })
              });

              for (var attempt = 0; attempt < 20; attempt += 1) {
                await sleep(150);
                try {
                  var status = await fetchJson(apiUrl("/api/handoff/status?id=" + encodeURIComponent(requestId)));
                  if (status.acknowledged) {
                    closeWindow();
                    window.setTimeout(closeWindow, 80);
                    window.setTimeout(closeWindow, 220);
                    window.setTimeout(closeWindow, 700);
                    return;
                  }
                } catch (_) {}
              }
            }
          } catch (_) {
            // Fall through and open a normal editor window.
          }

          window.location.replace(editorUrl(requestedPath));
        }

        run();
      })();
    </script>
  </body>
</html>`);
});

if (isProduction) {
  const distPath = path.join(projectRoot, "dist");
  app.use((req, res, next) => {
    if (req.method === "GET" && (req.path === "/" || req.path.endsWith(".html") || !path.extname(req.path))) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });
  app.use(
    express.static(distPath, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      }
    })
  );
  app.use((req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }

    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: projectRoot,
    server: { middlewareMode: true },
    appType: "spa"
  });

  app.use(vite.middlewares);
}

app.use((error, _req, res, _next) => {
  const status = error.status || (isFilesystemPermissionError(error) ? 403 : 500);
  const message = status >= 500 ? "服务器内部错误" : error.message;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({ error: message });
});

http.createServer(app).listen(port, "0.0.0.0", () => {
  console.log(`fneditor listening on http://0.0.0.0:${port}`);
  console.log(`file root: ${rootPath}`);
});
