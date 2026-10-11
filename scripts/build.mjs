import { build } from "esbuild";

await build({
  entryPoints: ["src/worker.ts"], bundle: true, platform: "node", format: "esm",
  outfile: "dist/worker.js", external: ["@bitwarden/sdk-napi", "@bitwarden/sdk-napi-linux-x64-gnu"],
  target: "node24", sourcemap: false,
});
await build({
  entryPoints: ["src/ui/index.tsx"], bundle: true, platform: "browser", format: "esm",
  outfile: "dist/ui.js", target: "es2022", jsx: "automatic", external: ["react", "react-dom", "react/jsx-runtime"],
});
