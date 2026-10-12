export type FilePayload = {
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

export async function readApiResponse<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      response.ok ? "服务器返回了无效的数据，请刷新页面后重试" : response.statusText || `请求失败（${response.status}）`
    );
  }

  const hasError = payload !== null && typeof payload === "object" && "error" in payload;
  // Some CGI gateways return HTTP 200 even when the upstream request failed.
  if (!response.ok || hasError) {
    const message = hasError ? (payload as { error: unknown }).error : undefined;
    throw new Error(typeof message === "string" && message ? message : response.statusText || `请求失败（${response.status}）`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("服务器返回了无效的数据，请刷新页面后重试");
  }
  return payload as T;
}

export function assertFilePayload(payload: unknown): asserts payload is FilePayload {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("path" in payload) ||
    typeof payload.path !== "string" ||
    !payload.path ||
    !("name" in payload) ||
    typeof payload.name !== "string" ||
    !("content" in payload) ||
    typeof payload.content !== "string"
  ) {
    throw new Error("打开文件失败：服务器未返回有效的文件内容");
  }
}
