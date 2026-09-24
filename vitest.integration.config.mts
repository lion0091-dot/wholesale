import { defineConfig } from "vitest/config";

// 로컬 Docker Supabase에 실제로 붙는 서버 액션 통합테스트 전용 설정.
// 단위테스트(vitest.config.mts, `**/*.test.ts`)와 섞이지 않도록 파일 이름은 `*.itest.ts`를 쓴다.
export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.itest.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
