import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulesRoot = process.argv[2];
if (!modulesRoot) throw new Error("Expected a clean node_modules path");
const require = createRequire(path.join(path.resolve(modulesRoot), "smoke.cjs"));
const { BitwardenClient } = require("@bitwarden/sdk-napi");
const client = new BitwardenClient();
if (!client) throw new Error("Bitwarden SDK client did not initialize");
const packageRoot = path.join(path.resolve(modulesRoot), "paperclip-plugin-bitwarden-secrets-manager");
const worker = await import(pathToFileURL(path.join(packageRoot, "dist/worker.js")));
const ui = await import(pathToFileURL(path.join(packageRoot, "dist/ui.js")));
if (!worker.default || typeof ui.BsmSettingsPage !== "function" || typeof ui.BsmStatusWidget !== "function") {
  throw new Error("Packed worker or settings UI exports did not load");
}
console.log("Packed worker/settings UI loaded; Linux x64 GNU SDK native addon loaded and client constructed");
