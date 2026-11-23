// Copies only the 3 minified widget chart bundles served by aegis-widget://lib/*
// into dist-electron/electron/widget-libs/ so packaged builds do not need to ship
// the full echarts / chart.js / d3 packages (~67 MB) inside app.asar/node_modules.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-electron/electron/widget-libs');
mkdirSync(outDir, { recursive: true });

const libs = [
  ['node_modules/chart.js/dist/chart.umd.min.js', 'chart.umd.min.js'],
  ['node_modules/d3/dist/d3.min.js', 'd3.min.js'],
  ['node_modules/echarts/dist/echarts.min.js', 'echarts.min.js'],
];

let totalBytes = 0;
for (const [srcRel, destName] of libs) {
  const src = join(root, srcRel);
  const dest = join(outDir, destName);
  copyFileSync(src, dest);
  totalBytes += statSync(dest).size;
}

console.log(`widget libs: ${libs.length} files (${(totalBytes / 1024).toFixed(0)} KB)`);
