const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAVER_DIR = path.join(__dirname, '..', '.token-saver');
const STORE_FILE = path.join(SAVER_DIR, 'store.json');
const STATS_FILE = path.join(SAVER_DIR, 'stats.json');

// --- ContextStore: local file + memory backed cache for offloaded context ---
class ContextStore {
  constructor(maxEntries = 500, ttlMs = 3600000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this._map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.offloads = 0;
    this.bytesSaved = 0;
    this._load();
  }

  _storePath() { return STORE_FILE; }

  _load() {
    try {
      if (!fs.existsSync(SAVER_DIR)) fs.mkdirSync(SAVER_DIR, { recursive: true });
      if (fs.existsSync(STORE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        if (data.entries) {
          for (const [k, v] of Object.entries(data.entries)) {
            if (Date.now() - v.savedAt < this.ttlMs) {
              this._map.set(k, v);
            }
          }
        }
        this.hits = data.hits || 0;
        this.misses = data.misses || 0;
        this.evictions = data.evictions || 0;
        this.offloads = data.offloads || 0;
        this.bytesSaved = data.bytesSaved || 0;
      }
    } catch (e) { /* ignore corrupt cache */ }
  }

  _save() {
    try {
      if (!fs.existsSync(SAVER_DIR)) fs.mkdirSync(SAVER_DIR, { recursive: true });
      const obj = {};
      for (const [k, v] of this._map) obj[k] = v;
      fs.writeFileSync(STORE_FILE, JSON.stringify({
        entries: obj,
        hits: this.hits, misses: this.misses,
        evictions: this.evictions, offloads: this.offloads,
        bytesSaved: this.bytesSaved,
        updatedAt: Date.now(),
      }));
    } catch (e) { /* ignore write errors */ }
  }

  put(key, value, meta = {}) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.maxEntries) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      this.evictions++;
    }
    const entry = {
      value,
      meta: { ...meta, savedAt: Date.now() },
      size: typeof value === 'string' ? value.length : JSON.stringify(value).length,
    };
    this._map.set(key, entry);
    this.offloads++;
    this.bytesSaved += entry.size;
    this._save();
    return key;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.meta.savedAt > this.ttlMs) {
      this._map.delete(key);
      this.misses++;
      return null;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  remove(key) {
    this._map.delete(key);
    this._save();
  }

  clear() {
    this._map.clear();
    this.hits = 0; this.misses = 0; this.evictions = 0;
    this.offloads = 0; this.bytesSaved = 0;
    this._save();
  }

  get stats() {
    return {
      size: this._map.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      offloads: this.offloads,
      bytesSaved: this.bytesSaved,
      bytesSavedFormatted: this._formatBytes(this.bytesSaved),
    };
  }

  _formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  hash(content) { return crypto.createHash('sha256').update(typeof content === 'string' ? content : JSON.stringify(content)).digest('hex').slice(0, 16); }
}

// --- SmartCompressor: JSON array compression with CCR markers ---
class SmartCompressor {
  constructor(store, options = {}) {
    this.store = store;
    this.minItems = options.minItems || 5;
    this.maxItems = options.maxItems || 15;
    this.firstFraction = options.firstFraction || 0.3;
    this.lastFraction = options.lastFraction || 0.15;
    this.varianceThreshold = options.varianceThreshold || 2.0;
  }

