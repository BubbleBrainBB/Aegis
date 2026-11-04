import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';

// Set by scripts/run-tests.mjs when suites run at once. Each suite's server sees
// the whole repo, so it must not reload its page for another suite's temp files,
// wait for a port, or rebuild a dependency cache another suite is reading.
const testWorker = process.env.AEGIS_TEST_WORKER;

export default defineConfig({
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  ...(testWorker ? { cacheDir: `node_modules/.vite-worker-${testWorker}` } : {}),
  server: {
    host: '127.0.0.1',
    port: parseInt(process.env.PORT || '10087'),
    strictPort: !testWorker,
    ...(testWorker ? { hmr: false } : {}),
    watch: {
      // Design mode writes into dev-fixtures at runtime; Aegis's own dev
      // server must not react to those files (they have their own server).
      // Isolated-copy threads check a full worktree out under .worktrees/ —
      // its tsconfig.json alone makes Vite force a full-reload of the app.
      // Only this checkout's own: when the app runs from inside a worktree, its
      // absolute path holds .worktrees too, and every source file would be ignored.
      ignored: ['**/dev-fixtures/**', `${process.cwd()}/.worktrees/**`],
    },
  },
  optimizeDeps: {
    include: ['sonner'],
  },
  build: {
    outDir: 'dist-react',
    emptyOutDir: process.env.VITE_BUILD_WATCH !== '1',
  },
  base: './',
});
