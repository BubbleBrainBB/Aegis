// Assets the design canvas's main process reads, written next to it:
// - the icon library: Tabler Icons (MIT, already a dependency through
//   @tabler/icons-react), compacted to name → path data plus search terms.
//   Boards write <aegis-icon name="…">, expanded to inline SVG when saved.
// - the built-in styles' fonts (OFL, src/electron/design/fonts).
// - design projects' libraries, prompts and starter components
//   (src/electron/design/project).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules/@tabler/icons");
const read = (file) => JSON.parse(readFileSync(join(pkg, file), "utf8"));
const outline = read("tabler-nodes-outline.json");
const filled = read("tabler-nodes-filled.json");
const meta = read("icons.json");
const paths = (nodes) => nodes.filter(([tag]) => tag === "path").map(([, attrs]) => attrs.d);
const icons = {};
for (const [name, nodes] of Object.entries(outline)) {
  const m = meta[name];
  icons[name] = {
    o: paths(nodes),
    ...(filled[name] ? { f: paths(filled[name]) } : {}),
    s: [m?.category ?? "", ...(m?.tags ?? [])].filter(Boolean).join(" ").toLowerCase(),
  };
}
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const out = join(root, "dist-electron/electron/design/icons.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ source: `@tabler/icons ${version} (MIT)`, icons }));
cpSync(join(root, "src/electron/design/fonts"), join(root, "dist-electron/electron/design/fonts"), { recursive: true });
// Design projects: the pinned libraries their pages load, the prompt and
// skills, and the starter components agents copy in.
for (const dir of ["libs", "prompts", "starters"])
  cpSync(join(root, "src/electron/design/project", dir), join(root, "dist-electron/electron/design/project", dir), { recursive: true });
console.log(`design assets: ${Object.keys(icons).length} icons (${(JSON.stringify(icons).length / 1024).toFixed(0)} KB), fonts`);
