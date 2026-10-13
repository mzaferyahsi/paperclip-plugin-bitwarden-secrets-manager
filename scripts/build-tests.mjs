import { build } from "esbuild";
import fs from "node:fs";

fs.rmSync(".test-build", { recursive: true, force: true });
await build({
  entryPoints: ["src/runtime.ts"], bundle: true, platform: "node", format: "esm",
  outfile: ".test-build/runtime.js", target: "node24", sourcemap: false,
  external: ["@bitwarden/sdk-napi", "@bitwarden/sdk-napi-linux-x64-gnu"],
});
await build({
  entryPoints: ["src/adapters/bitwarden.ts"], bundle: true, platform: "node", format: "esm",
  outfile: ".test-build/bitwarden-adapter.mjs", target: "node24", sourcemap: false,
  external: ["@bitwarden/sdk-napi", "@bitwarden/sdk-napi-linux-x64-gnu"],
});
await build({
  entryPoints: ["src/settings-actions.ts"], bundle: true, platform: "node", format: "esm",
  outfile: ".test-build/settings-actions.js", target: "node24", sourcemap: false,
});
for (const [entry, out] of [["src/overview.ts", "overview.js"], ["src/messages.ts", "messages.js"], ["src/adapters/types.ts", "adapters/types.js"]]) {
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm",
    outfile: `.test-build/${out}`, target: "node24", sourcemap: false,
    external: ["@bitwarden/sdk-napi", "@bitwarden/sdk-napi-linux-x64-gnu"],
  });
}
await build({
  entryPoints: ["tests/adapters.test.ts"], bundle: true, platform: "node", format: "esm",
  outfile: ".test-build/adapters.test.mjs", target: "node24", sourcemap: false,
  external: ["@bitwarden/sdk-napi", "@bitwarden/sdk-napi-linux-x64-gnu"],
});
await build({
  entryPoints: ["tests/sync.test.ts"], bundle: true, platform: "node", format: "esm",
  outfile: ".test-build/sync.test.mjs", target: "node24", sourcemap: false,
  external: ["@bitwarden/sdk-napi", "@bitwarden/sdk-napi-linux-x64-gnu"],
});
