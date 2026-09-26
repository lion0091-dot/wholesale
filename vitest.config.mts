import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig가 jsx: preserve라 컴포넌트(.tsx)를 단위테스트에서 읽으려면 여기서 변환한다.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