  compress(text, sessionId) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/(\[[\s\S]*?\])/g, (match) => {
      try {
        const arr = JSON.parse(match);
        if (!Array.isArray(arr) || arr.length < this.minItems) return match;
        return this._compressArray(arr, match, sessionId);
      } catch { return match; }
    });
  }

  _compressArray(arr, original, sessionId) {
    const n = arr.length;
    const firstN = Math.max(1, Math.floor(n * this.firstFraction));
    const lastN = Math.max(1, Math.floor(n * this.lastFraction));
    const keep = new Set();

    for (let i = 0; i < firstN && i < n; i++) keep.add(i);
    for (let i = n - lastN; i < n; i++) keep.add(i);

    const numericCols = this._findNumericColumns(arr);
    for (const col of numericCols) {
      const vals = arr.map(r => r[col]).filter(v => typeof v === 'number');
      if (vals.length < 2) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      const std = Math.sqrt(variance);
      for (let i = 0; i < n; i++) {
        const v = arr[i][col];
        if (typeof v === 'number' && Math.abs(v - mean) > this.varianceThreshold * std) {
          keep.add(i);
        }
      }
    }

    const kept = arr.filter((_, i) => keep.has(i));
    if (kept.length === arr.length) return original;

    const h = this.store.hash(original);
    this.store.put(h, arr, { type: 'json_array', sessionId, originalLength: n, keptLength: kept.length });

    kept.push({ _ccr: `<<${h}:${n - kept.length}>>` });
    return JSON.stringify(kept);
  }

  _findNumericColumns(arr) {
    if (arr.length < 2) return [];
    const cols = new Set();
    for (const key of Object.keys(arr[0] || {})) {
      const vals = arr.map(r => r[key]).filter(v => v != null);
      if (vals.length > arr.length * 0.5 && vals.every(v => typeof v === 'number')) {
        cols.add(key);
      }
    }
    return [...cols];
  }
}

// --- CodeCompressor: AST-aware code compression with CCR ---
class CodeCompressor {
  constructor(store, options = {}) {
    this.store = store;
    this.targetRate = options.targetRate || 0.2;
    this.minTokens = options.minTokens || 100;
    this.preserveImports = options.preserveImports !== false;
    this.preserveSignatures = options.preserveSignatures !== false;
  }

  compress(text, sessionId) {
    if (!text || typeof text !== 'string') return text;
    if (text.length < 100) return text;
    return text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const compressed = this._compressCode(code, lang, sessionId);
      return '```' + lang + '\n' + compressed + '\n```';
    });
  }

  _compressCode(code, lang, sessionId) {
    if (code.length < 100) return code;
    const lines = code.split('\n');
    if (lines.length < 5) return code;

    const langLower = (lang || '').toLowerCase();
    const isJsLike = /^(js|javascript|ts|typescript|jsx|tsx|mjs|cjs)$/.test(langLower);
    const isPy = /^py|python$/.test(langLower);
    const isRs = /^rs|rust$/.test(langLower);
    const isGo = /^go$/.test(langLower);
    const isJava = /^java$/.test(langLower);

    const result = [];
    let bodyStart = -1;
    let braceDepth = 0;
    let inBody = false;
    let skippedLines = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (this.preserveImports && (trimmed.startsWith('import ') || trimmed.startsWith('from ') || trimmed.startsWith('require(') || trimmed.startsWith('#include') || trimmed.startsWith('use ') || trimmed.startsWith('package ') || trimmed.startsWith('namespace ') || trimmed.startsWith('using ') || trimmed.startsWith('module.exports') || trimmed.startsWith('export ') || trimmed.startsWith('# ') || trimmed.startsWith('@') || trimmed.startsWith('// ') && /^(TODO|FIXME|HACK|BUG|XXX|NOTE|IMPORTANT|CRITICAL)/.test(trimmed.slice(3)))) {
        if (skippedLines > 0) { result.push(`  ...[${skippedLines} lines compressed]`); skippedLines = 0; }
        result.push(line);
        continue;
      }

      if (this.preserveSignatures && /^\s*(\w+\s+)?(function|def|class|interface|type|enum|struct|trait|impl|fn|pub|async|export|const\s+\w+\s*[:=]|let\s+\w+\s*[:=]|var\s+\w+\s*[:=])\s/.test(trimmed)) {
        if (skippedLines > 0) { result.push(`  ...[${skippedLines} lines compressed]`); skippedLines = 0; }
        const sigEnd = trimmed.indexOf('{');
        if (sigEnd >= 0) {
          result.push(line.replace(trimmed, trimmed.substring(0, sigEnd).trim() + ' { ... }'));
          inBody = true;
          braceDepth = 1;
          bodyStart = i;
        } else if (isPy && trimmed.endsWith(':')) {
          result.push(trimmed + '\n    ...');
          inBody = true;
          bodyStart = i;
          braceDepth = 999;
        } else {
          result.push(line);
        }
        continue;
      }

      if (inBody) {
        if (isPy) {
          const indent = line.search(/\S/);
          if (indent <= 0 || indent < 4) { inBody = false; skippedLines = 0; result.push(line); continue; }
          skippedLines++;
          continue;
        }
        for (const ch of line) {
          if (ch === '{') braceDepth++;
          if (ch === '}') braceDepth--;
        }
        if (braceDepth <= 0) { inBody = false; skippedLines = 0; result.push(line); continue; }
        skippedLines++;
        continue;
      }

      if (trimmed === '' || /^\s*\/\//.test(trimmed) || /^\s*#/.test(trimmed) || /^\s*\/\*/.test(trimmed) || /^\s*\*/.test(trimmed) || /^\s*\/\//.test(trimmed)) {
        skippedLines++;
        continue;
      }

      if (skippedLines > 0) { result.push(`  ...[${skippedLines} lines compressed]`); skippedLines = 0; }
      result.push(line);
    }

    if (skippedLines > 0) result.push(`  ...[${skippedLines} lines compressed]`);

    const out = result.join('\n');
    const h = this.store.hash(code);
    this.store.put(h, code, { type: 'code', lang, sessionId, originalLines: lines.length, compressedLines: result.length });
    return out + `\n/*<<ctx:${h}>*/`;
  }
}

