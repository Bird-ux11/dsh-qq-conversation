import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { preprocessQuickImage, readControlledImage, VisionUnavailableError } from './vision.mjs';

const VERSION = 'qq-native-thumbnail-v1';
const clamp = (value, fallback, low, high) => Number.isFinite(value) ? Math.min(high, Math.max(low, Math.trunc(value))) : fallback;
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const CACHE_FILE = /^qq-native-[a-f0-9]{64}\.json$/;

function abortRace(operation, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    // Keep both handlers even after abort: an uncancellable underlying operation
    // may settle later, and its rejection must never become unhandled.
    Promise.resolve(operation).then(value => finish(null, value), error => finish(error));
    if (signal.aborted) onAbort();
  });
}

/**
 * Native multimodal preparation only: no model calls, provider configuration or
 * credentials. The bridge resolves its own received images; this service reads
 * only allowlisted local files, creates small JPEG bytes, and returns them for
 * the same conversation's normal DSH attachment admission.
 */
export function createNativeImageService(options = {}) {
  const config = {
    enabled: options.enabled !== false,
    maxConcurrency: clamp(options.maxConcurrency, 2, 1, 2),
    maxQueue: clamp(options.maxQueue, 24, 0, 1000),
    deadlineMs: clamp(options.deadlineMs, 5000, 20, 30000),
    maxPixels: clamp(options.maxPixels, 512 * 512, 4096, 512 * 512),
    maxImageBytes: clamp(options.maxImageBytes, 10 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    ttlMs: clamp(options.ttlMs, 3600000, 0, 86400000),
    maxCacheEntries: clamp(options.maxCacheEntries, 200, 0, 1000),
    allowedRoots: Array.isArray(options.allowedRoots) ? options.allowedRoots.filter(p => typeof p === 'string' && isAbsolute(p)) : [],
    cacheRoot: typeof options.cacheRoot === 'string' && isAbsolute(options.cacheRoot) ? options.cacheRoot : null,
    python: options.python,
  };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const preprocess = options.preprocess ?? preprocessQuickImage;
  const resolveImages = options.resolveImages;
  const jobs = new Map(), waiters = new Set(), active = new Set(), activeGroups = new Set();
  const cache = new Map(), transforms = new Map(), resolverSlots = new Set(), transformSlots = new Set();
  const counters = { completed: 0, cacheHits: 0, merged: 0, timeouts: 0, cancelled: 0, rejected: 0, transformed: 0 };
  let queue = [], closed = false, diskTail = Promise.resolve();

  function memoryGet(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (now() - item.at >= config.ttlMs) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, item); return item.value;
  }
  function memoryPut(key, value) {
    if (!config.ttlMs || !config.maxCacheEntries) return;
    cache.delete(key); cache.set(key, { at: now(), value });
    while (cache.size > config.maxCacheEntries) cache.delete(cache.keys().next().value);
  }
  async function diskGet(key) {
    if (!config.cacheRoot || !config.ttlMs || !config.maxCacheEntries) return null;
    let file;
    try {
      file = await open(join(config.cacheRoot, `qq-native-${key}.json`), 'r');
      const info = await file.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024 || now() - info.mtimeMs >= config.ttlMs) return null;
      const json = JSON.parse(await file.readFile('utf8'));
      const data = Buffer.from(json.base64 ?? '', 'base64');
      if (json.key !== key || json.version !== VERSION || data.length < 3 || data.length > 1024 * 1024 || data[0] !== 255 || data[1] !== 216 || data[2] !== 255) return null;
      if (!Number.isInteger(json.width) || !Number.isInteger(json.height) || json.width < 1 || json.height < 1 || json.width * json.height > config.maxPixels) return null;
      const hash = createHash('sha256').update(data).digest('hex');
      if (json.hash !== hash) return null;
      return { data, mediaType: 'image/jpeg', hash, width: json.width, height: json.height, firstFrameOnly: json.firstFrameOnly === true };
    } catch { return null; }
    finally { await file?.close(); }
  }
  function diskPut(key, image) {
    if (!config.cacheRoot || !config.ttlMs || !config.maxCacheEntries || closed) return;
    // Background writes are serialized and never delay the image result or chat.
    diskTail = diskTail.then(async () => {
      if (closed) return;
      await mkdir(config.cacheRoot, { recursive: true });
      const temp = join(config.cacheRoot, `qq-native-${key}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify({ version: VERSION, key, hash: image.hash, width: image.width, height: image.height,
          firstFrameOnly: image.firstFrameOnly, base64: image.data.toString('base64') }), { flag: 'wx', mode: 0o600 });
        await rename(temp, join(config.cacheRoot, `qq-native-${key}.json`));
      } finally { await unlink(temp).catch(() => {}); }
      const owned = (await readdir(config.cacheRoot, { withFileTypes: true })).filter(item => item.isFile() && CACHE_FILE.test(item.name));
      const records = await Promise.all(owned.map(async item => ({ path: join(config.cacheRoot, item.name), at: (await stat(join(config.cacheRoot, item.name))).mtimeMs })));
      records.sort((a, b) => b.at - a.at);
      await Promise.all(records.filter((item, index) => index >= config.maxCacheEntries || now() - item.at >= config.ttlMs).map(item => unlink(item.path).catch(() => {})));
    }).catch(() => {});
  }

  async function resolveBounded(job) {
    if (job.controller.signal.aborted) throw abortError();
    // Business jobs release immediately on cancellation. Real resolver work has
    // its own bound until it physically settles, so a broken resolver cannot
    // accumulate unlimited abandoned downloads. The bridge also owns its HTTP timeout.
    if (resolverSlots.size >= config.maxConcurrency) throw new VisionUnavailableError('image-resolver-busy');
    const slot = {}; resolverSlots.add(slot);
    const operation = Promise.resolve().then(() => resolveImages({ groupId: job.groupId, messageId: job.messageId,
      signal: job.controller.signal })).finally(() => resolverSlots.delete(slot));
    return abortRace(operation, job.controller.signal);
  }

  async function transform(image, signal) {
    const key = createHash('sha256').update(JSON.stringify([VERSION, image.hash, config.maxPixels])).digest('hex');
    const hit = memoryGet(key) ?? await diskGet(key);
    if (signal.aborted) throw abortError();
    if (hit) { counters.cacheHits++; memoryPut(key, hit); return { image: hit, cached: true }; }
    let entry = transforms.get(key);
    if (entry?.controller.signal.aborted) { transforms.delete(key); entry = null; }
    if (!entry) {
      if (transformSlots.size >= config.maxConcurrency) throw new VisionUnavailableError('image-preprocessor-busy');
      entry = { controller: new AbortController(), clients: new Set() };
      transforms.set(key, entry); transformSlots.add(entry);
      entry.promise = Promise.resolve().then(async () => {
        if (entry.controller.signal.aborted) throw abortError();
        const value = await preprocess(image.bytes, { signal: entry.controller.signal, maxPixels: config.maxPixels, python: config.python });
        if (entry.controller.signal.aborted) throw abortError();
        if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width * value.height > config.maxPixels || !value.dataUrl?.startsWith('data:image/jpeg;base64,')) throw new Error('invalid_thumbnail');
        const data = Buffer.from(value.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64');
        if (data.length < 3 || data.length > 1024 * 1024 || data[0] !== 255 || data[1] !== 216 || data[2] !== 255) throw new Error('invalid_thumbnail');
        const result = { data, mediaType: 'image/jpeg', hash: createHash('sha256').update(data).digest('hex'), width: value.width, height: value.height, firstFrameOnly: value.firstFrameOnly === true };
        counters.transformed++; memoryPut(key, result); diskPut(key, result); return result;
      }).finally(() => { transformSlots.delete(entry); if (transforms.get(key) === entry) transforms.delete(key); });
    } else counters.merged++;
    const token = {}; entry.clients.add(token);
    const onAbort = () => { entry.clients.delete(token); if (!entry.clients.size) entry.controller.abort(); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try { return { image: await abortRace(entry.promise, signal), cached: false }; }
    finally { signal.removeEventListener('abort', onAbort); entry.clients.delete(token); }
  }

  function settle(waiter, result) {
    if (waiter.done) return;
    waiter.done = true; clearTimeout(waiter.timer); waiter.signal?.removeEventListener('abort', waiter.onAbort); waiters.delete(waiter);
    waiter.job?.waiters.delete(waiter);
    if (waiter.job && !waiter.job.waiters.size) {
      waiter.job.controller.abort();
      if (jobs.get(waiter.job.key) === waiter.job) jobs.delete(waiter.job.key);
      queue = queue.filter(job => job !== waiter.job);
    }
    if (result.status === 'timeout') counters.timeouts++;
    if (result.status === 'cancelled') counters.cancelled++;
    waiter.resolve({ ...result, images: (result.images ?? []).map(image => ({ ...image, data: Buffer.from(image.data) })), groupId: waiter.groupId, messageId: waiter.messageId });
  }
  function pump() {
    if (closed) return;
    while (active.size < config.maxConcurrency) {
      const index = queue.findIndex(job => job.waiters.size && !activeGroups.has(job.groupId));
      if (index < 0) break;
      const [job] = queue.splice(index, 1); active.add(job); activeGroups.add(job.groupId);
      Promise.resolve().then(async () => {
        const signal = job.controller.signal;
        const paths = await resolveBounded(job);
        if (signal.aborted) throw abortError();
        if (!Array.isArray(paths) || !paths.length) return { status: 'unavailable', reason: 'no-native-image', images: [] };
        const source = await readControlledImage({ path: paths[0]?.path }, config, signal);
        const prepared = await transform(source, signal);
        if (signal.aborted) throw abortError();
        counters.completed++;
        return { status: 'ready', images: [prepared.image], cached: prepared.cached, mode: 'native-thumbnail', sourceHash: source.hash };
      }).then(result => { for (const waiter of [...job.waiters]) settle(waiter, result); }).catch(error => {
        const reason = error instanceof VisionUnavailableError ? error.reason : 'image-preparation-failed';
        for (const waiter of [...job.waiters]) settle(waiter, { status: error instanceof VisionUnavailableError ? 'unavailable' : 'error', reason });
      }).finally(() => {
        active.delete(job); activeGroups.delete(job.groupId);
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        pump();
      });
    }
  }
  function prepare(request = {}) {
    const groupId = String(request.groupId ?? ''), messageId = String(request.messageId ?? '');
    const immediate = (status, reason) => Promise.resolve({ status, reason, images: [], groupId, messageId });
    if (closed || !config.enabled) return immediate('unavailable', closed ? 'service-closed' : 'disabled');
    if (typeof resolveImages !== 'function') return immediate('unavailable', 'bridge-image-resolver-unavailable');
    if (!groupId || !messageId) return immediate('error', 'invalid-message');
    if (request.signal?.aborted) return immediate('cancelled', 'caller-cancelled');
    if (waiters.size >= config.maxQueue + config.maxConcurrency) { counters.rejected++; return immediate('queue_full', 'capacity'); }
    return new Promise(resolve => {
      const key = JSON.stringify([groupId, messageId]);
      let job = jobs.get(key);
      if (!job) {
        job = { key, groupId, messageId, controller: new AbortController(), waiters: new Set() };
        jobs.set(key, job);
        if (request.priority === 'direct') queue.unshift(job); else queue.push(job);
      } else counters.merged++;
      const waiter = { resolve, groupId, messageId, signal: request.signal, job, done: false };
      waiter.onAbort = () => settle(waiter, { status: 'cancelled', reason: 'caller-cancelled' });
      waiter.timer = setTimeout(() => settle(waiter, { status: 'timeout', reason: 'deadline' }), config.deadlineMs);
      waiters.add(waiter); job.waiters.add(waiter); request.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      if (request.signal?.aborted) waiter.onAbort();
      pump();
    });
  }
  function cancelGroup(groupId) { for (const waiter of [...waiters]) if (waiter.groupId === String(groupId)) settle(waiter, { status: 'cancelled', reason: 'group-cancelled' }); }
  function close() {
    closed = true;
    for (const waiter of [...waiters]) settle(waiter, { status: 'cancelled', reason: 'service-closed' });
    for (const job of active) job.controller.abort();
    for (const entry of transformSlots) entry.controller.abort();
    queue = []; cache.clear();
  }
  function stats() { return { mode: 'native-thumbnail', enabled: config.enabled, available: !closed && config.enabled && typeof resolveImages === 'function', closed,
    active: active.size, queued: queue.length, pending: waiters.size, cacheEntries: cache.size, maxConcurrency: config.maxConcurrency, maxPerGroup: 1,
    resolverInFlight: resolverSlots.size, preprocessInFlight: transformSlots.size,
    maxQueue: config.maxQueue, deadlineMs: config.deadlineMs, maxPixels: config.maxPixels, maxImagesPerMessage: 1, diskCache: Boolean(config.cacheRoot), ...counters }; }
  return { prepare, cancelGroup, close, stats, clearCache: () => cache.clear(), flushCache: () => diskTail };
}
