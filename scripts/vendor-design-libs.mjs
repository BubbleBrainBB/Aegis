// Vendors the libraries design projects load from pinned CDN URLs, so the
// local project server can answer those URLs offline. The prompt tells agents
// to use exact <script> tags with integrity hashes; the bytes served must be
// the published npm files, so each one is checked against that hash before it
// is written (gzipped) to src/electron/design/project/libs.
//
//   node scripts/vendor-design-libs.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN_PROJECT_LIBRARIES = JSON.parse(readFileSync(join(root, "src/shared/design-project-libraries.json"), "utf8"));
const out = join(root, "src/electron/design/project/libs");
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "aegis-design-libs-"));
try {
  for (const lib of DESIGN_PROJECT_LIBRARIES) {
    const dir = join(work, lib.file);
    mkdirSync(dir, { recursive: true });
    const tarball = execFileSync("npm", ["pack", "--silent", `${lib.package}@${lib.version}`], { cwd: dir, encoding: "utf8" }).trim();
    execFileSync("tar", ["-xzf", tarball], { cwd: dir });
    const bytes = readFileSync(join(dir, "package", lib.path));
    const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
    if (integrity !== lib.integrity) throw new Error(`${lib.package}@${lib.version}/${lib.path}: ${integrity} does not match ${lib.integrity}`);
    writeFileSync(join(out, `${lib.file}.gz`), gzipSync(bytes, { level: 9 }));
    copyFileSync(join(dir, "package", "LICENSE"), join(out, `${lib.file}.LICENSE`));
    console.log(`${lib.file}: ${(bytes.length / 1024).toFixed(0)} KB, integrity ok`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
