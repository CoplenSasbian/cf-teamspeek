/**
 * 时序安全字符串比较（等长比较，防时序侧信道攻击）。
 * 长度不同直接返回 false，但仍走一次固定时间循环。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  // 长度差异也会被下面的累加捕获
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** 生成随机 UUID（Workers 原生 crypto） */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/** SHA-256 十六进制摘要 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 昵称规范化：trim + 全角转半角 + 大小写折叠 + 内部连续空白压成一个空格。
 * 用于全局唯一性判定，保证「Ａlice」与「alice」视为同一个。
 */
export function normalizeNickname(raw: string): string {
  return raw
    .trim()
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
