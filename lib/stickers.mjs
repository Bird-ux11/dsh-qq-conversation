import { constants } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EXTENSIONS = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const list = value => [...new Set((Array.isArray(value) ? value : []).slice(0, 64).map(item => normalize(item).slice(0, 80)).filter(Boolean))];
const tokens = value => normalize(value).split(/[\s_.\-\/\\\[\]【】()（）,，;；]+/u).filter(Boolean);
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const overlap = (left, right) => left.some(value => right.includes(value));

function integer(value, fallback, min, max, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new TypeError(`Invalid ${name}`);
  return resolved;
}

function metadata(value = {}) {
  return {
    label: typeof value.label === 'string' ? value.label.replace(/[\u0000-\u001f]/gu, '').slice(0, 200) : '',
    tags: list(value.tags), characterTags: list(value.characterTags), styleTags: list(value.styleTags),
  };
}

function mergeMetadata(...values) {
  return {
    label: values.map(value => value.label).find(Boolean) ?? '',
    tags: list(values.flatMap(value => value.tags ?? [])),
    characterTags: list(values.flatMap(value => value.characterTags ?? [])),
    styleTags: list(values.flatMap(value => value.styleTags ?? [])),
  };
}

function sniff(header, extension) {
  if (extension === '.png' && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (['.jpg', '.jpeg'].includes(extension) && header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (extension === '.gif' && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (extension === '.webp' && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('File does not have the declared image signature');
}

/**
 * Local, allowlisted sticker catalog. Construction never scans or performs network I/O.
 * roots accepts strings or { path, tags, characterTags, styleTags } objects.
 * persona accepts characterTags/styleTags allowlists, excludedTags and allowUntagged.
 * Explicit category allowlists exclude untagged assets unless allowUntagged is true.
 */
export class StickerIndex {
  constructor(config = {}) {
    if (config.roots !== undefined && !Array.isArray(config.roots)) throw new TypeError('roots must be an array');
    this.roots = (config.roots ?? []).map(root => {
      const source = typeof root === 'string' ? { path: root } : root;
      if (!source || typeof source.path !== 'string' || !source.path.trim()) throw new TypeError('Invalid sticker root');
      return { path: path.resolve(source.path), ...metadata(source) };
    });
    this.maxFiles = integer(config.maxFiles, 2000, 1, 100000, 'maxFiles');
    this.maxEntries = integer(config.maxEntries, this.maxFiles * 10, 1, 1000000, 'maxEntries');
    this.maxDepth = integer(config.maxDepth, 4, 0, 32, 'maxDepth');
    this.maxFileBytes = integer(config.maxFileBytes, 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxFileBytes');
    this.reuseCooldownMs = integer(config.reuseCooldownMs, 60000, 0, 86400000, 'reuseCooldownMs');
    this.globalCooldownMs = integer(config.globalCooldownMs, 0, 0, 86400000, 'globalCooldownMs');
    this.recentWindow = integer(config.recentWindow, 10, 1, 1000, 'recentWindow');
    this.maxUsageScopes = integer(config.maxUsageScopes, 256, 1, 10000, 'maxUsageScopes');
    this.autoCollect = config.autoCollect === true;
    this.persona = { ...metadata(config.persona), excludedTags: list(config.persona?.excludedTags), allowUntagged: config.persona?.allowUntagged === true };
    this.now = config.now ?? Date.now;
    if (typeof this.now !== 'function') throw new TypeError('now must be a function');
    this.remoteSearchProvider = config.remoteSearchProvider;
    if (this.remoteSearchProvider !== undefined && typeof this.remoteSearchProvider !== 'function') throw new TypeError('remoteSearchProvider must be a function');
    this.entries = new Map();
    this.allowedRoots = [];
    this.receivedMetadata = new Map();
    this.usage = new Map();
    this.mutationTail = Promise.resolve();
  }

  get size() { return this.entries.size; }

  // Serialize refresh/registration so a slower scan cannot overwrite a new registration.
  mutate(operation) {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.catch(() => {});
    return next;
  }

  async rootList() {
    const resolved = [];
    for (const root of this.roots) {
      const canonical = await realpath(root.path);
      if (!(await lstat(canonical)).isDirectory()) throw new Error('Sticker root must be a directory');
      resolved.push({ ...root, canonical });
    }
    return resolved;
  }

  async readImage(filePath, roots, includeBytes = false) {
    const absolute = path.resolve(filePath);
    if (!roots.some(root => within(root.path, absolute) || within(root.canonical, absolute))) throw new Error('Sticker path is outside configured roots');
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Sticker must be a regular file');
    const canonical = await realpath(absolute);
    const root = roots.find(item => within(item.canonical, canonical));
    if (!root) throw new Error('Sticker path resolves outside configured roots');
    const extension = path.extname(absolute).toLowerCase();
    if (!EXTENSIONS.has(extension)) throw new Error('Unsupported sticker extension');
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > this.maxFileBytes) throw new Error('Sticker exceeds size limit');
      const hash = createHash('sha256');
      const chunks = [];
      const buffer = Buffer.alloc(Math.min(65536, this.maxFileBytes + 1));
      let size = 0;
      let header = Buffer.alloc(0);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, this.maxFileBytes + 1 - size), null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > this.maxFileBytes) throw new Error('Sticker exceeds size limit');
        const chunk = buffer.subarray(0, bytesRead);
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
        hash.update(chunk);
        if (includeBytes) chunks.push(Buffer.from(chunk));
      }
      const after = await handle.stat();
      const pathAfter = await lstat(absolute);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size ||
        !pathAfter.isFile() || pathAfter.isSymbolicLink() || before.dev !== pathAfter.dev || before.ino !== pathAfter.ino ||
        await realpath(absolute) !== canonical) throw new Error('Sticker changed while reading');
      return {
        filePath: absolute, canonical, root, sha256: hash.digest('hex'), size,
        mimeType: sniff(header, extension), ...(includeBytes ? { bytes: Buffer.concat(chunks) } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  addEntry(target, image, supplied = {}) {
    const relative = path.relative(image.root.canonical, image.canonical);
    const filename = path.basename(relative, path.extname(relative));
    const naming = { ...metadata(), label: filename, tags: tokens(path.join(path.dirname(relative), filename)).filter(tag => tag !== '.') };
    const meta = mergeMetadata(metadata(supplied), metadata(image.root), naming);
    const id = `sticker:${image.sha256}`;
    const previous = target.get(id);
    target.set(id, {
      id, sha256: image.sha256, size: image.size, mimeType: image.mimeType,
      ...mergeMetadata(previous ?? {}, meta),
      paths: [...new Set([...(previous?.paths ?? []), image.filePath])],
    });
    return id;
  }

  /** Rebuild atomically, skipping symlinks, unsupported files and invalid/oversized images. */
  refresh() {
    return this.mutate(async () => {
      const roots = await this.rootList();
      const next = new Map();
      const stats = { indexed: 0, scanned: 0, skipped: 0, duplicates: 0, truncated: false };
      let visited = 0;
      const walk = async (directory, depth) => {
        const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (visited >= this.maxEntries || stats.scanned >= this.maxFiles) { stats.truncated = true; return; }
          visited += 1;
          const filePath = path.join(directory, child.name);
          if (child.isSymbolicLink()) { stats.skipped += 1; continue; }
          if (child.isDirectory()) {
            if (depth < this.maxDepth) await walk(filePath, depth + 1);
            continue;
          }
          if (!child.isFile() || !EXTENSIONS.has(path.extname(child.name).toLowerCase())) continue;
          stats.scanned += 1;
          try {
            const image = await this.readImage(filePath, roots);
            const oldSize = next.size;
            this.addEntry(next, image, this.receivedMetadata.get(image.sha256));
            if (next.size === oldSize) stats.duplicates += 1;
          } catch { stats.skipped += 1; } // Unreadable or rejected assets are absent from this catalog.
        }
      };
      for (const root of roots) await walk(root.canonical, 0);
      this.entries = next;
      this.allowedRoots = roots;
      stats.indexed = next.size;
      return stats;
    });
  }

  usageFor(scope = 'global') { return this.usage.get(String(scope)) ?? []; }

  /** Search locally. Returns metadata and trustworthy IDs, never local paths or image bytes. */
  search(request = {}) {
    const limit = integer(request.limit, 8, 1, 50, 'limit');
    const now = request.now ?? this.now();
    const recent = this.usageFor(request.scope);
    if (recent.length && now - recent.at(-1).at < this.globalCooldownMs) return [];
    const query = tokens(request.query);
    const requiredTags = list(request.tags);
    const categories = ['characterTags', 'styleTags'];
    const results = [];
    const entries = request.id === undefined ? this.entries.values() : [this.entries.get(request.id)].filter(Boolean);
    for (const entry of entries) {
      const allTags = [...entry.tags, ...entry.characterTags, ...entry.styleTags];
      if (overlap(allTags, this.persona.excludedTags)) continue;
      if (!requiredTags.every(tag => allTags.includes(tag))) continue;
      if (categories.some(category => {
        const wanted = list(request[category]);
        const allowed = this.persona[category];
        return (wanted.length && !overlap(entry[category], wanted)) ||
          (allowed.length && (entry[category].length ? !overlap(entry[category], allowed) : !this.persona.allowUntagged));
      })) continue;
      const used = recent.filter(item => item.id === entry.id);
      if (used.length && now - used.at(-1).at < this.reuseCooldownMs) continue;
      const haystack = [...allTags, normalize(entry.label)];
      const matchedTerms = query.filter(term => haystack.some(tag => tag.includes(term) || (tag.length > 1 && term.includes(tag))));
      if (query.length && !matchedTerms.length) continue;
      const score = matchedTerms.length * 4 + requiredTags.length * 2 - used.length * 1.5;
      results.push({
        id: entry.id, label: entry.label, tags: [...entry.tags],
        characterTags: [...entry.characterTags], styleTags: [...entry.styleTags],
        mimeType: entry.mimeType, size: entry.size, score, matchedTerms,
        recentUses: used.length, lastUsedAt: used.at(-1)?.at ?? null,
      });
    }
    return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }

  /** Exact-ID eligibility uses the same persona/cooldown rules without a top-results cutoff. */
  isEligible(id, { scope = 'global', now = this.now() } = {}) {
    return this.search({ id, scope, now, limit: 1 }).length === 1;
  }

  /**
   * Resolve only a current catalog ID and recheck containment/content. includeBytes lets
   * the bridge send the verified bytes without reopening a possibly changed filesystem path.
   */
  async resolve(id, { includeBytes = false } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const roots = this.allowedRoots;
    for (const filePath of entry.paths) {
      try {
        const image = await this.readImage(filePath, roots, includeBytes);
        if (image.sha256 !== entry.sha256 || this.entries.get(id) !== entry) continue;
        return {
          id, filePath: image.filePath, sha256: image.sha256, mimeType: image.mimeType,
          size: image.size, label: entry.label, ...(includeBytes ? { bytes: image.bytes } : {}),
        };
      } catch { /* Removed, changed, unreadable or escaped assets cannot be sent. */ }
    }
    return null;
  }

  /** Record a confirmed successful send. scope should normally be the QQ group ID. */
  markUsed(id, { scope = 'global', now = this.now() } = {}) {
    if (!this.entries.has(id)) return false;
    const key = String(scope);
    const records = [...this.usageFor(key), { id, at: now }].slice(-this.recentWindow);
    this.usage.delete(key);
    this.usage.set(key, records);
    while (this.usage.size > this.maxUsageScopes) this.usage.delete(this.usage.keys().next().value);
    return true;
  }

  /**
   * Register an already-downloaded group sticker inside an allowed root. Does not download
   * or copy files. explicit is a trusted host decision, not a model-controlled bypass.
   */
  registerReceived(asset, { explicit = false } = {}) {
    return this.mutate(async () => {
      if (!this.autoCollect && !explicit) return { registered: false, reason: 'auto-collection-disabled' };
      if (!asset || typeof asset.filePath !== 'string') throw new TypeError('filePath is required');
      const roots = await this.rootList();
      const image = await this.readImage(asset.filePath, roots);
      const supplied = metadata(asset);
      const id = `sticker:${image.sha256}`;
      if (!this.entries.has(id) && this.entries.size >= this.maxFiles) return { registered: false, reason: 'catalog-full' };
      const duplicate = this.entries.has(id);
      this.receivedMetadata.set(image.sha256, mergeMetadata(supplied, this.receivedMetadata.get(image.sha256) ?? {}));
      this.addEntry(this.entries, image, supplied);
      this.allowedRoots = roots;
      return { registered: true, id, duplicate };
    });
  }

  /** Host-persistable state contains hashes, tags and usage only, never image data or paths. */
  exportState() {
    return {
      version: 1,
      registered: [...this.receivedMetadata].map(([sha256, value]) => ({ sha256, ...metadata(value) })),
      usage: [...this.usage].map(([scope, records]) => ({ scope, records: records.map(item => ({ ...item })) })),
    };
  }

  /** Restore before refresh. Metadata is bound to bytes, so replacing a file cannot inherit it. */
  restoreState(state) {
    if (!state || state.version !== 1 || !Array.isArray(state.registered) || !Array.isArray(state.usage)) throw new TypeError('Invalid sticker state');
    const registered = new Map();
    for (const item of state.registered.slice(0, this.maxFiles)) {
      if (item && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)) registered.set(item.sha256, metadata(item));
    }
    const usage = new Map();
    for (const item of state.usage.slice(-this.maxUsageScopes)) {
      if (!item || typeof item.scope !== 'string' || !Array.isArray(item.records)) continue;
      const records = item.records.filter(record => record && /^sticker:[a-f0-9]{64}$/u.test(record.id) && Number.isFinite(record.at) && record.at >= 0)
        .slice(-this.recentWindow).map(record => ({ id: record.id, at: record.at }));
      if (records.length) usage.set(item.scope.slice(0, 200), records);
    }
    this.receivedMetadata = registered;
    this.usage = usage;
    return { metadataEntries: registered.size, usageScopes: usage.size };
  }

  /**
   * Optional provider extension. Explicit opt-in; only query/tag criteria cross the seam.
   * Remote hits are not trusted local IDs and cannot resolve or send until locally imported.
   * No HTTP client or credentials are owned by this module.
   */
  async searchRemote(request = {}, { allowRemote = false } = {}) {
    if (!this.remoteSearchProvider) return { status: 'not-configured', items: [] };
    if (!allowRemote) return { status: 'disabled', items: [] };
    const criteria = { query: String(request.query ?? '').slice(0, 500), tags: list(request.tags), limit: integer(request.limit, 8, 1, 50, 'limit') };
    const result = await this.remoteSearchProvider(criteria);
    if (!Array.isArray(result)) throw new TypeError('Remote sticker provider must return an array');
    const items = result.slice(0, criteria.limit).map((item, index) => ({
      providerId: String(item?.id ?? index), ...metadata(item), sendable: false,
    }));
    return { status: 'ok', items };
  }
}
