/**
 * Node 的 ESM 解析钩子（仅用于 `scripts/test-client-api.ts`）。
 *
 * 解决一个问题：项目里大量使用 tsconfig 的路径别名
 * （`@shared/*` → `shared/*`），而 Node 原生不认识 tsconfig。
 * 这里在解析阶段把别名映射成真实文件，并补上 `.ts` 扩展名，
 * 于是测试脚本可以用 `node --experimental-strip-types` 直接跑，
 * 完全不需要 esbuild / tsx 这类需要派生服务进程的工具。
 *
 * 注意：这是**测试专用**的小工具，不参与 Worker 或前端构建。
 */

import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** tsconfig 里的 paths 映射（只列测试实际用到的） */
const ALIASES = [['@shared/', 'shared/']];

/**
 * 把可能省略了扩展名的路径补全为真实存在的文件。
 * 顺序：原样 → .ts → .tsx → /index.ts
 */
function completeFile(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolvePath(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // ---- 路径别名 ----
  for (const [prefix, target] of ALIASES) {
    if (specifier.startsWith(prefix)) {
      const mapped = resolvePath(projectRoot, target + specifier.slice(prefix.length));
      const file = completeFile(mapped);
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
  }

  // ---- 相对路径 + 省略扩展名 ----
  if (specifier.startsWith('.') && context.parentURL) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const file = completeFile(resolvePath(parentDir, specifier));
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}

/**
 * 通过 `--import` 加载时，本模块运行在**主线程**，
 * 具名导出的 resolve 不会被当成钩子。必须显式注册到 loader 线程。
 * （直接 `node --loader` 已废弃，所以走 register 这条路。）
 */
register('./ts-path-resolver.mjs', import.meta.url);
