/**
 * Does the repository work as a *deployed site*? Not "does the server run" --
 * "is every URL the browser will ask for present in what gets published".
 *
 *   node tools/check_deploy.mjs
 *
 * The app is plain ES modules served from the repository root, so the whole
 * deploy is: a commit, and a static host that publishes the root. This tool
 * checks that story end to end, with no browser:
 *
 *   1. index.html is at the site root, because "/" serves it and nothing else
 *      (a "public/" directory makes Vercel publish *that* instead -- the exact
 *      misconfiguration that put a 404 on astra-ten-green.vercel.app).
 *   2. vercel.json pins the root as the output directory and asks for no build.
 *   3. The module graph actually resolves: index.html -> import map -> src ->
 *      vendored three.js -> GLTFLoader's own helpers. A single missing file
 *      stops main.js from running, and the page stays blank with no error a
 *      player could act on.
 *   4. The character asset sits where src/config.js says it does.
 *   5. Every one of those files is committed to git, so the deploy has it.
 *   6. Served over HTTP, each URL answers 200 with the right content type --
 *      modules must not come back as text/html, or the browser refuses them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { createStaticServer, TYPES } from "./dev_server.mjs";
import { importMapOf, walkModuleGraph } from "./module_graph.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `   ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const bytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/* ------------------------------------------------------------ the site root */

const html = await readFile(join(root, "index.html"), "utf8");
const imports = importMapOf(html);

check("index.html sits at the site root", existsSync(join(root, "index.html")),
  'so "/" has something to serve');

const scripts = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
check("the page loads its code as modules",
  scripts.length > 0 && scripts.every((src) => /\.m?js$/.test(src)),
  scripts.join(" "));

const urls = [...scripts, ...Object.values(imports)];
check("every URL the page uses is relative",
  urls.every((url) => url.startsWith("./") || url.startsWith("../")),
  "so a subpath deploy (GitHub Pages /repo) serves the same tree");

check("the import map names three.js and its addons",
  "three" in imports && Object.keys(imports).some((key) => key.endsWith("/")),
  Object.keys(imports).join(" "));

/* ----------------------------------------------------- what Vercel is told */

const vercel = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
const output = (vercel.outputDirectory ?? "").replace(/^\.\//, "").replace(/\/$/, "");

check("vercel.json publishes the repository root",
  output === "." || output === "",
  `outputDirectory: ${JSON.stringify(vercel.outputDirectory)}`);

check("vercel.json asks for no build step or framework",
  !vercel.buildCommand && vercel.framework == null,
  "the app is plain ES modules; nothing to compile");

check("no public/ directory to shadow the root",
  !existsSync(join(root, "public")),
  'Vercel\'s "Other" preset publishes public/ when it exists, ignoring index.html');

/* ------------------------------------------------------- the module graph */

const entries = [
  ...scripts.map((src) => posix.normalize(src.replace(/^\.\//, ""))),
  ...Object.values(imports).filter((value) => !value.endsWith("/"))
    .map((value) => posix.normalize(value.replace(/^\.\//, ""))),
];

const { modules, missing } = await walkModuleGraph({ root, entries, imports });

const vendorGap = missing.some(({ specifier }) => specifier.includes("addons/"));
check("every import in the graph resolves to a file", missing.length === 0,
  missing.slice(0, 4)
    .map(({ from, specifier, reason }) => `${from ?? "(entry)"} -> ${specifier}: ${reason}`)
    .join("; "));

check("the vendored three.js is the whole closure",
  !vendorGap,
  vendorGap ? "run: npm install && npm run vendor" : `${modules.size} modules`);

/* --------------------------------------------------------- the character */

const config = await import("../src/config.js");
const asset = config.ASSET;
check("the character asset is asked for by a relative URL",
  asset.startsWith("./"), asset);

const assetPath = posix.normalize(asset.replace(/^\.\//, ""));
check("the character asset exists where the page asks for it",
  existsSync(join(root, assetPath)) && statSync(join(root, assetPath)).isFile(),
  asset);

/* --------------------------------------------------- what git will publish */

let tracked = null;
try {
  tracked = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean));
} catch {
  console.log("  skip   git is unavailable, cannot check what a deploy would carry");
}

if (tracked) {
  const requested = ["index.html", assetPath, ...modules.keys()];
  const untracked = requested.filter((file) => !tracked.has(file));
  check("every file the browser asks for is committed",
    untracked.length === 0,
    untracked.join(" ") || `${requested.length} files`);
}

/* --------------------------------------------------------- served over HTTP */

const server = createStaticServer(root);
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;

const wanted = [
  ["/", 200, TYPES[".html"]],
  [`/${assetPath}`, 200, TYPES[".glb"]],
  ["/index.html", 200, TYPES[".html"]],
  ...entries.map((file) => [`/${file}`, 200, TYPES[".js"]]),
  ["/src/does-not-exist.js", 404, "text/plain; charset=utf-8"],
];

const served = [];
for (const [path, status, type] of wanted) {
  const response = await fetch(origin + path);
  const got = response.headers.get("content-type") ?? "";
  served.push({ path, ok: response.status === status && got.startsWith(type.split(";")[0]), status, got, status_wanted: status, type });

  // read the body: a module script that 200s with nothing in it is still broken
  const body = await response.arrayBuffer();
  if (status === 200 && body.byteLength === 0) served.at(-1).ok = false;
}

const bad = served.filter(({ ok }) => !ok);
check(`every URL the browser fetches answers correctly`, bad.length === 0,
  bad.slice(0, 4).map(({ path, status, got, status_wanted }) =>
    `${path} -> ${status} ${got} (wanted ${status_wanted})`).join("; "));

check("the module graph is not served as HTML",
  !served.some(({ path, got }) => path.endsWith(".js") && got.startsWith("text/html")),
  "a catch-all rewrite would break every module script");

await new Promise((done) => server.close(done));

/* ------------------------------------------------------------------ report */

const weight = [...modules.keys(), assetPath]
  .reduce((total, file) => total + statSync(join(root, file)).size, 0);

console.log(`\n${modules.size + 1} files served, ${bytes(weight)}: index.html, src, vendor/three, the character`);
console.log(failures.length ? `\n${failures.length} deploy check(s) failed` : "\nthe repository deploys as-is");
process.exit(failures.length ? 1 : 0);
