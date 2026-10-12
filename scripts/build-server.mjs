import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export async function buildServer(name = "fneditor") {
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const windows = process.env.GOOS ? process.env.GOOS === "windows" : process.platform === "win32";
  const binary = path.join(projectRoot, "build", `${name}${windows ? ".exe" : ""}`);
  await mkdir(path.dirname(binary), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", binary, "./server"], {
      cwd: projectRoot, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0" }
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Go build exited with code ${code}`)));
  });
  return binary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Go server built: ${await buildServer()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
