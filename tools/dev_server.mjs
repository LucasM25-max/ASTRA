/**
 * A small static file server for the app -- no dependencies, correct MIME
 * types, no caching while developing.
 *
 *   npm run dev            # http://localhost:5173
 *   PORT=8080 npm run dev
 *
 * Any static server works just as well (the app is plain ES modules); this one
 * exists so the repository needs no build step at all.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? "0.0.0.0";

const TYPES = {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";

  const target = resolve(join(root, normalize(path)));
  if (!target.startsWith(root)) {                      // never leave the repo
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
    console.log(`  404 ${path}`);
  }
});

server.listen(port, host, () => {
  console.log(`ASTRA  http://localhost:${port}  (serving ${root})`);
  console.log("WASD move   Shift sprint   Space jump   drag to orbit");
});
