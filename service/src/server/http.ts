import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import type * as http from "http";
import * as path from "path";
import { pipeline } from "stream";
import * as zlib from "zlib";
import type { Auth } from "./auth";
import { NotRegularFile, readFileView, resolveFilePath } from "../repo/files";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".bmp": "image/bmp",
};

const GZIP_EXTS = new Set([".js", ".css", ".html", ".json", ".svg", ".webmanifest"]);

// Everything that is not the WebSocket: login, the app bundle, uploads,
// file previews and layout debug snapshots.
export class HttpHandler {
  // Pre-compressed static assets (the JS bundle is ~600 KB raw; gzip is
  // roughly a quarter of that). Cached by path + mtime.
  private gzipCache = new Map<string, { mtimeMs: number; data: Buffer }>();
  private cachedBuildId: string | null = null;

  constructor(
    private auth: Auth,
    private webDir: string,
    private uploadsDir: string,
    private baseDir: string,
    // A workspace's folder, for file paths relative to it.
    private cwdOf: (workspaceId: string) => string | undefined = () => undefined,
  ) {}

  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Normalised before the auth check: "/icons/..%2findex.html" must not
      // count as a public icon.
      const pathname = path.posix.normalize(decodeURIComponent(url.pathname));

      if (this.auth.enabled) {
        if (pathname === "/login") {
          this.auth.handleLogin(req, res);
          return;
        }
        // Install metadata must be fetchable without a session: iOS reads the
        // manifest and icons when adding to the home screen.
        const publicAsset = pathname === "/manifest.webmanifest" || pathname.startsWith("/icons/");
        if (!publicAsset && !this.auth.isAuthenticated(req)) {
          res.statusCode = 302;
          res.setHeader("Location", "login");
          res.end();
          return;
        }
      }

      if (req.method === "POST" && pathname === "/debug/snapshot") {
        this.handleSnapshot(req, res);
        return;
      }

      if (req.method === "GET" && (pathname === "/api/file" || pathname === "/api/file/raw")) {
        this.handleFile(url, pathname === "/api/file/raw", res);
        return;
      }

      if (req.method === "POST" && pathname === "/upload") {
        this.handleUpload(req, res);
        return;
      }

      if (pathname.startsWith("/uploads/")) {
        const target = path.normalize(
          path.join(this.uploadsDir, pathname.slice("/uploads/".length)),
        );
        if (!target.startsWith(this.uploadsDir + path.sep) && target !== this.uploadsDir) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const ext = path.extname(target);
        res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        // Uploaded .html/.svg would otherwise run script on the app's origin.
        res.setHeader("Content-Security-Policy", "sandbox");
        res.setHeader("X-Content-Type-Options", "nosniff");
        pipeline(fs.createReadStream(target), res, () => {});
        return;
      }

