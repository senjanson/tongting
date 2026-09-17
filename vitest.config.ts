import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
          environment: 'node',
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.{ts,tsx}'],
          environment: 'node',
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        // 真实 sub2api 冒烟测试：仅通过 `pnpm smoke:sub2api` 显式运行，凭证从 .env.local 读取。
        extends: true,
        test: {
          name: 'smoke',
          include: ['tests/smoke/**/*.smoke.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
    ],
  },
});
