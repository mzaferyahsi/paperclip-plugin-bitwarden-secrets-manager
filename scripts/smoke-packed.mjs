import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulesRoot = process.argv[2];
if (!modulesRoot) throw new Error("Expected a clean node_modules path");
const require = createRequire(path.join(path.resolve(modulesRoot), "smoke.cjs"));
const { BitwardenClient } = require("@bitwarden/sdk-napi");
// LogLevel is a TypeScript const enum and is not exported at runtime. Error is
// numeric level 4 in the pinned SDK API.
const client = new BitwardenClient(undefined, 4);
if (!client) throw new Error("Bitwarden SDK client did not initialize");
const packageRoot = path.join(path.resolve(modulesRoot), "paperclip-plugin-bitwarden-secrets-manager");
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const plugin = packageJson.paperclipPlugin;
if (!plugin || typeof plugin.manifest !== "string") {
  throw new Error("Packed plugin package does not declare paperclipPlugin.manifest");
}
const manifestPath = path.resolve(packageRoot, plugin.manifest);
if (!manifestPath.startsWith(`${packageRoot}${path.sep}`)) {
  throw new Error("Packed manifest entrypoint escapes the package root");
}
const manifestModule = await import(pathToFileURL(manifestPath));
const manifest = manifestModule.default ?? manifestModule;
if (manifest.id !== "mzaferyahsi.bitwarden-secrets-manager-sync"
  || manifest.entrypoints?.worker !== plugin.worker
  || manifest.entrypoints?.ui !== plugin.ui) {
  throw new Error("Packed ESM manifest does not match host-discoverable package entrypoints");
}
for (const key of ["manifest", "worker", "ui"]) {
  if (typeof plugin[key] !== "string") throw new Error(`Packed plugin entrypoint is missing: ${key}`);
  const entrypoint = path.resolve(packageRoot, plugin[key]);
  if (!entrypoint.startsWith(`${packageRoot}${path.sep}`)) throw new Error(`Packed plugin entrypoint escapes package root: ${key}`);
  await access(entrypoint);
}
const worker = await import(pathToFileURL(path.join(packageRoot, "dist/worker.js")));
const ui = await import(pathToFileURL(path.join(packageRoot, "dist/ui/index.js")));
if (!worker.default || typeof ui.BsmSettingsPage !== "function" || typeof ui.BsmStatusWidget !== "function") {
  throw new Error("Packed worker or settings UI exports did not load");
}
console.log("Packed worker/settings UI loaded; Linux x64 GNU SDK native addon loaded and client constructed");
