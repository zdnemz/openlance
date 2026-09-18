/**
 * Codemod: @phosphor-icons/react barrel → per-icon CSR imports.
 * The barrel pulls ~3000 modules into the dev compile (OOM on a 4GB box);
 * per-icon imports compile only what's used.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = "/home/z/my-project/src";
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(extname(p))) files.push(p);
  }
}
walk(ROOT);

const RE = /import\s*\{([^}]*?)\}\s*from\s*["']@phosphor-icons\/react["'];?/gs;
let changed = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("@phosphor-icons/react")) continue;
  const out = src.replace(RE, (_m, names) => {
    const specs = names
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [orig, alias] = s.split(/\s+as\s+/).map((x) => x.trim());
        const importName = alias ? `${orig} as ${alias}` : orig;
        return `import { ${importName} } from "@phosphor-icons/react/dist/csr/${orig}";`;
      });
    return specs.join("\n");
  });
  if (out !== src) {
    writeFileSync(file, out);
    changed++;
    console.log(`rewrote ${file}`);
  }
}
console.log(`done — ${changed} files changed`);
