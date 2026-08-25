import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@shared': r('./src/shared'),
      '@converters': r('./src/converters'),
      '@runtime': r('./src/runtime'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Vitest 4: `maxWorkers` replaced maxThreads/maxForks; `poolOptions` is gone.
    maxWorkers: 4,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/converters/**', 'src/runtime/**'],
      thresholds: { lines: 70, functions: 70 },
    },
  },
});
