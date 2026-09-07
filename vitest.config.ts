import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  // The app targets the automatic JSX runtime (Next); component tests render
  // .tsx server components, so keep vitest's esbuild transform aligned
  // instead of the classic runtime tsconfig `jsx: preserve` implies.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
