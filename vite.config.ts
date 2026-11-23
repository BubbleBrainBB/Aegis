import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';

// Electron runs modern Chromium, which supports woff2 natively. Strip legacy
// .woff and .ttf fallbacks from katex.min.css so Vite does not emit 40
// redundant font files (~800 KB) into dist-react/assets/.
function stripLegacyKatexFonts(): Plugin {
  return {
    name: 'strip-legacy-katex-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('katex') || !id.endsWith('.css')) return null;
      const next = code.replace(
        /url\([^)]+\.woff2\)\s*format\(["']?woff2["']?\)\s*,\s*url\([^)]+\.woff\)\s*format\(["']?woff["']?\)\s*,\s*url\([^)]+\.ttf\)\s*format\(["']?truetype["']?\)/g,
        (match) => match.slice(0, match.indexOf(',')),
      );
      return next === code ? null : { code: next, map: null };
    },
  };
}

export default defineConfig({
  plugins: [stripLegacyKatexFonts(), react(), tailwindcss(), tsconfigPaths()],
  server: {
    host: '127.0.0.1',
    port: parseInt(process.env.PORT || '10087'),
    strictPort: true,
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) {
            return 'vendor-react';
          }
          if (id.includes('/node_modules/@xterm/')) {
            return 'vendor-xterm';
          }
          if (id.includes('/node_modules/@codemirror/') || id.includes('/node_modules/@lezer/')) {
            return 'vendor-codemirror';
          }
          if (id.includes('/node_modules/@pierre/diffs')) {
            return 'vendor-pierre-diffs';
          }
          if (id.includes('/node_modules/@shikijs/core') || id.includes('/node_modules/@shikijs/engine-')) {
            return 'vendor-shiki';
          }
          if (id.includes('/node_modules/katex/')) {
            return 'vendor-katex';
          }
          if (id.includes('/node_modules/motion/') || id.includes('/node_modules/framer-motion/') || id.includes('/node_modules/motion-dom/')) {
            return 'vendor-motion';
          }
          return undefined;
        },
      },
    },
  },
  base: './',
});
