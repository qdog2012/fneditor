import { spawn } from "node:child_process";
import { createServer } from "vite";
import { buildServer, projectRoot } from "./build-server.mjs";

const port = Number(process.env.PORT || 39280);
const backendPort = Number(process.env.FNEDITOR_DEV_BACKEND_PORT || port + 1);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535 || port === backendPort) {
  throw new Error("PORT and FNEDITOR_DEV_BACKEND_PORT must be distinct valid ports");
}
const binary = await buildServer("fneditor-dev");
const backend = spawn(binary, [], {
  cwd: projectRoot, stdio: "inherit",
  env: { ...process.env, FNEDITOR_HOST: "127.0.0.1", PORT: String(backendPort) }
});
let vite;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  backend.kill("SIGTERM");
  await vite?.close();
  process.exitCode = code;
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
backend.on("error", (error) => { console.error(error.message); void stop(1); });
backend.on("exit", (code) => { if (!stopping) void stop(code || 1); });

try {
  const target = `http://127.0.0.1:${backendPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try { ready = (await fetch(`${target}/api/meta`, { signal: AbortSignal.timeout(500) })).ok; }
    catch { /* The Go listener may still be starting. */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Go backend did not start; check the server output above");
  if (!stopping) {
    vite = await createServer({
      root: projectRoot,
      server: { host: "0.0.0.0", port, strictPort: true, proxy: { "/api": target, "/open-with": target } }
    });
    await vite.listen();
    if (stopping) await vite.close();
    else vite.printUrls();
  }
} catch (error) {
  if (!stopping) { console.error(error.message); await stop(1); }
}
