#!/usr/bin/env node
/**
 * CI guard: assert that legacy/template artifacts are never reintroduced.
 *
 * Fails (exit 1) if any of the following is found in the repo:
 *  - `package-lock.json` at repo root (we use bun.lock).
 *  - `tsconfig.tsbuildinfo` anywhere outside node_modules/dist/.cache.
 *  - Any source/config reference to `@tanstack/react-start` or
 *    `@tanstack/start-*` packages — this project runs on Vite + react-router-dom v7.
 *  - Any leftover `src/integrations/supabase/auth-middleware.ts` or
 *    `src/integrations/supabase/client.server.ts` (TanStack Start templates
 *    that the harness occasionally re-creates).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const errors = [];

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".cache",
  ".git",
  ".vite",
  ".turbo",
  ".next",
  "build",
  "coverage",
  "scripts", // this guard itself mentions the forbidden strings
]);

// Files allowed to mention the forbidden strings (the guard tooling itself).
const IGNORED_FILES = new Set([
  "src/test/ci/noLegacyArtifacts.test.ts",
  "src/test/ci/forbidTanstackStartPlugin.test.ts",
]);

// --- 1) Forbidden files ------------------------------------------------------
const FORBIDDEN_FILES = [
  "package-lock.json",
  "tsconfig.tsbuildinfo",
  "src/integrations/supabase/auth-middleware.ts",
  "src/integrations/supabase/client.server.ts",
];
for (const rel of FORBIDDEN_FILES) {
  if (existsSync(join(ROOT, rel))) {
    errors.push(`Forbidden file present: ${rel}`);
  }
}

// --- 2) Recursive scan for tsconfig.tsbuildinfo + tanstack-start refs --------
const FORBIDDEN_TEXT_PATTERNS = [
  /@tanstack\/react-start\b/,
  /@tanstack\/start-[a-z-]+/,
];
const SCANNABLE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".yml", ".yaml", ".toml", ".html",
]);

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    const rel = relative(ROOT, full).split(sep).join("/");
    if (name === "tsconfig.tsbuildinfo") {
      errors.push(`Forbidden file present: ${rel}`);
      continue;
    }
    if (IGNORED_FILES.has(rel)) continue;
    const dot = name.lastIndexOf(".");
    const ext = dot === -1 ? "" : name.slice(dot);
    if (!SCANNABLE_EXT.has(ext)) continue;
    let content;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const pat of FORBIDDEN_TEXT_PATTERNS) {
      if (pat.test(content)) {
        errors.push(`Forbidden reference (${pat}) in ${rel}`);
        break;
      }
    }
  }
}

walk(ROOT);

if (errors.length > 0) {
  console.error("\n[check:no-legacy] FAILED — legacy/template artifacts detected:\n");
  for (const e of errors) console.error("  ✗ " + e);
  console.error(
    "\nRemove the offending files/references. This project is Vite + react-router-dom v7.\n",
  );
  process.exit(1);
}

console.log("[check:no-legacy] OK — no legacy artifacts or @tanstack/react-start references.");
