import type { Config } from '@react-router/dev/config';

export default {
  // 开启 SSR —— 但只渲染外壳，重逻辑全在客户端，
  // 以适配 Workers 免费版 10ms CPU 限制。
  ssr: true,
  appDirectory: 'app',
  buildDirectory: 'build',
} satisfies Config;
