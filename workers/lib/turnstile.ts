/**
 * Turnstile 服务端校验。
 * 端点：POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 *
 * 开发阶段用官方测试 secret（总是通过）：
 *   1x0000000000000000000000000000000AA
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
}

export interface TurnstileResult {
  success: boolean;
  errors: string[];
  hostname?: string;
}

export async function verifyTurnstile(
  secret: string,
  token: string | null | undefined,
  remoteIp?: string,
): Promise<TurnstileResult> {
  if (!token) {
    return { success: false, errors: ['missing-input-response'] };
  }

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
    const data = (await res.json()) as SiteverifyResponse;
    return {
      success: data.success === true,
      errors: data['error-codes'] ?? [],
      hostname: data.hostname,
    };
  } catch (err) {
    return {
      success: false,
      errors: [`network-error: ${err instanceof Error ? err.message : 'unknown'}`],
    };
  }
}
