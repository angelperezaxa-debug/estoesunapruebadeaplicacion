import type { Plugin } from "vite";

/**
 * Vite plugin guard: hard-fails the build (and dev server) the moment any
 * module tries to resolve `@tanstack/react-start*` or `@tanstack/start-*`.
 *
 * This project runs on Vite + react-router-dom v7. The TanStack Start
 * runtime is incompatible with our SSR-less setup and would explode at
 * runtime if it ever sneaked in (e.g. as a transitive dependency or a
 * stale template file). The guard fires during `resolveId`, so it catches
 * imports before they reach the bundler — both in `vite dev` and `vite build`.
 */
export function forbidTanstackStart(): Plugin {
  const FORBIDDEN = /^@tanstack\/(react-start|start-[a-z-]+)(\/|$)/;
  const isForbidden = (id: string) => FORBIDDEN.test(id);

  return {
    name: "forbid-tanstack-start",
    enforce: "pre",
    resolveId(source, importer) {
      if (!isForbidden(source)) return null;
      const where = importer ? ` (imported from ${importer})` : "";
      throw new Error(
        `[forbid-tanstack-start] "${source}" is not allowed in this project${where}.\n` +
          `This app runs on Vite + react-router-dom v7. Remove the import or dependency.`,
      );
    },
    load(id) {
      // Defence in depth: if a plugin earlier in the chain resolved it,
      // refuse to load the module.
      if (isForbidden(id)) {
        throw new Error(
          `[forbid-tanstack-start] Refusing to load "${id}". TanStack Start is banned.`,
        );
      }
      return null;
    },
  };
}
