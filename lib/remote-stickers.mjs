import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

// Protocol references, not imported executable code:
// https://github.com/wsu2059q/qsticker and https://github.com/byaidu/qqbq-helper
export const QQ_INDEX_URL = 'https://raw.githubusercontent.com/byaidu/qqbq-helper/main/db.json';
export const QQ_INDEX_MIRROR = 'https://cdn.jsdelivr.net/gh/byaidu/qqbq-helper/db.json';
export const QQ_ORIGIN = 'https://gxh.vip.qq.com';
export const ROLE_KEYWORDS = Object.freeze(['deepseek', '鲸鱼娘', '大肥鱼', '深度求索', '鲸娘']);

const clean = (value, limit = 300) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f]/gu, ' ').trim().slice(0, limit);
const terms = value => clean(value, 1000).toLowerCase().split(/[\s,，;；]+/u).filter(Boolean);
const roleMatches = value => ROLE_KEYWORDS.filter(keyword => clean(value, 10000).toLowerCase().includes(keyword));
const tagsOf = value => (Array.isArray(value) ? value.flatMap(terms) : terms(value)).slice(0, 64);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function bound(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new TypeError(`Invalid ${name}`);
  return result;
}

function packId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('Unsafe QQ pack ID');
  const id = String(value ?? '');
  if (!/^[1-9][0-9]{0,19}$/u.test(id)) throw new TypeError('Invalid QQ pack ID');
  return id;
}

function dimension(value) {
  return bound(Number(value), undefined, 1, 4096, 'QQ image dimension');
}