// --- ContextManager: orchestrates offloading, shared context, and retrieval ---
class ContextManager {
  constructor(options = {}) {
    this.store = new ContextStore(options.maxEntries || 500, options.ttlMs || 3600000);
    this.smartCompressor = new SmartCompressor(this.store, options);
    this.codeCompressor = new CodeCompressor(this.store, options);
    this.enabled = options.enabled !== false;
    this.autoOffload = options.autoOffload !== false;
    this.offloadThreshold = options.offloadThreshold || 2000;
    this.sessions = new Map();
    this._loadSessions();
  }

  _sessionsPath() { return path.join(SAVER_DIR, 'sessions.json'); }

  _loadSessions() {
    try {
      if (fs.existsSync(this._sessionsPath())) {
        const data = JSON.parse(fs.readFileSync(this._sessionsPath(), 'utf8'));
        if (data.sessions) {
          for (const [k, v] of Object.entries(data.sessions)) {
            this.sessions.set(k, v);
          }
        }
      }
    } catch {}
  }

  _saveSessions() {
    try {
      if (!fs.existsSync(SAVER_DIR)) fs.mkdirSync(SAVER_DIR, { recursive: true });
      const obj = {};
      for (const [k, v] of this.sessions) obj[k] = v;
      fs.writeFileSync(this._sessionsPath(), JSON.stringify({ sessions: obj, updatedAt: Date.now() }));
    } catch {}
  }

  getSessionContext(fingerprint) {
    if (!fingerprint) return null;
    return this.sessions.get(fingerprint) || null;
  }

  updateSessionContext(fingerprint, ctx) {
    if (!fingerprint) return;
    this.sessions.set(fingerprint, { ...ctx, updatedAt: Date.now() });
    this._saveSessions();
  }

  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  compressText(text, fingerprint) {
    if (!text || !this.enabled) return text;
    let result = this.smartCompressor.compress(text, fingerprint);
    result = this.codeCompressor.compress(result, fingerprint);
    return result;
  }

