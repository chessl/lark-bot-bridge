import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: false,
  splitting: false,
  dts: false,
  // Inline the Vite-built console (src/ui/generated/index.html) as a string.
  esbuildOptions(options) {
    options.loader = { ...options.loader, '.html': 'text' };
  },
});
