import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/api.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
});
const { readApiResponse, assertFilePayload } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("CGI errors with HTTP 200 preserve the actual file error", async () => {
  for (const message of ["文件超过 5MB，已阻止打开", "二进制文件暂不支持直接编辑", "文件不存在", "没有权限读取文件"]) {
    await assert.rejects(readApiResponse(json({ error: message })), { message });
  }
});

test("HTTP errors preserve the server message and use status text as fallback", async () => {
  await assert.rejects(readApiResponse(json({ error: "文件不存在" }, 404)), { message: "文件不存在" });
  await assert.rejects(readApiResponse(new Response("", { status: 502, statusText: "Bad Gateway" })), { message: "Bad Gateway" });
});

test("invalid success responses produce a readable error", async () => {
  for (const body of [null, "invalid", []]) {
    await assert.rejects(readApiResponse(json(body)), /服务器返回了无效的数据/);
  }
  await assert.rejects(readApiResponse(new Response("<html>login</html>")), /服务器返回了无效的数据/);
});

test("normal direct-file and external-open responses retain file data", async () => {
  const file = { path: "配置.txt", name: "配置.txt", content: "", modifiedAt: "2026-10-12T00:00:00.000Z" };
  const direct = await readApiResponse(json(file));
  assertFilePayload(direct);
  assert.deepEqual(direct, file);
  const external = await readApiResponse(json({ meta: { rootPath: "/files" }, file }));
  assertFilePayload(external.file);
  assert.deepEqual(external.file, file);
});

test("missing external-open file data cannot cause an undefined path exception", () => {
  for (const payload of [undefined, null, {}, { error: "打开失败" }, { path: "file.txt", name: "file.txt" }, { path: "", name: "", content: "" }]) {
    assert.throws(() => assertFilePayload(payload), /服务器未返回有效的文件内容/);
  }
});