function imageMime(bytes, variant) {
  if (variant === 'static' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (variant === 'dynamic' && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  throw new Error('QQ asset has an unexpected image signature');
}

/**
 * Searches the public QQ metadata index and reads official QQ CDN assets. No private
 * collections, NapCat requests, proxies, script execution or outgoing chat messages.
 * Name/description matches are candidates only: every result remains role-unverified.
 */
export class QQPublicStickerSource {
  constructor(config = {}, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.fetch = fetchImpl;
    this.now = now;
    this.indexUrl = config.indexUrl ?? QQ_INDEX_URL;
    if (![QQ_INDEX_URL, QQ_INDEX_MIRROR].includes(this.indexUrl)) throw new Error('Unapproved public QQ index URL');
    this.cacheDir = config.cacheDir ? path.resolve(config.cacheDir) : null;
    this.timeoutMs = bound(config.timeoutMs, 10000, 100, 60000, 'timeoutMs');
    this.maxIndexBytes = bound(config.maxIndexBytes, 4 * 1024 * 1024, 1, 16 * 1024 * 1024, 'maxIndexBytes');
    this.maxMetadataBytes = bound(config.maxMetadataBytes, 1024 * 1024, 1, 4 * 1024 * 1024, 'maxMetadataBytes');
    this.maxAssetBytes = bound(config.maxAssetBytes, 8 * 1024 * 1024, 1, 32 * 1024 * 1024, 'maxAssetBytes');
    this.maxPacks = bound(config.maxPacks, 30000, 1, 100000, 'maxPacks');
    this.maxAssetsPerPack = bound(config.maxAssetsPerPack, 128, 1, 512, 'maxAssetsPerPack');
    this.maxCandidates = bound(config.maxCandidates, 2048, 1, 10000, 'maxCandidates');
    this.index = new Map();
    this.candidates = new Map();
    this.indexState = { status: 'not-loaded', source: 'qq-public-index', indexUrl: this.indexUrl, count: 0, matchingPacks: 0 };
  }

  assertUrl(input, kind) {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) throw new Error('Unapproved QQ source URL');
    if (kind === 'index') {
      if (![QQ_INDEX_URL, QQ_INDEX_MIRROR].includes(url.href)) throw new Error('Unapproved public QQ index URL');
    } else if (url.origin !== QQ_ORIGIN || !url.pathname.startsWith('/club/item/parcel/') && !url.pathname.startsWith('/qqshow/admindata/comdata/vipEmoji_item_')) {
      throw new Error('Only approved QQ CDN paths may be fetched');
    }
    return url.href;
  }

  async read(input, maxBytes, kind, signal) {
    const url = this.assertUrl(input, kind);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('QQ source request timed out')), this.timeoutMs);
    timer.unref?.();
    try {
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const response = await this.fetch(url, { redirect: 'manual', signal: requestSignal });
      if (response.status >= 300 && response.status < 400) throw new Error('QQ source redirects are not followed');
      if (!response.ok) throw new Error(`QQ source HTTP ${response.status}`);
      const declaredSize = Number(response.headers.get('content-length'));
      if (declaredSize > maxBytes) { await response.body?.cancel(); throw new Error('QQ response exceeds byte limit'); }
      if (!response.body) throw new Error('QQ source returned an empty body');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          requestSignal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('QQ response exceeds byte limit');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); }
  }

  /** Downloads only public metadata; caller may persist this summary as research evidence. */
  async refreshIndex({ signal } = {}) {
    const bytes = await this.read(this.indexUrl, this.maxIndexBytes, 'index', signal);
    const data = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(data) || data.length > this.maxPacks) throw new Error('Invalid or excessive QQ pack index');
    const next = new Map();
    let rejected = 0;
    for (const item of data) {
      try {
        if (!item || typeof item.name !== 'string') throw new Error('Missing QQ pack name');
        const id = packId(item.id);
        const pack = { packId: id, title: clean(item.name), description: clean(item.desc, 2000), tags: tagsOf(item.tag) };
        pack.roleKeywords = roleMatches(`${pack.title} ${pack.description} ${pack.tags.join(' ')}`);
        next.set(id, pack);
      } catch { rejected += 1; } // Invalid public catalog entries are not selectable.
    }
    this.index = next;
    this.indexState = {
      status: 'loaded', source: 'qq-public-index', indexUrl: this.indexUrl,
      count: next.size, matchingPacks: [...next.values()].filter(item => item.roleKeywords.length).length,
      rejected, sha256: createHash('sha256').update(bytes).digest('hex'), fetchedAt: this.now(),
    };
    return structuredClone(this.indexState);
  }

  /** Strict role filtering never falls back to generic whales or unrelated packs. */
  searchPacks({ query = '', limit = 10 } = {}) {
    const take = bound(limit, 10, 1, 50, 'limit');
    const queryTerms = terms(query);
    const results = [];
    for (const pack of this.index.values()) {
      if (!pack.roleKeywords.length) continue;
      const haystack = `${pack.title} ${pack.description} ${pack.tags.join(' ')}`.toLowerCase();
      const matched = queryTerms.filter(term => haystack.includes(term));
      if (queryTerms.length && !matched.length) continue;
      results.push({
        ...structuredClone(pack), score: matched.length * 2 + pack.roleKeywords.length,
        source: 'qq-public-index', sourceUrl: this.indexUrl,
        roleEvidence: 'public-metadata-keyword-only', roleVerified: false, sendable: false,
      });
    }
    return results.sort((left, right) => right.score - left.score || left.packId.localeCompare(right.packId)).slice(0, take);
  }

  /** Fetches real pack metadata and bounded official CDN image candidates; no image download. */
  async inspectPack(value, { signal } = {}) {
    const id = packId(value);
    const metadataUrl = `${QQ_ORIGIN}/club/item/parcel/${id.at(-1)}/${id}_android.json`;
    const infoUrl = `${QQ_ORIGIN}/qqshow/admindata/comdata/vipEmoji_item_${id}/xydata.json`;
    const parcel = JSON.parse((await this.read(metadataUrl, this.maxMetadataBytes, 'qq', signal)).toString('utf8'));
    if (!parcel || String(parcel.id) !== id || !Array.isArray(parcel.imgs) || !Array.isArray(parcel.supportSize)) throw new Error('Invalid QQ parcel metadata');
    let detail = null;
    let detailsAvailable = false;
    try {
      const extra = JSON.parse((await this.read(infoUrl, this.maxMetadataBytes, 'qq', signal)).toString('utf8'));
      detail = extra?.data?.baseInfo?.[0] ?? null;
      detailsAvailable = detail !== null;
    } catch (error) {
      if (signal?.aborted) throw error;
      // Optional public description can be unavailable; parcel metadata remains authoritative.
    }
    const indexed = this.index.get(id);
    const title = clean(detail?.name || parcel.name || indexed?.title);
    const description = clean(detail?.desc || indexed?.description, 2000);
    const tags = tagsOf(detail?.tag ?? indexed?.tags ?? []);
    const keywords = roleMatches(`${title} ${description} ${tags.join(' ')}`);
    const pack = {
      packId: id, title, description, tags, roleKeywords: keywords, metadataUrl, infoUrl,
      detailsAvailable, fetchedAt: this.now(), source: 'qq-official-cdn', roleVerified: false,
      rightsMetadata: {
        author: clean(parcel.author), rights: clean(parcel.rights), status: clean(parcel.status),
        feeType: clean(parcel.feetype), price: clean(parcel.price), isOriginal: clean(parcel.isOriginal),
      },
    };
    if (!keywords.length) return { status: 'no-role-match', pack, items: [] };
    const size = parcel.supportSize[0];
    const height = dimension(size?.Height), width = dimension(size?.Width);
    const items = [];
    let rejected = 0;
    for (const asset of parcel.imgs.slice(0, this.maxAssetsPerPack)) {
      if (!asset || typeof asset.id !== 'string' || !/^[a-f0-9]{32}$/iu.test(asset.id)) { rejected += 1; continue; }
      const assetId = asset.id.toLowerCase();
      const assetBase = `${QQ_ORIGIN}/club/item/parcel/item/${assetId.slice(0, 2)}/${assetId}`;
      const candidate = {
        id: `qq-pack:${id}:${assetId}`, packId: id, packTitle: title, assetId,
        label: clean(asset.name), tags: [...new Set([...tags, ...tagsOf(asset.keywords)])], width, height,
        thumbnailUrl: `${assetBase}/${height}x${width}.png`, dynamicUrl: `${assetBase}/raw${height}.gif`,
        source: 'qq-official-cdn', sourceUrl: metadataUrl, sourceIndexUrl: this.indexUrl,
        roleKeywords: keywords, roleEvidence: 'public-metadata-keyword-only', roleVerified: false, sendable: false,
      };
      this.candidates.delete(candidate.id);
      this.candidates.set(candidate.id, candidate);
      items.push(structuredClone(candidate));
    }
    while (this.candidates.size > this.maxCandidates) this.candidates.delete(this.candidates.keys().next().value);
    return { status: 'candidates-unverified', pack, items, rejected, truncated: parcel.imgs.length > this.maxAssetsPerPack };
  }

  /**
   * Explicit local caching for review. Only IDs returned by inspectPack are accepted;
   * content is signature checked, content-addressed, and never automatically made sendable.
   */
  async cacheAsset(id, { variant = 'static', signal } = {}) {
    if (!this.cacheDir) throw new Error('QQ sticker cache directory is not configured');
    if (!['static', 'dynamic'].includes(variant)) throw new Error('Unsupported QQ asset variant');
    const candidate = this.candidates.get(id);
    if (!candidate) throw new Error('Unknown or expired QQ asset candidate');
    const sourceUrl = variant === 'static' ? candidate.thumbnailUrl : candidate.dynamicUrl;
    const bytes = await this.read(sourceUrl, this.maxAssetBytes, 'qq', signal);
    const mimeType = imageMime(bytes, variant);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await mkdir(this.cacheDir, { recursive: true });
    const root = await realpath(this.cacheDir);
    const extension = variant === 'static' ? 'png' : 'gif';
    const filePath = path.join(root, `qq-${candidate.packId}-${candidate.assetId}-${sha256}.${extension}`);
    if (!inside(root, filePath)) throw new Error('Invalid QQ cache destination');
    let handle;
    try {
      handle = await open(filePath, 'wx', 0o600);
      await handle.writeFile(bytes);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxAssetBytes || !inside(root, await realpath(filePath))) throw new Error('Unsafe existing QQ cache entry');
      const existing = await open(filePath, 'r');
      try {
        const content = await existing.readFile();
        if (createHash('sha256').update(content).digest('hex') !== sha256) throw new Error('QQ cache hash mismatch');
      } finally { await existing.close(); }
    } finally { await handle?.close(); }
    return {
      ...structuredClone(candidate), sourceUrl, filePath, sha256, mimeType, size: bytes.length,
      cachedAt: this.now(), roleVerified: false, sendable: false,
      attribution: { source: 'QQ official sticker CDN', metadataUrl: candidate.sourceUrl, packId: candidate.packId },
    };
  }

  status() { return { ...structuredClone(this.indexState), registeredCandidates: this.candidates.size, roleVerification: 'required-before-use' }; }
}
