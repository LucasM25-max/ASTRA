/**
 * A tiny ES module dependency walker -- shared by tools/vendor_three.mjs (which
 * copies the three.js files the app imports) and tools/check_deploy.mjs (which
 * proves the repository, served as-is, satisfies every import the browser will
 * make).
 *
 * It understands exactly what the browser does for this project:
 *
 *   "./x.js"                 resolved against the importing file
 *   "three"                  resolved through the import map in index.html
 *   "three/addons/..."       resolved through the import map's prefix entry
 *   anything else bare       NOT resolvable -- a 404 in the browser, not a
 *                            warning, so both tools treat it as an error
 *
 * The walker is deliberately string-based rather than a parser: it only needs
 * the import statements, and it must run on the vendored three.js bundles
 * (2 MB of source) without adding a dependency.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

/* Matches a static `import ... from "x"` (possibly spread over several lines),
   a side-effect `import "x"` and a dynamic `import("x")`. */
const STATEMENT = /^[ \t]*import\s*(?:[^;"']*?\bfrom\s*[\s]*)?\(?\s*["']([^"'"\n]+)["']/gm;

/**
 * Every specifier `source` imports, as written; duplicates removed.
 *
 * Comment lines are dropped first, because three.js documents its own imports
 * in prose (`@three_import import { GLTFLoader } from 'three/addons/...'`)
 * and a walker that reads those would chase files nobody loads.
 */
export function specifiersOf(source) {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  const found = new Set();
  for (const match of code.matchAll(STATEMENT)) found.add(match[1]);
  return [...found];
}

/** The import map of an HTML page, as `{ "three": "./vendor/..." , ... }`. */
export function importMapOf(html) {
  const block = html.match(/<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!block) return {};
  const parsed = JSON.parse(block[1]);
  return parsed.imports ?? {};
}

/** Repo-relative (posix) path for a specifier, or why it cannot resolve. */
export function resolveSpecifier(specifier, importer, imports) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith("//")) {
    return { external: specifier };                       // http:, data:, ...
  }

  if (specifier.startsWith(".")) {
    return { path: posix.normalize(posix.join(posix.dirname(importer), specifier)) };
  }
  if (specifier.startsWith("/")) {
    return { path: specifier.slice(1) };                  // site-absolute
  }

  const exact = imports[specifier];
  if (exact) return { path: strip(exact) };

  // longest matching prefix entry, e.g. "three/addons/" -> "./vendor/three/addons/"
  let best = null;
  for (const key of Object.keys(imports)) {
    if (!key.endsWith("/") || !specifier.startsWith(key)) continue;
    if (!best || key.length > best.length) best = key;
  }
  if (best) return { path: strip(posix.join(imports[best], specifier.slice(best.length))) };

  return { unmapped: specifier };
}

function strip(specifier) {
  return posix.normalize(specifier.replace(/^\.\//, "").replace(/^\.\.\//, "../"));
}

/**
 * Follow `entries` (repo-relative paths) and everything they import.
 *
 * Returns `{ modules, missing }`:
 *   modules  Map(relative path -> specifiers it imports, as written)
 *   missing  [{ from, specifier, reason }] for imports that cannot resolve to
 *            a file in `root`
 */
export async function walkModuleGraph({ root, entries, imports = {} }) {
  const modules = new Map();
  const missing = [];
  const queue = [...entries];

  while (queue.length) {
    const file = queue.shift();
    if (modules.has(file)) continue;

    let source;
    try {
      source = await readFile(join(root, file), "utf8");
    } catch {
      missing.push({ from: null, specifier: file, reason: "does not exist" });
      continue;
    }

    const specifiers = specifiersOf(source);
    modules.set(file, specifiers);

    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(specifier, file, imports);

      if (resolved.unmapped) {
        missing.push({ from: file, specifier, reason: "not in the import map" });
      } else if (resolved.external) {
        continue;                                          // not ours to serve
      } else if (!isFile(join(root, resolved.path))) {
        missing.push({ from: file, specifier, reason: `no such file: ${resolved.path}` });
      } else {
        queue.push(resolved.path);
      }
    }
  }

  return { modules, missing };
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

export { dirname, join, resolve };
