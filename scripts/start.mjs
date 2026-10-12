import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./build-server.mjs";

const binary = path.join(projectRoot, "build", `fneditor${process.platform === "win32" ? ".exe" : ""}`);
try {
  await access(binary);
  const server = spawn(binary, [], { cwd: projectRoot, stdio: "inherit", env: process.env });
  process.on("SIGINT", () => server.kill("SIGINT"));
  process.on("SIGTERM", () => server.kill("SIGTERM"));
  server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  server.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error(`Go server is not built. Run npm run build first. (${error.message})`);
  process.exitCode = 1;
}
