import { randomUUID, createHash } from 'node:crypto';

export const DEFAULTS = Object.freeze({
  idleMs: 30000, highWindowMs: 30000, minAmbientMessages: 5, ambientCooldownMs: 30000,
  ambientMaxWaitMs: 60000, maxDirectStreak: 3, directThreshold: 0.8,
  highThreshold: 0.65, idleThreshold: 0.6, aliases: ['鲸鱼'],
  contextLimit: 20, contextWindowMs: 120000, maxAmbient: 100, maxDirect: 256,
  maxBatchMessages: 16, maxDirectPerBatch: 4, maxAuthors: 8, maxSeen: 2000,
  maxAttempts: 2, retryDelayMs: 5000, maxTextChars: 8000, maxReplyChars: 2000,
  maxTaskHistory: 200, maxOutbox: 1000, maxUnresolvedTasks: 32,
});

export function resolveConfig(input = {}) {
  const config = { ...DEFAULTS, ...input };
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'aliases') continue;
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['directThreshold', 'highThreshold', 'idleThreshold']) {
    if (config[key] > 1) throw new Error(`${key} must be <= 1`);
  }
  for (const key of ['contextLimit', 'maxAmbient', 'maxDirect', 'maxBatchMessages', 'maxDirectPerBatch', 'maxAuthors', 'maxSeen', 'maxAttempts', 'maxTaskHistory', 'maxOutbox', 'maxUnresolvedTasks', 'maxTextChars', 'maxReplyChars', 'minAmbientMessages', 'maxDirectStreak']) {
    if (!Number.isInteger(config[key])) throw new Error(`${key} must be an integer`);
  }
  if (config.maxAuthors > 8 || config.maxBatchMessages > 64 || config.minAmbientMessages < 5) throw new Error('Batch or ambient limits exceed bridge/user contract');
  if (!Array.isArray(config.aliases) || !config.aliases.length || config.aliases.some(x => typeof x !== 'string' || !x.trim())) throw new Error('aliases must be nonempty strings');
  config.aliases = config.aliases.map(alias => alias.trim());
  return config;
}