      let filePath = pathname;
      if (filePath === "/") filePath = "/index.html";
      const target = path.normalize(path.join(this.webDir, filePath));
      if (!target.startsWith(this.webDir + path.sep) && target !== this.webDir) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const ext = path.extname(target);
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      // Everything under assets/ is content-hashed by Vite (JS, CSS, fonts).
      if (pathname.startsWith("/assets/")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (pathname.startsWith("/avatars/") || pathname.startsWith("/icons/")) {
        // Not content-hashed, so not immutable; a day spares the home-screen
        // app a re-download on every cold start.
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
      const gz = this.gzipped(target, ext, req.headers["accept-encoding"]);
      if (gz) {
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Vary", "Accept-Encoding");
        res.end(gz);
        return;
      }
      pipeline(fs.createReadStream(target), res, () => {});
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  }

  // Identifies the served bundle; a client that reconnects and sees a
  // different id reloads itself (home-screen apps never reload on their own).
  buildId(): string {
    if (this.cachedBuildId) return this.cachedBuildId;
    try {
      const html = fs.readFileSync(path.join(this.webDir, "index.html"), "utf-8");
      this.cachedBuildId = crypto.createHash("sha1").update(html).digest("hex").slice(0, 12);
    } catch {
      this.cachedBuildId = String(process.pid);
    }
    return this.cachedBuildId;
  }

  // File preview: a view (listing, text, or what kind of file it is) as JSON,
  // or the raw bytes for images and downloads. Relative paths are resolved
  // against the workspace directory.
  private handleFile(url: URL, raw: boolean, res: http.ServerResponse): void {
    const input = url.searchParams.get("path") ?? "";
    const cwd = this.cwdOf(url.searchParams.get("ws") ?? "") ?? os.homedir();
    const abs = resolveFilePath(cwd, input || ".");
    const fail = (e: unknown) => {
      const code = (e as NodeJS.ErrnoException).code;
      const [status, error] =
        e instanceof NotRegularFile
          ? [400, e.message]
          : code === "ENOENT" || code === "ENOTDIR"
            ? [404, "No such file or directory"]
            : code === "EACCES" || code === "EPERM"
              ? [403, "Permission denied"]
              : [500, e instanceof Error ? e.message : String(e)];
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error, path: abs }));
    };
    if (raw) {
      this.sendRaw(abs, res, fail);
      return;
    }
    readFileView(abs).then((view) => {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(view));
    }, fail);
  }

  // Headers go out only once the file is open, so an unreadable file is
  // still an error response; a cancelled download closes the file.
  private sendRaw(abs: string, res: http.ServerResponse, fail: (e: unknown) => void): void {
    fs.promises.stat(abs).then((stat) => {
      if (!stat.isFile()) return fail(new NotRegularFile());
      const stream = fs.createReadStream(abs);
      stream.once("error", (e) => {
        if (!res.headersSent) fail(e);
      });
      stream.once("open", () => {
        const ext = path.extname(abs).toLowerCase();
        res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
        // A previewed .html/.svg must not run script on the app's origin; a
        // sandboxed PDF would not render at all.
        if (ext !== ".pdf") res.setHeader("Content-Security-Policy", "sandbox");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-store");
        const name = encodeURIComponent(path.basename(abs));
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${name}`);
        pipeline(stream, res, () => {});
      });
    }, fail);
  }

  private handleUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    const MAX_UPLOAD = 50 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        res.statusCode = 413;
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const rawName = (req.headers["x-filename"] as string) || "image.jpg";
      const ext = path.extname(rawName) || ".jpg";
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = path.join(this.uploadsDir, filename);
      fs.writeFileSync(filePath, buffer);
      console.log(`[upload] saved ${rawName} → ${filename} (${buffer.length} bytes)`);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(JSON.stringify({ url: `uploads/${filename}`, name: rawName }));
    });
  }

  // Layout debug snapshots from the webview (see debugSnapshot.ts) land in
  // .agent-team/debug/ so they can be inspected with the repo tools.
  private handleSnapshot(req: http.IncomingMessage, res: http.ServerResponse): void {
    const MAX = 8 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        res.statusCode = 413;
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const dir = path.join(this.baseDir, ".agent-team", "debug");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `snapshot-${stamp}.json`);
      fs.writeFileSync(file, Buffer.concat(chunks));
      const rel = path.relative(this.baseDir, file);
      console.log(`[debug] snapshot saved ${rel} (${size} bytes)`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ path: rel }));
    });
  }

  private gzipped(
    file: string,
    ext: string,
    acceptEncoding: string | string[] | undefined,
  ): Buffer | null {
    if (!GZIP_EXTS.has(ext)) return null;
    const accept = Array.isArray(acceptEncoding)
      ? acceptEncoding.join(",")
      : (acceptEncoding ?? "");
    if (!/\bgzip\b/.test(accept)) return null;
    const mtimeMs = fs.statSync(file).mtimeMs;
    const cached = this.gzipCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.data;
    const data = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
    this.gzipCache.set(file, { mtimeMs, data });
    return data;
  }
}
