#!/usr/bin/env node
/**
 * Sync `src/game/*.ts` → `supabase/functions/rooms-rpc/_shared/*.ts`.
 *
 * The Edge Function `rooms-rpc` MUST run the exact same engine, bot logic and
 * timings as the offline (solo-vs-bots) client. To avoid divergence we keep
 * one canonical source under `src/game/` and replicate the relevant modules
 * into the function's `_shared/` folder. Deno requires explicit `.ts`
 * extensions on relative imports, so this script rewrites them on copy.
 *
 * The set of files mirrored is exactly the one validated by
 * `src/test/parity/sharedSourceParity.test.ts`. Files that exist only on the
 * client (React hooks, browser-only helpers, *.test.ts) are NOT copied.
 *
 * Usage:
 *   bun run sync:shared           → copy all mirrored files
 *   bun run sync:shared --check   → exit 1 if any file would change
 *   bun run sync:shared --watch   → re-sync on every change to src/game/*
 *
 * The sync is one-way (client → server). Editing a file inside `_shared/`
 * directly is discouraged: the next sync will overwrite it.
 */
import { readFileSync, writeFileSync, watch, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src/game");
const DST_DIR = path.join(ROOT, "supabase/functions/rooms-rpc/_shared");

/**
 * Modules that are mirrored client → server. Must stay in sync with the list
 * in `src/test/parity/sharedSourceParity.test.ts`. Anything not listed here
 * is treated as client-only (React hooks, animations, debug UI helpers, etc.)
 * and intentionally NOT copied.
 */
const FILES = [
  "bot.ts",
  "botConsult.ts",
  
  "chatTimings.ts",
  "deck.ts",
  "engine.ts",
  "phrases.ts",
  "playerIntents.ts",
  "profileAdaptation.ts",
  "types.ts",
];

const HEADER = [
  "// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.",
  "// Source: src/game/<name>.ts (mirrored by scripts/syncSharedGame.mjs).",
  "// Run `bun run sync:shared` from the repo root to refresh.",
  "",
  "",
].join("\n");

/**
 * Rewrite relative import specifiers so Deno can resolve them:
 *   from "./types"        → from "./types.ts"
 *   from "../game/types"  → from "../game/types.ts"
 * Bare specifiers and existing `.ts` / `.json` extensions are left alone.
 */
function rewriteImportsForDeno(src) {
  const replacer = (full, q1, spec, q2) => {
    if (q1 !== q2) return full;
    // Only relative imports (./ or ../). Bare specifiers stay as-is.
    if (!spec.startsWith("./") && !spec.startsWith("../")) return full;
    // Already has an extension we keep verbatim.
    if (/\.(ts|tsx|js|mjs|json)$/.test(spec)) return full;
    return `${full.slice(0, full.indexOf(q1))}${q1}${spec}.ts${q2}`;
  };
  let out = src.replace(
    /\bfrom\s+(['"])([^'"]+)(['"])/g,
    replacer,
  );
  // Dynamic imports: import("...")
  out = out.replace(
    /\bimport\(\s*(['"])([^'"]+)(['"])\s*\)/g,
    (full, q1, spec, q2) => {
      if (q1 !== q2) return full;
      if (!spec.startsWith("./") && !spec.startsWith("../")) return full;
      if (/\.(ts|tsx|js|mjs|json)$/.test(spec)) return full;
      return `import(${q1}${spec}.ts${q2})`;
    },
  );
  // export ... from "..."
  out = out.replace(
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+(['"])([^'"]+)(['"])/g,
    (full, q1, spec, q2) => {
      if (q1 !== q2) return full;
      if (!spec.startsWith("./") && !spec.startsWith("../")) return full;
      if (/\.(ts|tsx|js|mjs|json)$/.test(spec)) return full;
      return full.replace(`${q1}${spec}${q2}`, `${q1}${spec}.ts${q2}`);
    },
  );
  return out;
}

function buildShared(name, srcText) {
  const banner = HEADER.replace("<name>", name.replace(/\.ts$/, ""));
  return banner + rewriteImportsForDeno(srcText);
}

function syncOne(name, { check }) {
  const srcPath = path.join(SRC_DIR, name);
  const dstPath = path.join(DST_DIR, name);
  if (!existsSync(srcPath)) {
    throw new Error(`Source missing: ${srcPath}`);
  }
  const src = readFileSync(srcPath, "utf8");
  const next = buildShared(name, src);
  const prev = existsSync(dstPath) ? readFileSync(dstPath, "utf8") : "";
  if (prev === next) return { name, changed: false };
  if (check) return { name, changed: true };
  mkdirSync(path.dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, next, "utf8");
  return { name, changed: true };
}

function syncAll(opts = {}) {
  const results = FILES.map((f) => syncOne(f, opts));
  const changed = results.filter((r) => r.changed);
  return { results, changed };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const watchMode = args.has("--watch");

  if (watchMode) {
    console.log(`[sync:shared] watching ${SRC_DIR} …`);
    // Initial sync
    const { changed } = syncAll({ check: false });
    if (changed.length) {
      console.log(`[sync:shared] initial sync: ${changed.map((r) => r.name).join(", ")}`);
    } else {
      console.log("[sync:shared] initial sync: already up-to-date");
    }
    let debounce = null;
    watch(SRC_DIR, { persistent: true }, (_event, filename) => {
      if (!filename || !FILES.includes(filename)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          const r = syncOne(filename, { check: false });
          if (r.changed) console.log(`[sync:shared] ${filename} → _shared/`);
        } catch (e) {
          console.error(`[sync:shared] error syncing ${filename}:`, e);
        }
      }, 50);
    });
    return;
  }

  const { changed } = syncAll({ check });
  if (check) {
    if (changed.length) {
      console.error(
        `[sync:shared] OUT OF SYNC (${changed.length} file(s)):\n  - ` +
          changed.map((r) => r.name).join("\n  - ") +
          `\nRun \`bun run sync:shared\` to fix.`,
      );
      process.exit(1);
    }
    console.log("[sync:shared] OK — all mirrored files are up-to-date.");
    return;
  }
  if (changed.length === 0) {
    console.log("[sync:shared] no changes (everything already up-to-date).");
  } else {
    console.log(
      `[sync:shared] updated ${changed.length} file(s):\n  - ` +
        changed.map((r) => r.name).join("\n  - "),
    );
  }
}

main();
