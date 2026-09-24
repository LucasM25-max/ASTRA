/**
 * A small static file server for the app -- no dependencies, correct MIME
 * types, no caching while developing.
 *
 *   npm run dev            # http://localhost:5173
 *   PORT=8080 npm run dev
 *
 * It serves the repository root, which is also what the deploy publishes: the
 * same tree, at the same paths, locally and in production. tools/check_deploy.mjs
 * imports createStaticServer() to fetch every URL the browser will ask for.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(join(here, ".."));

export const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** A server that serves `base` as a static site root, exactly like production. */
export function createStaticServer(base = root, { onMiss = () => {} } = {}) {
  const site = resolve(base);

  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";

    const target = resolve(join(site, normalize(path)));
    if (!target.startsWith(site)) {                    // never leave the site
      res.writeHead(403).end("forbidden");
      return;
    }

    try {
      const info = await stat(target);
      if (info.isDirectory()) throw new Error("directory");
      res.writeHead(200, {
        "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-store",
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      onMiss(path);
    }
  });
}

/* `npm run dev` -- but importing this module starts nothing. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 5173);
  const host = process.env.HOST ?? "0.0.0.0";

  createStaticServer(root, { onMiss: (path) => console.log(`  404 ${path}`) })
    .listen(port, host, () => {
      console.log(`ASTRA  http://localhost:${port}  (serving ${root})`);
      console.log("WASD move   Shift sprint   Space jump   drag to orbit");
    });
}
