import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
await build({
  stdin: {
    contents: `export default ${JSON.stringify(manifest)};`,
    resolveDir: process.cwd(),
    sourcefile: "manifest.generated.js",
    loader: "js",
  },
  bundle: true, platform: "node", format: "esm", outfile: "dist/manifest.js",
  target: "node24", sourcemap: false,
});

await build({
  entryPoints: ["src/worker.ts"], bundle: true, platform: "node", format: "esm",
  outfile: "dist/worker.js", external: ["@bitwarden/sdk-napi", "@bitwarden/sdk-napi-linux-x64-gnu"],
  target: "node24", sourcemap: false,
});
await build({
  entryPoints: ["src/ui/index.tsx"], bundle: true, platform: "browser", format: "esm",
  outfile: "dist/ui.js", target: "es2022", jsx: "automatic", external: ["react", "react-dom", "react/jsx-runtime"],
});
