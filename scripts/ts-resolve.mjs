// 테스트 전용: 확장자 없는 상대 import("./foo")를 "./foo.ts"로 해석.
// 프로젝트 소스는 bundler(Vite) 관례라 확장자를 안 쓰므로, Node 단독 실행 시에만 보정.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(specifier + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});
