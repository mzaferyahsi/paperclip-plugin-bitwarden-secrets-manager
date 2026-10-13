import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pluginManifestV1Schema } = require("../node_modules/@paperclipai/shared/dist/validators/plugin.js");
const parsed = pluginManifestV1Schema.parse(JSON.parse(fs.readFileSync("manifest.json", "utf8")));
if (parsed.jobs?.[0]?.jobKey !== "bsm-sync") throw new Error("Expected bsm-sync job declaration");
console.log("Manifest valid against installed Paperclip SDK validator");
