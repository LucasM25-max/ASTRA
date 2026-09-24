/**
 * Copy the pieces of three.js the app uses into vendor/three, so the site can
 * be served straight from the repository with no bundler and no npm install.
 *
 *   npm install && npm run vendor
 *
 * vendor/three/three.module.js                 build/three.module.js
 * vendor/three/three.core.js                   build/three.core.js (imported by it)
 * vendor/three/addons/...                      the closure of addon imports
 *
 * The addon list is not written by hand: GLTFLoader imports its own helpers
 * ('../utils/BufferGeometryUtils.js', '../utils/SkeletonUtils.js'), and shipping
 * the loader without them is a module the browser cannot resolve -- the page
 * stays blank because main.js never runs. So the entries below are walked with
 * tools/module_graph.mjs, and every import they reach is copied too.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSpecifier, specifiersOf } from "./module_graph.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "three");
const to = join(root, "vendor", "three");

/** Build files, copied verbatim. */
const BUILD = [
  ["build/three.module.js", "three.module.js"],
  ["build/three.core.js", "three.core.js"],
];

/** Addon entry points the app imports (see the import map in index.html). */
const ADDONS = ["loaders/GLTFLoader.js"];

const version = JSON.parse(await readFile(join(from, "package.json"), "utf8")).version;

/* Everything copied out of the package: [source path, destination path]. */
const copies = [...BUILD];

for (const entry of ADDONS) {
  const queue = [entry];
  const seen = new Set();

  while (queue.length) {
    const addon = queue.shift();
    if (seen.has(addon)) continue;
    seen.add(addon);

    const source = join(from, "examples/jsm", addon);
    copies.push([join("examples/jsm", addon), posix.join("addons", addon)]);

    for (const specifier of specifiersOf(await readFile(source, "utf8"))) {
      // Addons may only import 'three' (mapped by index.html) or sibling files.
      const resolved = resolveSpecifier(specifier, posix.join("examples/jsm", addon), {});
      if (resolved.unmapped && specifier !== "three") {
        throw new Error(
          `${addon} imports ${JSON.stringify(specifier)}, which the import map ` +
          `does not resolve -- the browser would fail to load it`);
      }
      if (resolved.path) queue.push(posix.relative("examples/jsm", resolved.path));
    }
  }
}

await rm(to, { recursive: true, force: true });

for (const [source, destination] of copies) {
  const target = join(to, destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(from, source), target);
  console.log(`[vendor] three@${version} ${destination}`);
}

await writeFile(
  join(to, "VERSION"),
  `three@${version}\ncopied from node_modules by tools/vendor_three.mjs -- do not edit\n`,
);
console.log(`[vendor] done -- three@${version} vendored into vendor/three (${copies.length} files)`);