function messageId(value, field) {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

export function normalizeMessage(event, now, config) {
  if (!event || !Number.isFinite(now)) throw new Error('Invalid event/time');
  const mentions = Array.isArray(event.mentions) ? event.mentions.map(String).slice(0, 64) : [];
  const botId = String(event.botId ?? '');
  const authorId = messageId(event.authorId, 'authorId');
  const sourceText = String(event.text ?? '');
  return {
    groupId: messageId(event.groupId, 'groupId'), sessionId: String(event.sessionId ?? ''),
    messageId: messageId(event.messageId, 'messageId'), authorId,
    displayName: String(event.displayName ?? '').slice(0, 200), botId,
    self: event.self === true || (!!botId && authorId === botId), time: Number.isFinite(event.time) ? event.time : now,
    // The bridge delivers its original, at-most-24000-character record by ID, not this routing excerpt.
    receivedAt: now, text: sourceText.slice(0, config.maxTextChars), sourceTextChars: Math.min(sourceText.length, 24000), mentions,
    replyTo: event.replyTo ? {
      id: String(event.replyTo.id ?? event.replyTo.messageId ?? ''),
      authorId: event.replyTo.authorId == null ? null : String(event.replyTo.authorId),
      self: event.replyTo.self === true || event.replyTo.isSelf === true || (!!botId && String(event.replyTo.authorId ?? '') === botId),
    } : null,
    images: Array.isArray(event.images) ? structuredClone(event.images.slice(0, 8)) : [],
  };
}

/** A routing score, not a calibrated probability. Quoted authors outrank ambiguous pronouns. */
export function directedConfidence(message, recent, config) {
  if (message.self) return { score: 0, reason: 'self' };
  const text = message.text;
  if (config.aliases.some(name => text.toLocaleLowerCase().includes(name.toLocaleLowerCase()))) return { score: 1, reason: 'name' };
  if (message.botId && message.mentions.includes(message.botId)) return { score: 1, reason: 'mention' };
  if (message.replyTo?.self) return { score: 1, reason: 'reply-to-self' };
  if (message.replyTo?.authorId && message.replyTo.authorId !== message.botId) return { score: 0.05, reason: 'reply-to-other' };
  if (message.replyTo?.id) {
    const quoted = recent.find(item => item.messageId === message.replyTo.id);
    if (quoted?.self) return { score: 1, reason: 'reply-to-self' };
    return { score: quoted ? 0.05 : 0.45, reason: quoted ? 'reply-to-other' : 'reply-author-unknown' };
  }
  if (message.mentions.some(id => id !== message.botId && id !== 'all')) return { score: 0.1, reason: 'mention-other' };
  if (!/(?:你|您|\byou\b)/iu.test(text)) return { score: 0.15, reason: 'ambient' };
  const window = recent.filter(m => m.messageId !== message.messageId && message.receivedAt - m.receivedAt <= config.contextWindowMs).slice(-5);
  const last = window.at(-1);
  if (!last) return { score: 0.45, reason: 'pronoun-no-context' };
  if (last.self) {
    if (last.recipientAuthorId && last.recipientAuthorId !== message.authorId) return { score: 0.45, reason: 'pronoun-other-recipient' };
    return { score: last.recipientAuthorId === message.authorId ? 0.95 : 0.85, reason: 'pronoun-after-self' };
  }
  // A user's consecutive clarification may continue their own exchange with the bot.
  if (last.authorId === message.authorId) {
    const prior = window.slice(0, -1).at(-1);
    if (prior?.self && prior.recipientAuthorId === message.authorId) return { score: 0.85, reason: 'pronoun-continuation' };
  }
  return { score: 0.2, reason: 'pronoun-after-human' };
}

function ambientScore(message, count, idle) {
  if (!message || message.self || (!message.text.trim() && !message.images.length)) return 0;
  if (/^(?:嗯+|哦+|好[的吧]?|哈哈+|[.。…]+|\s+)$/u.test(message.text.trim()) && !message.images.length) return idle ? 0.4 : 0.5;
  return Math.min(1, (idle ? 0.6 : 0.55) + (count >= 5 ? 0.1 : 0) + (/[?？]|怎么|为什么|觉得/u.test(message.text) ? 0.1 : 0) + (message.text.length >= 8 ? 0.05 : 0));
}

function newGroup() {
  return { recent: [], ambient: [], direct: [], seen: [], lastActivityAt: null, activityVersion: 0,
    lastSpeakerSelf: false, idleConsumedVersion: 0, lastAmbientAt: null, activeTaskId: null,
    directStreak: 0, lastDirectAuthor: null, notBefore: 0, failures: [] };
}

/** Pure scheduling state. The host persists every accepted event before acknowledging the bridge. */
export class ConversationScheduler {
  constructor(config = {}, { state, idFactory = randomUUID } = {}) {
    this.config = resolveConfig(config);
    this.idFactory = idFactory;
    this.state = state ? structuredClone(state) : { schema: 1, groups: {}, tasks: {}, outbox: {} };
    if (this.state.schema !== 1 || !this.state.groups || !this.state.tasks || !this.state.outbox) throw new Error('Unsupported scheduler state');
  }
  exportState() { return structuredClone(this.state); }
  unresolvedCount() { return Object.values(this.state.tasks).filter(task => task.status === 'uncertain' || task.requiresReview).length; }
  group(id) {
    if (!Object.hasOwn(this.state.groups, id)) Object.defineProperty(this.state.groups, id, { value: newGroup(), writable: true, enumerable: true, configurable: true });
    return this.state.groups[id];
  }
  ingest(event, now = Date.now()) {
    const message = normalizeMessage(event, now, this.config);
    const group = this.group(message.groupId);
    if (group.seen.includes(message.messageId)) return { accepted: true, duplicate: true };
    const decision = directedConfidence(message, group.recent, this.config);
    // One group clock. Even a rejected overflow event invalidates a pending silence response.
    group.lastActivityAt = now; group.activityVersion++; group.lastSpeakerSelf = message.self;
    if (!message.self && this.unresolvedCount() >= this.config.maxUnresolvedTasks) return { accepted: false, reason: 'review-capacity', decision };
    if (decision.score >= this.config.directThreshold && group.direct.length >= this.config.maxDirect) {
      return { accepted: false, reason: 'direct-capacity', decision };
    }
    group.seen.push(message.messageId); group.seen = group.seen.slice(-this.config.maxSeen);
    group.recent.push(message); group.recent = group.recent.slice(-this.config.contextLimit);
    if (message.self) return { accepted: true, decision };
    if (decision.score >= this.config.directThreshold) group.direct.push({ message, decision, attempts: 0 });
    else { group.ambient.push(message); group.ambient = group.ambient.slice(-this.config.maxAmbient); }
    return { accepted: true, decision };
  }
  ambientCandidate(group, now) {
    if (!group.ambient.length) return null;
    if (group.lastAmbientAt !== null && now - group.lastAmbientAt < this.config.ambientCooldownMs) return null;
    const last = group.recent.at(-1);
    // Silence follows the group's last speaker; hot-chat readiness is independent of the direct lane.
    const quietFor = now - group.lastActivityAt;
    if (!group.lastSpeakerSelf && last && group.ambient.some(m => m.messageId === last.messageId) && quietFor >= this.config.idleMs && group.idleConsumedVersion !== group.activityVersion) {
      const score = ambientScore(last, group.ambient.length, true);
      if (score >= this.config.idleThreshold) return { kind: 'idle', score, dueAt: group.lastActivityAt + this.config.idleMs, target: last };
    }
    // Count unconsumed messages even when continuous conversation spans many 30-second windows.
    // highWindowMs remains accepted for configuration compatibility; silence defines the mode.
    const pending = group.ambient;
    if (quietFor < this.config.idleMs && pending.length >= this.config.minAmbientMessages) {
      const target = pending.at(-1);
      const score = ambientScore(target, pending.length, false);
      if (score >= this.config.highThreshold) return { kind: 'high', score, dueAt: pending[this.config.minAmbientMessages - 1].receivedAt, target };
    }
    return null;
  }
  preview(groupId, now = Date.now()) {
    const group = this.group(groupId);
    if (group.activeTaskId) return null;
    const activeCount = Object.values(this.state.groups).filter(item => item.activeTaskId).length;
    if (this.unresolvedCount() + activeCount >= this.config.maxUnresolvedTasks) return null;
    const readyDirect = group.direct.filter(item => now >= (item.notBefore ?? 0));
    const ambient = now >= group.notBefore ? this.ambientCandidate(group, now) : null;
    const chooseAmbient = ambient && (!readyDirect.length || group.directStreak >= this.config.maxDirectStreak || now - ambient.dueAt >= this.config.ambientMaxWaitMs);
    if (chooseAmbient) return { kind: ambient.kind, score: ambient.score, dueAt: ambient.dueAt, target: ambient.target.messageId };
    if (readyDirect.length) return { kind: 'direct', count: readyDirect.length };
    return null;
  }
  plan(groupId, now = Date.now()) {
    const preview = this.preview(groupId, now);
    if (!preview) return null;
    const group = this.group(groupId);
    let selected, directItems = [];
    let sourceChars = 0;
    // Older persisted routing excerpts cannot reveal their original length; reserve the per-record maximum.
    const sourceSize = message => Number.isFinite(message.sourceTextChars)
      ? Math.max(0, Math.min(24000, message.sourceTextChars)) : 24000;
    const fits = message => sourceChars + sourceSize(message) <= 64000;
    if (preview.kind === 'direct') {
      const byAuthor = new Map();
      for (const item of group.direct) {
        if (now < (item.notBefore ?? 0)) continue;
        const items = byAuthor.get(item.message.authorId) ?? [];
        items.push(item); byAuthor.set(item.message.authorId, items);
      }
      const authors = [...byAuthor.keys()];
      if (authors.length > 1 && authors[0] === group.lastDirectAuthor) authors.push(authors.shift());
      while (directItems.length < this.config.maxDirectPerBatch && byAuthor.size) {
        for (const author of authors) {
          const items = byAuthor.get(author);
          if (!items?.length) continue;
          if (!fits(items[0].message)) { byAuthor.delete(author); continue; }
          sourceChars += sourceSize(items[0].message);
          directItems.push(items.shift()); group.lastDirectAuthor = author;
          if (!items.length) byAuthor.delete(author);
          if (directItems.length >= Math.min(this.config.maxDirectPerBatch, this.config.maxBatchMessages, this.config.maxAuthors)) break;
        }
        if (directItems.length >= Math.min(this.config.maxDirectPerBatch, this.config.maxBatchMessages, this.config.maxAuthors)) break;
      }
      selected = directItems.map(item => item.message);
      const ids = new Set(selected.map(m => m.messageId));
      group.direct = group.direct.filter(item => !ids.has(item.message.messageId));
    } else {
      const authors = new Set(); selected = [];
      for (const item of [...group.ambient].reverse()) {
        if (authors.size >= this.config.maxAuthors && !authors.has(item.authorId)) continue;
        if (!fits(item)) continue;
        sourceChars += sourceSize(item);
        selected.unshift(item); authors.add(item.authorId);
        if (selected.length >= this.config.maxBatchMessages) break;
      }
    }
    const task = {
      id: this.idFactory(), groupId, kind: preview.kind, createdAt: now, status: 'planned',
      activityVersion: group.activityVersion, messageIds: selected.map(m => m.messageId),
      coveredAmbientIds: preview.kind === 'direct' ? [] : group.ambient.map(message => message.messageId),
      messages: structuredClone(selected), directItems: structuredClone(directItems), repliedIds: [],
      ordinarySent: false, skipped: false, errors: [],
    };
    this.state.tasks[task.id] = task; group.activeTaskId = task.id;
    this.prune();
    return structuredClone(task);
  }
  task(id) { return Object.hasOwn(this.state.tasks, id) ? this.state.tasks[id] : null; }
  activeFor(groupId) { return this.task(this.group(groupId).activeTaskId); }
  activeForAgent(agent, bridge) {
    return Object.values(this.state.tasks).find(task => this.group(task.groupId).activeTaskId === task.id && bridge.agentFor(task.groupId) === agent) ?? null;
  }
  dispatched(id) { const task = this.requireActive(id); task.status = 'dispatched'; }
  requireActive(id) {
    const task = this.task(id);
    if (!task || this.group(task.groupId).activeTaskId !== id) throw new Error('No active QQ task');
    return task;
  }
  canReply(id, replyToMessageId, now = Date.now()) {
    const task = this.requireActive(id), group = this.group(task.groupId);
    const target = replyToMessageId || null;
    if (task.skipped) return { ok: false, reason: 'task-already-skipped' };
    if (task.kind === 'direct' && (!target || !task.messageIds.includes(target))) return { ok: false, reason: 'direct-requires-reference' };
    if (target && !task.messageIds.includes(target)) return { ok: false, reason: 'reference-outside-batch' };
    if (task.kind === 'idle' && (task.activityVersion !== group.activityVersion || now - group.lastActivityAt < this.config.idleMs)) return { ok: false, reason: 'group-no-longer-silent' };
    if (task.kind !== 'direct' && task.ordinarySent) return { ok: false, reason: 'ordinary-already-sent' };
    if (task.kind !== 'direct' && Object.values(this.state.outbox).some(intent => intent.taskId === id && intent.replyToMessageId !== target)) return { ok: false, reason: 'ordinary-send-already-reserved' };
    if (target && task.repliedIds.includes(target)) return { ok: false, reason: 'reference-already-sent' };
    return { ok: true };
  }
  prepareReply(id, { replyToMessageId = null, text, stickerId = null }, now = Date.now()) {
    const task = this.requireActive(id);
    replyToMessageId ||= null;
    const key = createHash('sha256').update(JSON.stringify([id, replyToMessageId])).digest('hex');
    const existing = this.state.outbox[key];
    if (existing && existing.status !== 'pending') return { ...structuredClone(existing), existing: true };
    const verdict = this.canReply(id, replyToMessageId, now);
    if (!verdict.ok) throw new Error(verdict.reason);
    if (typeof text !== 'string' || text.length > this.config.maxReplyChars || (!text.trim() && !stickerId)) throw new Error('Invalid reply text');
    if (existing) return { ...structuredClone(existing), existing: true };
    const intent = { key, taskId: id, groupId: task.groupId, replyToMessageId, text, stickerId,
      status: 'pending', createdAt: now };
    this.state.outbox[key] = intent;
    return structuredClone(intent);
  }
  settleReply(key, receipt, now = Date.now()) {
    const intent = this.state.outbox[key];
    if (!intent) throw new Error('Unknown send intent');
    if (intent.status === 'sent') return;
    const sentId = receipt.ok && receipt.messageId ? messageId(String(receipt.messageId), 'receipt.messageId') : null;
    // A generic error is not proof that an earlier ambiguous network send failed.
    if (intent.status === 'uncertain' && !sentId && receipt.confirmedNotSent !== true) return;
    intent.status = sentId ? 'sent' : receipt.uncertain ? 'uncertain' : 'failed';
    intent.messageId = sentId; intent.settledAt = now;
    intent.error = receipt.error ? String(receipt.error).slice(0, 500) : null;
    const task = this.task(intent.taskId);
    if (!task || intent.status !== 'sent') return;
    const group = this.group(task.groupId);
    if (intent.replyToMessageId) task.repliedIds.push(intent.replyToMessageId);
    if (task.reviewMessageIds) task.reviewMessageIds = task.kind === 'direct' ? task.reviewMessageIds.filter(id => id !== intent.replyToMessageId) : [];
    if (task.kind !== 'direct') {
      task.ordinarySent = true; group.lastAmbientAt = now;
      const consumed = new Set(task.coveredAmbientIds ?? task.messageIds); group.ambient = group.ambient.filter(m => !consumed.has(m.messageId));
      group.idleConsumedVersion = task.activityVersion;
    }
    const target = task.messages.find(m => m.messageId === intent.replyToMessageId);
    group.lastActivityAt = now; group.activityVersion++; group.lastSpeakerSelf = true;
    group.recent.push({ messageId: intent.messageId, groupId: task.groupId, authorId: 'self', self: true,
      text: intent.text, images: [], receivedAt: now, recipientAuthorId: target?.authorId ?? null });
    group.recent = group.recent.slice(-this.config.contextLimit);
    group.seen.push(intent.messageId); group.seen = group.seen.slice(-this.config.maxSeen);
    if (task.status === 'uncertain' && !Object.values(this.state.outbox).some(item => item.taskId === task.id && ['pending', 'uncertain'].includes(item.status))) {
      task.status = task.kind === 'direct' && !task.messageIds.every(mid => task.repliedIds.includes(mid)) ? 'failed' : 'sent';
      task.requiresReview = (task.reviewMessageIds?.length ?? 0) > 0;
    }
  }
  skip(id, reason) {
    const task = this.requireActive(id);
    if (task.kind === 'direct') throw new Error('Direct requests cannot be silently skipped');
    task.skipped = true; task.skipReason = String(reason).slice(0, 300);
    const group = this.group(task.groupId);
    const covered = new Set(task.coveredAmbientIds ?? task.messageIds); group.ambient = group.ambient.filter(m => !covered.has(m.messageId));
    group.idleConsumedVersion = task.activityVersion;
  }
  finish(id, now = Date.now(), error = null) {
    const task = this.task(id);
    if (!task || this.group(task.groupId).activeTaskId !== id) return;
    const group = this.group(task.groupId);
    const uncertain = Object.values(this.state.outbox).filter(x => x.taskId === id && ['pending', 'uncertain'].includes(x.status));
    const sent = task.kind === 'direct' ? task.messageIds.every(mid => task.repliedIds.includes(mid)) : task.ordinarySent;
    task.status = uncertain.length ? 'uncertain' : sent ? 'sent' : task.skipped ? 'skipped' : 'failed';
    task.requiresReview = uncertain.length > 0;
    task.reviewMessageIds = [];
    task.finishedAt = now;
    if (error) task.errors.push(String(error).slice(0, 500));
    if (task.kind === 'direct') {
      group.directStreak++;
      const uncertainTargets = new Set(uncertain.map(intent => intent.replyToMessageId));
      for (const item of task.directItems) {
        if (task.repliedIds.includes(item.message.messageId)) continue;
        const attempts = item.attempts + 1;
        if (!uncertainTargets.has(item.message.messageId) && attempts < this.config.maxAttempts && group.direct.length < this.config.maxDirect) group.direct.push({ ...item, attempts, notBefore: now + this.config.retryDelayMs });
        else {
          task.requiresReview = true;
          task.reviewMessageIds.push(item.message.messageId);
          group.failures.push({ taskId: id, messageId: item.message.messageId, authorId: item.message.authorId,
            reason: uncertainTargets.has(item.message.messageId) ? 'send-uncertain-review-required' : attempts >= this.config.maxAttempts ? 'attempts-exhausted' : 'retry-capacity-review-required', at: now });
        }
      }
    } else {
      group.directStreak = 0;
      if (!sent && !task.skipped) {
        const covered = new Set(task.coveredAmbientIds ?? task.messageIds);
        if (uncertain.length) {
          // Keep the archived task and intent, but never automatically replay an ambiguous send.
          group.ambient = group.ambient.filter(message => !covered.has(message.messageId));
          group.idleConsumedVersion = task.activityVersion;
          task.reviewMessageIds = [...task.messageIds];
        } else {
          for (const message of group.ambient) if (covered.has(message.messageId)) message.ambientAttempts = (message.ambientAttempts ?? 0) + 1;
          const exhausted = group.ambient.filter(message => (message.ambientAttempts ?? 0) >= this.config.maxAttempts);
          group.ambient = group.ambient.filter(message => (message.ambientAttempts ?? 0) < this.config.maxAttempts);
          if (exhausted.length) group.failures.push({ taskId: id, reason: 'ambient-attempts-exhausted', at: now });
        }
        group.notBefore = now + this.config.retryDelayMs;
      }
    }
    group.failures = group.failures.slice(-100); group.activeTaskId = null;
    this.prune();
  }
  recover() {
    for (const group of Object.values(this.state.groups)) {
      if (!group.activeTaskId) continue;
      const task = this.task(group.activeTaskId);
      if (task) {
        task.status = 'uncertain'; task.requiresReview = true; task.errors.push('Interrupted by process restart; manual review required');
        task.reviewMessageIds = task.messageIds.filter(id => !task.repliedIds.includes(id));
        if (task.kind !== 'direct') {
          const covered = new Set(task.coveredAmbientIds ?? task.messageIds);
          group.ambient = group.ambient.filter(message => !covered.has(message.messageId));
          group.idleConsumedVersion = task.activityVersion;
        }
      }
      group.failures.push({ taskId: group.activeTaskId, reason: 'restart-uncertain-review-required' });
      group.activeTaskId = null;
    }
    for (const intent of Object.values(this.state.outbox)) if (intent.status === 'pending') intent.status = 'uncertain';
  }
  prune() {
    const finished = Object.values(this.state.tasks).filter(t => this.group(t.groupId).activeTaskId !== t.id && t.status !== 'uncertain' && !t.requiresReview);
    for (const task of finished.slice(0, Math.max(0, finished.length - this.config.maxTaskHistory))) delete this.state.tasks[task.id];
    const settled = Object.values(this.state.outbox).filter(intent => {
      const task = this.task(intent.taskId);
      return ['sent', 'failed'].includes(intent.status) && (!task || (this.group(task.groupId).activeTaskId !== task.id && task.status !== 'uncertain' && !task.requiresReview));
    });
    for (const intent of settled.slice(0, Math.max(0, settled.length - this.config.maxOutbox))) delete this.state.outbox[intent.key];
  }
  status(now = Date.now()) {
    return Object.entries(this.state.groups).map(([groupId, group]) => ({ groupId,
      directPending: group.direct.length, ambientBuffered: group.ambient.length,
      quietMs: group.lastActivityAt === null ? null : Math.max(0, now - group.lastActivityAt),
      activeTaskId: group.activeTaskId, next: this.preview(groupId, now), failures: group.failures.length,
      unresolvedTasks: Object.values(this.state.tasks).filter(task => task.groupId === groupId && (task.status === 'uncertain' || task.requiresReview)).length,
      reviewBlocked: this.unresolvedCount() >= this.config.maxUnresolvedTasks }));
  }
}
