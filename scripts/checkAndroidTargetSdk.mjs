#!/usr/bin/env node
// Verifica que el wrapper Android (Capacitor o Bubblewrap/TWA) tinga
// targetSdkVersion >= 34. Pensat per executar-lo contra una carpeta
// EXTERNA al repo web.
//
// Ús:
//   node scripts/checkAndroidTargetSdk.mjs <ruta-al-projecte-android>
//
// Cerca, en aquest ordre:
//   <ruta>/android/variables.gradle   (Capacitor)
//   <ruta>/app/build.gradle           (Bubblewrap/TWA)
//   <ruta>/build.gradle               (variant amb arrel diferent)
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const MIN_REQUIRED = 34;
const target = process.argv[2];

if (!target) {
  console.error("Ús: node scripts/checkAndroidTargetSdk.mjs <ruta-android>");
  process.exit(2);
}

const root = resolve(target);
const candidates = [
  join(root, "android", "variables.gradle"),
  join(root, "app", "build.gradle"),
  join(root, "build.gradle"),
];

const file = candidates.find((p) => existsSync(p));
if (!file) {
  console.error(`No s'ha trobat cap gradle dins de ${root}.`);
  console.error("Esperava un d'aquests:\n  - " + candidates.join("\n  - "));
  process.exit(2);
}

const src = readFileSync(file, "utf8");
const m = src.match(/targetSdkVersion\s*=?\s*(\d+)/);
if (!m) {
  console.error(`No s'ha trobat 'targetSdkVersion' a ${file}.`);
  process.exit(2);
}

const value = Number(m[1]);
if (value < MIN_REQUIRED) {
  console.error(
    `❌ targetSdkVersion=${value} a ${file}. Cal ${MIN_REQUIRED} o superior per a Google Play.`,
  );
  process.exit(1);
}

console.log(`✅ targetSdkVersion=${value} a ${file} (>= ${MIN_REQUIRED}).`);
