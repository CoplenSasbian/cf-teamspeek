/**
 * E2EE 加解密 Worker（运行在 RTCRtpScriptTransform 中）
 *
 * 用法（主线程）：
 *   const worker = new Worker('/e2ee-worker.js');
 *   const transform = new RTCRtpScriptTransform(worker, { operation: 'encode', key });
 *   sender.transform = transform;
 *
 * 设计（见 DESIGN.md 11.3）：
 *   - AES-GCM 256
 *   - 每帧 12 字节随机 IV，随帧一起传输
 *   - 在 Worker 中执行，不阻塞主线程
 *
 * 帧格式：
 *   [12 bytes IV][AES-GCM ciphertext + 16 bytes auth tag]
 */

const IV_LENGTH = 12;

/** @type {Map<string, CryptoKey>} */
const keyCache = new Map();

function getKey(operation, rawKey) {
  const cacheKey = `${operation}:${rawKey}`;
  let promise = keyCache.get(cacheKey);
  if (!promise) {
    const keyBytes = Uint8Array.from(atob(rawKey), (c) => c.charCodeAt(0));
    promise = crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
      operation === 'encode' ? 'encrypt' : 'decrypt',
    ]);
    keyCache.set(cacheKey, promise);
  }
  return promise;
}

/**
 * 加密一帧。
 * 输入 RTCEncodedAudioFrame（非压缩帧，音频场景用 EncodedAudioFrame 更常见）
 */
async function encodeFrame(frame, key) {
  const data = new Uint8Array(frame.data);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_LENGTH);

  frame.data = out.buffer;
  return frame;
}

/** 解密一帧 */
async function decodeFrame(frame, key) {
  const data = new Uint8Array(frame.data);

  if (data.byteLength <= IV_LENGTH) {
    // 帧太短，可能是未加密的（降级场景）—— 原样透传
    return frame;
  }

  const iv = data.subarray(0, IV_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    frame.data = plaintext;
  } catch {
    // 解密失败（对端未加密 / 密钥不匹配）—— 丢弃该帧，避免噪音
    frame.data = new ArrayBuffer(0);
  }
  return frame;
}

let currentKeyPromise = null;

self.addEventListener('rtctransform', (event) => {
  const { operation, rawKey } = event.transformer.options;
  currentKeyPromise = getKey(operation, rawKey);

  const { readable, writable } = event.transformer;
  const transformStream = new TransformStream({
    async transform(frame, controller) {
      try {
        const key = await currentKeyPromise;
        const out =
          operation === 'encode'
            ? await encodeFrame(frame, key)
            : await decodeFrame(frame, key);
        controller.enqueue(out);
      } catch {
        controller.enqueue(frame);
      }
    },
  });

  readable.pipeThrough(transformStream).pipeTo(writable).catch(() => {
    /* 管道关闭 */
  });
});
