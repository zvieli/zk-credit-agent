import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify('http://127.0.0.1:3123'),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 900000,
    hookTimeout: 900000,
    fileParallelism: false,
  },
});