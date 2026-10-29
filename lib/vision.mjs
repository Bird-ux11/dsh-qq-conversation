import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCRIPT = fileURLToPath(new URL('../scripts/quick-image.py', import.meta.url));

export class VisionUnavailableError extends Error {
  constructor(reason = 'image_preprocessor_unavailable') { super(reason); this.name = 'VisionUnavailableError'; this.reason = reason; }
}

const clamp = (value, fallback, low, high) => Number.isFinite(value) ? Math.min(high, Math.max(low, Math.trunc(value))) : fallback;
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && /GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('invalid_image');
}

export async function readControlledImage(image, options, signal) {
  const path = image?.path;
  if (signal.aborted) throw abortError();
  if (typeof path !== 'string' || !isAbsolute(path) || /^[a-z]+:\/\//i.test(path)) throw new Error('invalid_image');
  const target = await realpath(path);
  let allowed = false;
  for (const root of options.allowedRoots) {
    try {
      const base = await realpath(root);
      const part = relative(base, target);
      if (part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)) { allowed = true; break; }
    } catch { /* An unavailable configured directory does not broaden access. */ }
  }
  if (!allowed) throw new Error('invalid_image');
  const handle = await open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > options.maxImageBytes) throw new Error('invalid_image');
    // Read a fixed upper bound. A concurrently growing file cannot exhaust memory.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, options.maxImageBytes + 1));
    let count = 0;
    while (count < bytes.length) {
      if (signal.aborted) throw abortError();
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size || count > options.maxImageBytes) throw new Error('invalid_image');
    const content = bytes.subarray(0, count);
    return { path: target, bytes: content, mediaType: imageType(content), hash: createHash('sha256').update(content).digest('hex') };
  } finally { await handle.close(); }
}

/** Only encodes received bytes; neither the script nor this wrapper downloads images. */
export function preprocessQuickImage(bytes, { signal, maxPixels = 512 * 512, python = 'python', scriptPath = DEFAULT_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const child = spawn(python, [scriptPath, '--max-pixels', String(clamp(maxPixels, 512 * 512, 4096, 512 * 512))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('preprocess_timeout')), 10000);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { finish(new Error('preprocess_output_limit')); return; }
      output += chunk.toString('utf8');
    });
    child.stderr.resume(); // Never expose local paths or untrusted decoder messages.
    child.on('error', () => finish(new VisionUnavailableError('image_preprocessor_unavailable')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (done) return;
      if (code !== 0) { finish(new VisionUnavailableError(code === 3 ? 'pillow_unavailable' : 'image_preprocess_failed')); return; }
      try {
        const data = JSON.parse(output);
        if (typeof data.dataUrl !== 'string' || !data.dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error();
        finish(null, data);
      } catch { finish(new Error('invalid_preprocess_result')); }
    });
    if (signal?.aborted) onAbort();
    else child.stdin.end(bytes);
  });
}

