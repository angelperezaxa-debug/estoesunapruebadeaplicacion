import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { spawn } from "child_process";

/**
 * Vite plugin: keeps `supabase/functions/rooms-rpc/_shared/*` in sync with
 * `src/game/*`. Runs once on startup and re-runs whenever a file under
 * `src/game/` changes during dev. This is what guarantees that the edge
 * function and the offline (solo-vs-bots) client always run the EXACT
 * same engine, bot logic, timings and types.
 *
 * `src/game/` is the single source of truth. Files in `_shared/` are
 * generated and must never be edited by hand.
 */
function syncSharedGamePlugin() {
  const runSync = (extraArgs: string[] = []) =>
    new Promise<void>((resolve) => {
      const child = spawn(
        "node",
        ["scripts/syncSharedGame.mjs", ...extraArgs],
        { stdio: "inherit" },
      );
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  let didInitialSync = false;
  return {
    name: "sync-shared-game",
    async buildStart() {
      if (didInitialSync) return;
      didInitialSync = true;
      await runSync();
    },
    configureServer(server: { watcher: { on: (e: string, cb: (p: string) => void) => void } }) {
      const trigger = (file: string) => {
        if (file.includes(`${path.sep}src${path.sep}game${path.sep}`)) {
          runSync();
        }
      };
      server.watcher.on("change", trigger);
      server.watcher.on("add", trigger);
      server.watcher.on("unlink", trigger);
    },
  };
}

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    syncSharedGamePlugin(),
    react(),
    mode === "development" && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
