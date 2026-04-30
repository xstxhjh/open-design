import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.test.{ts,tsx,js,mjs,cjs}',
      'daemon/**/*.test.{ts,tsx,js,mjs,cjs}',
      'tests/**/*.test.{ts,tsx}',
    ],
  },
});
