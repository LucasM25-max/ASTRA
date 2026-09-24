/**
 * Copy the pieces of three.js the app uses into vendor/three, so the site can
 * be served straight from the repository with no bundler and no npm install.
 *
 *   npm install && npm run vendor
 *
 * vendor/three/three.module.js
 * vendor/three/three.core.js            (three.module.js imports it)
 * vendor/three/addons/loaders/GLTFLoader.js
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "three");
const to = join(root, "vendor", "three");

const files = [
  ["build/three.module.js", "three.module.js"],
  ["build/three.core.js", "three.core.js"],
  ["examples/jsm/loaders/GLTFLoader.js", "addons/loaders/GLTFLoader.js"],
];

const version = JSON.parse(await readFile(join(from, "package.json"), "utf8")).version;

for (const [src, dst] of files) {
  const target = join(to, dst);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(from, src), target);
  console.log(`[vendor] three@${version} ${dst}`);
}

await writeFile(
  join(to, "VERSION"),
  `three@${version}\ncopied from node_modules by tools/vendor_three.mjs -- do not edit\n`,
);
console.log(`[vendor] done -- three@${version} vendored into vendor/three`);
