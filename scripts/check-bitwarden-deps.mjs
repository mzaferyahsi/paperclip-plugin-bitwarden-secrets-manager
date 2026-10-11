import fs from "node:fs";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const allowed = new Map([
  ["node_modules/@bitwarden/sdk-napi", "1.0.0"],
  ["node_modules/@bitwarden/sdk-napi-linux-x64-gnu", "1.0.0"],
]);
const allowedByName = new Map([
  ["@bitwarden/sdk-napi", "1.0.0"],
  ["@bitwarden/sdk-napi-linux-x64-gnu", "1.0.0"],
]);
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path) continue;
  const name = entry.name ?? path.replace(/^node_modules\//, "");
  if (name.toLowerCase().includes("bitwarden")) {
    if (!allowed.has(path) || entry.version !== allowed.get(path)) throw new Error(`Disallowed Bitwarden dependency: ${path}`);
    allowed.delete(path);
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [dependencyName, version] of Object.entries(entry[field] ?? {})) {
      if (dependencyName.toLowerCase().includes("bitwarden") && allowedByName.get(dependencyName) !== version) {
        throw new Error(`Disallowed Bitwarden ${field} entry: ${dependencyName}@${version}`);
      }
    }
  }
}
if (allowed.size) throw new Error(`Missing pinned official dependency entries: ${[...allowed.keys()].join(", ")}`);