  compressMessages(payload, fingerprint) {
    if (!payload || !Array.isArray(payload.messages)) return payload;
    for (let i = 0; i < payload.messages.length; i++) {
      const msg = payload.messages[i];
      if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
        if (typeof msg.content === 'string' && msg.content.length > 200) {
          msg.content = this.compressText(msg.content, fingerprint);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === 'text' && typeof part.text === 'string' && part.text.length > 200) {
              part.text = this.compressText(part.text, fingerprint);
            }
          }
        }
      }
    }
    return payload;
  }

  offloadMessages(payload, fingerprint) {
    if (!payload || !Array.isArray(payload.messages) || !this.enabled || !this.autoOffload) return { payload, offloaded: [], stats: { before: 0, after: 0, saved: 0 } };
    const offloaded = [];
    const keepRecent = 8;

    if (payload.messages.length > keepRecent) {
      const oldMessages = payload.messages.slice(0, payload.messages.length - keepRecent);
      const recentMessages = payload.messages.slice(payload.messages.length - keepRecent);
      const oldText = JSON.stringify(oldMessages);
      const oldTokens = this.estimateTokens(oldText);
      if (oldTokens < this.offloadThreshold) return { payload, offloaded: [], stats: { before: oldTokens, after: oldTokens, saved: 0 } };

      const h = this.store.hash(oldText);
      this.store.put(h, oldMessages, { type: 'messages', fingerprint, count: oldMessages.length, originalTokens: oldTokens });
      offloaded.push({ hash: h, count: oldMessages.length });
      payload.messages = recentMessages;
    }

    const after = this.estimateTokens(JSON.stringify(payload.messages));
    return { payload, offloaded, stats: { before: 0, after, saved: offloaded.length > 0 ? this.estimateTokens(JSON.stringify(payload.messages)) : 0 } };
  }

  retrieveContext(hash) {
    return this.store.get(hash);
  }

  getStats() {
    const s = this.store.stats;
    return {
      ...s,
      sessionsTracked: this.sessions.size,
      enabled: this.enabled,
      autoOffload: this.autoOffload,
      offloadThreshold: this.offloadThreshold,
    };
  }

  clearSession(fingerprint) {
    if (fingerprint) {
      this.sessions.delete(fingerprint);
      this._saveSessions();
    }
  }

  clearAll() {
    this.store.clear();
    this.sessions.clear();
    this._saveSessions();
  }
}

// --- Integration helpers for proxy.js ---
function createContextManager(config) {
  const saverEnabled = config.tokenSaverEnabled !== false;
  const mode = config.tokenSaverMode || 'auto';
  return new ContextManager({
    enabled: saverEnabled,
    autoOffload: mode === 'auto' || mode === 'aggressive',
    offloadThreshold: mode === 'aggressive' ? 500 : (mode === 'auto' ? 2000 : 999999),
    maxEntries: config.tokenSaverMaxEntries || 500,
    ttlMs: config.tokenSaverTtl || 3600000,
  });
}

// --- API handlers ---
function handleSaverRoutes(req, res, pathname, ctxManager) {
  if (pathname === '/api/saver/stats' && req.method === 'GET') {
    writeJSON(res, 200, ctxManager.getStats());
    return true;
  }
  if (pathname === '/api/saver/retrieve' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const hash = url.searchParams.get('hash');
    if (!hash) { writeJSON(res, 400, { error: 'hash param required' }); return true; }
    const data = ctxManager.retrieveContext(hash);
    if (!data) { writeJSON(res, 404, { error: 'not found' }); return true; }
    writeJSON(res, 200, { hash, data });
    return true;
  }
  if (pathname === '/api/saver/clear' && req.method === 'POST') {
    ctxManager.clearAll();
    writeJSON(res, 200, { success: true });
    return true;
  }
  if (pathname === '/api/saver/sessions' && req.method === 'GET') {
    const sessions = [];
    for (const [fp, ctx] of ctxManager.sessions) {
      sessions.push({ fingerprint: fp, ...ctx });
    }
    writeJSON(res, 200, { sessions });
    return true;
  }
  return false;
}

function writeJSON(res, statusCode, payload) {
  try { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }
  catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"encode failed","type":"server_error"}}'); }
}

module.exports = { ContextStore, SmartCompressor, CodeCompressor, ContextManager, createContextManager, handleSaverRoutes };
