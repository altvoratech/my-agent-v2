import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'web/client/**/*.test.ts', 'web/server/**/*.test.ts'],
  },
});
