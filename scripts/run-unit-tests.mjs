/**
 * Unit-Tests für reine Funktionen (W14, ohne Netz, ohne Produktion).
 *
 * Kompiliert die reinen Lib-Module mit dem Projekt-TypeScript nach
 * .tmp-unit und führt danach alle scripts/unit/*.test.mjs mit dem
 * eingebauten node:test-Läufer aus. Keine neue Abhängigkeit nötig.
 *
 * Start: npm run test:unit
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = path.join(root, ".tmp-unit");
const tsconfigPath = path.join(root, ".tmp-unit-tsconfig.json");

fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      baseUrl: root,
      paths: { "@/*": ["src/*"] },
      outDir: tmp,
      rootDir: "src",
      module: "commonjs",
      target: "es2020",
      moduleResolution: "node",
      skipLibCheck: true,
      strict: true,
      esModuleInterop: true,
    },
    include: [
      "src/lib/json-path.ts",
      "src/lib/validate.ts",
      "src/lib/slugify.ts",
      "src/lib/content-guard.ts",
      "src/lib/github.ts",
      "src/lib/history.ts",
      "src/lib/preview-url.ts",
    ],
  })
);

execSync(`npx tsc -p ${tsconfigPath}`, { cwd: root, stdio: "inherit" });

const testDir = path.join(here, "unit");
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => path.join(testDir, f))
  .sort();

if (files.length === 0) {
  console.error("Keine Unit-Tests in scripts/unit gefunden.");
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, UNIT_LIB: path.join(tmp, "lib") },
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tsconfigPath, { force: true });
process.exit(run.status ?? 1);
