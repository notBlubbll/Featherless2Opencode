// FeatherProxy - v2026-06-09
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const FEATHERLESS_API_BASE = 'https://api.featherless.ai/v1';
const API_KEY_ENV_VAR = 'FEATHERLESS_API_KEY';
const { handleContextMode } = require('./context-mode');
const { handleCodeGraph } = require('./codegraph');
const { createContextManager, handleSaverRoutes } = require('./token-saver');

const IS_BUN = typeof Bun !== 'undefined';
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace('v', '');

let config = null;
let modelsCache = null;
let userInfoCache = { data: null, time: 0, ttl: 60000 };
let startTime = new Date();
let currentTokenIndex = 0;
let globalSessionCounter = 0;
let conversationMap = new Map();
let ctxManager = null;

// --- Per-model rate limiting ---
const RATE_LIMIT_MAP = {};
const rateLimitTimestamps = new Map();

async function enforceRateLimit(model) {
  const delay = RATE_LIMIT_MAP[model];
  if (!delay) return;
  const last = rateLimitTimestamps.get(model) || 0;
  const wait = delay - (Date.now() - last);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  rateLimitTimestamps.set(model, Date.now());
}

function extractUserPrompt(payload) {
  const msgs = payload.messages;
  if (!Array.isArray(msgs)) return '';
  const text = (m) => {
    const raw = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');
    return raw.replace(/^\[[^\]]+\]\s*/, '');
  };
  const user = msgs.findLast(m => m.role === 'user');
  if (!user) return '';
  return text(user);
}

// --- LRU Response Cache ---
class ResponseCache {
  constructor(maxSize = 100, ttlMs = 60000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this._map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
  get(key) {
    const entry = this._map.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.time > this.ttlMs) {
      this._map.delete(key);
      this.misses++;
      return null;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    this.hits++;
    return entry.value;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.maxSize) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
      this.evictions++;
    }
    this._map.set(key, { value, time: Date.now() });
  }
  get stats() {
    return { size: this._map.size, maxSize: this.maxSize, ttlMs: this.ttlMs, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }
  clear() { this._map.clear(); this.hits = 0; this.misses = 0; this.evictions = 0; }
  get enabled() { return this.maxSize > 0 && this.ttlMs > 0; }
}

function cacheKey(payload, requestedModel) {
  const parts = [requestedModel, payload.stream ? 'stream:1' : 'stream:0'];
  if (payload.system) parts.push(typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system));
  if (payload.messages) parts.push(JSON.stringify(payload.messages));
  if (payload.tools) parts.push(JSON.stringify(payload.tools));
  return crypto.createHash('md5').update(parts.join('||')).digest('hex');
}

let responseCache = new ResponseCache();

// --- Config ---
function loadConfig() {
  const configPath = path.join(__dirname, '..', '.config', 'config.json');
  let rawConfig = {
    LISTEN_ADDR: '127.0.0.1:8082',
    UPSTREAM_BASE_URL: FEATHERLESS_API_BASE,
    REQUEST_TIMEOUT: '15m',
    CACHE_TTL: '60s',
    CACHE_MAX_SIZE: 100,
    CACHE_ENABLED: true,
    COMPACT_ENABLED: true,
    COMPACT_MODE: 'ultra',
    TOKEN_SAVER_ENABLED: true,
    TOKEN_SAVER_MODE: 'auto',
    TOKEN_SAVER_MAX_ENTRIES: 500,
    TOKEN_SAVER_TTL: '1h',
  };
  if (fs.existsSync(configPath)) {
    try {
      rawConfig = { ...rawConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) { console.error('Failed to parse config.json:', e.message); }
  }
  if (process.env.LISTEN_ADDR) rawConfig.LISTEN_ADDR = process.env.LISTEN_ADDR;
  if (process.env.UPSTREAM_BASE_URL) rawConfig.UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL;
  if (process.env.REQUEST_TIMEOUT) rawConfig.REQUEST_TIMEOUT = process.env.REQUEST_TIMEOUT;
  if (process.env[API_KEY_ENV_VAR]) rawConfig.API_KEY = process.env[API_KEY_ENV_VAR];
  if (process.env.API_KEYS) rawConfig.API_KEYS = process.env.API_KEYS.split(',').map(t => t.trim()).filter(Boolean);
  if (process.env.CACHE_TTL) rawConfig.CACHE_TTL = process.env.CACHE_TTL;
  if (process.env.CACHE_MAX_SIZE) rawConfig.CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE);
  if (process.env.CACHE_ENABLED) rawConfig.CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
  if (process.env.COMPACT_ENABLED) rawConfig.COMPACT_ENABLED = process.env.COMPACT_ENABLED !== 'false';
  if (process.env.COMPACT_MODE) rawConfig.COMPACT_MODE = process.env.COMPACT_MODE;
  if (process.env.TOKEN_SAVER_ENABLED) rawConfig.TOKEN_SAVER_ENABLED = process.env.TOKEN_SAVER_ENABLED !== 'false';
  if (process.env.TOKEN_SAVER_MODE) rawConfig.TOKEN_SAVER_MODE = process.env.TOKEN_SAVER_MODE;
  if (process.env.TOKEN_SAVER_MAX_ENTRIES) rawConfig.TOKEN_SAVER_MAX_ENTRIES = parseInt(process.env.TOKEN_SAVER_MAX_ENTRIES);
  if (process.env.TOKEN_SAVER_TTL) rawConfig.TOKEN_SAVER_TTL = process.env.TOKEN_SAVER_TTL;

  const requestTimeout = parseDuration(rawConfig.REQUEST_TIMEOUT);
  if (!rawConfig.LISTEN_ADDR) throw new Error('LISTEN_ADDR cannot be empty');
  if (!rawConfig.UPSTREAM_BASE_URL) throw new Error('UPSTREAM_BASE_URL cannot be empty');
  if (requestTimeout <= 0) throw new Error('REQUEST_TIMEOUT must be greater than zero');

  let baseURL = rawConfig.UPSTREAM_BASE_URL.trim().replace(/\/+$/, '');

  const rawKeys = rawConfig.KEYS;
  let keys = Array.isArray(rawKeys) && rawKeys.length > 0 ? rawKeys : [];
  if (keys.length === 0) {
    const key = rawConfig.API_KEY || process.env[API_KEY_ENV_VAR] || '';
    keys.push({ name: 'Default', key, session: '' });
  }

  const rawModels = rawConfig.ENABLED_MODELS;
  const enabledModels = Array.isArray(rawModels) ? rawModels : [];

  return {
    listenAddr: rawConfig.LISTEN_ADDR,
    upstreamBaseURL: baseURL,
    apiKey: keys[0].key || rawConfig.API_KEY || '',
    requestTimeout,
    apiKeys: [...new Set(rawConfig.API_KEYS || [])],
    enabledModels,
    modelDisplayNames: rawConfig.MODEL_DISPLAY_NAMES || {},
    keys,
    cacheTtl: parseDuration(rawConfig.CACHE_TTL || '60s') || 60000,
    cacheMaxSize: Math.max(0, rawConfig.CACHE_MAX_SIZE || 100),
    cacheEnabled: rawConfig.CACHE_ENABLED !== false,
    compactEnabled: rawConfig.COMPACT_ENABLED !== false,
    compactMode: rawConfig.COMPACT_MODE || 'caveman',
    tokenSaverEnabled: rawConfig.TOKEN_SAVER_ENABLED !== false,
    tokenSaverMode: rawConfig.TOKEN_SAVER_MODE || 'auto',
    tokenSaverMaxEntries: Math.max(10, rawConfig.TOKEN_SAVER_MAX_ENTRIES || 500),
    tokenSaverTtl: parseDuration(rawConfig.TOKEN_SAVER_TTL || '1h') || 3600000,
  };
}

function parseDuration(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)(h|m|s)$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2];
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 's') return value * 1000;
  return 0;
}

function saveConfig(cfg) {
  const configPath = path.join(__dirname, '..', '.config', 'config.json');
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  fs.writeFileSync(configPath, JSON.stringify({
    LISTEN_ADDR: cfg.listenAddr,
    UPSTREAM_BASE_URL: cfg.upstreamBaseURL,
    API_KEY: cfg.apiKey,
    REQUEST_TIMEOUT: `${cfg.requestTimeout / (60 * 1000)}m`,
    API_KEYS: cfg.apiKeys,
    KEYS: cfg.keys,
    ENABLED_MODELS: cfg.enabledModels,
    MODEL_DISPLAY_NAMES: cfg.modelDisplayNames || {},
    CACHE_TTL: `${(cfg.cacheTtl || 60000) / 1000}s`,
    CACHE_MAX_SIZE: cfg.cacheMaxSize || 100,
    CACHE_ENABLED: cfg.cacheEnabled !== false,
    COMPACT_ENABLED: cfg.compactEnabled !== false,
    COMPACT_MODE: cfg.compactMode || 'caveman',
    TOKEN_SAVER_ENABLED: cfg.tokenSaverEnabled !== false,
    TOKEN_SAVER_MODE: cfg.tokenSaverMode || 'auto',
    TOKEN_SAVER_MAX_ENTRIES: cfg.tokenSaverMaxEntries || 500,
    TOKEN_SAVER_TTL: `${(cfg.tokenSaverTtl || 3600000) / 1000}s`,
  }, null, 2));
}

const TITLE_PROMPT_RE = /generate\s+a\s+title\s+for\s+this\s+conversation/i;

// --- Session tracking ---
function fingerprintPayload(payload) {
  const msgs = payload.messages;
  if (!Array.isArray(msgs)) return null;
  const text = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');
  let idx = msgs.findIndex(m => m.role === 'user' && !TITLE_PROMPT_RE.test(text(m)));
  if (idx < 0) idx = msgs.findIndex(m => m.role === 'user');
  if (idx < 0) return null;
  const raw = text(msgs[idx]);
  const stripped = raw.replace(/^\[[^\]]+\]\s*/, '');
  return crypto.createHash('md5').update(stripped).digest('hex').slice(0, 12);
}

function detectSessionSignal(payload) {
  const tokens = config.keys || [];
  if (tokens.length < 1) return null;

  const fingerprint = fingerprintPayload(payload);
  if (!fingerprint) return null;

  const entry = conversationMap.get(fingerprint);
  if (entry !== undefined) {
    entry.requestCount++;
    const idx = (entry.keyIndex !== undefined && entry.keyIndex < tokens.length) ? entry.keyIndex : 0;
    if (idx !== currentTokenIndex) {
      currentTokenIndex = idx;
      config.apiKey = tokens[currentTokenIndex].key;
      if (upstream) upstream.apiKey = tokens[currentTokenIndex].key;
    }
    return entry;
  }

  if (tokens.length > 1) {
    currentTokenIndex = (currentTokenIndex + 1) % tokens.length;
    config.apiKey = tokens[currentTokenIndex].key;
    if (upstream) upstream.apiKey = tokens[currentTokenIndex].key;
  }
  const newEntry = { tokenIndex: currentTokenIndex, requestCount: 1, sessNum: ++globalSessionCounter };
  conversationMap.set(fingerprint, newEntry);

  const msgs = payload.messages;
  const text = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');
  let stampIdx = msgs.findIndex(m => m.role === 'user' && !TITLE_PROMPT_RE.test(text(m)));
  if (stampIdx < 0) stampIdx = msgs.findIndex(m => m.role === 'user');
  const m = msgs[stampIdx];
  const curIdx = currentTokenIndex;
  const label = `${tokens[curIdx].name}|sess${newEntry.sessNum}`;
  const setter = (c) => { if (typeof c === 'string') return `[${label}] ${c}`; if (Array.isArray(c)) { const b = c.find(p => p?.type === 'text'); if (b) b.text = `[${label}] ${b.text}`; } return c; };
  m.content = setter(m.content);
  return newEntry;
}

// --- Upstream Client ---
class UpstreamClient {
  constructor(cfg) {
    this.baseURL = cfg.upstreamBaseURL;
    this.timeout = cfg.requestTimeout;
    this.apiKey = cfg.apiKey;
  }

  headers(stream = false) {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
    };
  }

  async getUserInfo() {
    const requestURL = `${this.baseURL}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(requestURL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) { clearTimeout(timer); throw e; }
  }

  async chatCompletions(body) {
    const requestURL = `${this.baseURL}/chat/completions`;
    const isStream = body && body.stream === true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(requestURL, {
        method: 'POST',
        headers: this.headers(isStream),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      const responseHeaders = {};
      resp.headers.forEach((v, k) => responseHeaders[k] = v);
      return { status: resp.status, headers: responseHeaders, body: resp.body };
    } catch (e) { clearTimeout(timer); throw e; }
  }
}

// --- Search models from Featherless (returns full model details) ---
async function searchFeatherlessModels(query, filters = {}) {
  const apiKey = config?.apiKey || config?.keys?.[0]?.key || '';
  const baseURL = config?.upstreamBaseURL || FEATHERLESS_API_BASE;

  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (filters.family) params.set('family', filters.family);
  if (filters.license) params.set('license', filters.license);
  if (filters.modalities) params.set('modalities', filters.modalities);
  if (filters.capabilities) params.set('capabilities', filters.capabilities);
  if (filters.context_length_min) params.set('context_length_min', filters.context_length_min);
  if (filters.context_length_max) params.set('context_length_max', filters.context_length_max);
  params.set('per_page', String(filters.per_page || 50));
  if (filters.page) params.set('page', filters.page);

  const url = `${baseURL}/models?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) { clearTimeout(timer); throw e; }
}

// --- Utility ---
function generateClientSessionId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const buf = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 13; i++) out += alphabet[buf[i % buf.length] % 36];
  return out;
}

function cloneMap(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) output[key] = cloneMap(value);
    else if (Array.isArray(value)) output[key] = cloneSlice(value);
    else output[key] = value;
  }
  return output;
}

function cloneSlice(input) {
  return input.map(v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return cloneMap(v);
    if (Array.isArray(v)) return cloneSlice(v);
    return v;
  });
}

function normalizeToolSchemas(tools) {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') continue;
    const params = fn.parameters;
    if (!params || typeof params !== 'object') continue;
    fn.parameters = normalizeSchemaMap(params, extractDefinitions(params), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  if (schema.definitions && typeof schema.definitions === 'object') Object.assign(merged, schema.definitions);
  if (schema['$defs'] && typeof schema['$defs'] === 'object') Object.assign(merged, schema['$defs']);
  return Object.keys(merged).length > 0 ? merged : null;
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return cloneMap(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return normalizeSchemaMap(replaced, defs, maxDepth - 1);
  }
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'definitions' || key === '$defs' || key === 'nullable') continue;
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  simplifyNullableCombinator(normalized, 'anyOf');
  simplifyNullableCombinator(normalized, 'oneOf');
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  if (normalized.const === null) delete normalized.const;
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value)) return value.map(v => normalizeSchemaValue(v, defs, maxDepth));
  return value;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function tryResolveRef(node, defs) {
  if (!defs || typeof node.$ref !== 'string' || Object.keys(node).length !== 1) return null;
  const ref = node.$ref;
  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (!name || !defs[name]) return null;
  const def = defs[name];
  return typeof def === 'object' && !Array.isArray(def) ? cloneMap(def) : def;
}

function simplifyNullableCombinator(schema, key) {
  const rawOptions = schema[key];
  if (!Array.isArray(rawOptions)) return;
  const filtered = rawOptions.filter(opt => !isNullSchema(opt));
  if (filtered.length === 0) { delete schema[key]; return; }
  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    delete schema[key];
    Object.assign(schema, filtered[0]);
    return;
  }
  schema[key] = filtered;
}

function isNullSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null) return true;
  return false;
}

function normalizeTypeField(schema) {
  const rawType = schema.type;
  if (typeof rawType === 'string') return;
  if (!Array.isArray(rawType)) return;
  const nonNull = rawType.filter(t => typeof t === 'string' && t !== 'null' && t.trim());
  if (nonNull.length === 0) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  const enumValues = schema.enum;
  if (!Array.isArray(enumValues)) return;
  const seen = new Set();
  const filtered = [];
  for (const entry of enumValues) {
    if (entry === null) continue;
    const key = `${typeof entry}:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }
  if (filtered.length === 0) { delete schema.enum; return; }
  schema.enum = filtered;
}

function isNodeStream(body) {
  return body && typeof body.pipe === 'function' && typeof body.on === 'function';
}

function readBodyText(body) {
  if (isNodeStream(body)) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on('data', c => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks).toString()));
      body.on('error', reject);
    });
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    return new Promise((resolve, reject) => {
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { resolve(Buffer.concat(chunks).toString()); return; }
          chunks.push(Buffer.from(value));
          pump();
        }).catch(reject);
      }
      pump();
    });
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    return (async () => {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    })();
  }
  return String(body);
}

function pipeBodyToResponse(body, res) {
  let closed = false;
  const onClose = () => { closed = true; };
  res.on('close', onClose);

  function safeWrite(chunk) {
    if (!closed) {
      try { res.write(chunk); } catch (e) { closed = true; }
    }
  }

  function safeEnd() {
    if (!closed) {
      try { res.end(); } catch (e) { /* ignore */ }
    }
  }

  if (isNodeStream(body)) {
    return new Promise((resolve) => {
      body.on('data', chunk => safeWrite(chunk));
      body.on('end', () => { safeEnd(); resolve(); });
      body.on('error', () => { safeEnd(); resolve(); });
    });
  }
  return new Promise((resolve) => {
    const reader = body.getReader();
    function pump() {
      if (closed) { resolve(); return; }
      reader.read().then(({ done, value }) => {
        if (closed) { resolve(); return; }
        if (done) { safeEnd(); resolve(); return; }
        safeWrite(value);
        pump();
      }).catch(() => { safeEnd(); resolve(); });
    }
    pump();
  });
}

// --- Token Compactor ---
class TokenCompactor {
  constructor(mode = 'aggressive') {
    this.mode = mode;
    this.abbreviations = {
      'function': 'func', 'parameter': 'param', 'parameters': 'params',
      'return': 'ret', 'variable': 'var', 'because': 'bc',
      'therefore': '=>', 'example': 'ex', 'information': 'info',
      'description': 'desc', 'application': 'app', 'environment': 'env',
      'configuration': 'config', 'implementation': 'impl',
      'temperature': 'temp', 'horizontal': 'horiz', 'vertical': 'vert',
      'documentation': 'docs', 'deprecated': 'depr', 'initialize': 'init',
      'authenticate': 'auth', 'synchronize': 'sync',
      'asynchronous': 'async', 'synchronous': 'sync',
      'javascript': 'js', 'typescript': 'ts', 'python': 'py',
      'advertisement': 'ad', 'advertisement': 'ad',
      'information': 'info', 'development': 'dev',
      'environment': 'env', 'management': 'mgmt',
      'application': 'app', 'functionality': 'func',
      'configuration': 'config', 'infrastructure': 'infra',
      'repository': 'repo', 'dependency': 'dep',
      'dependencies': 'deps', 'expression': 'expr',
      'collection': 'coll', 'dictionary': 'dict',
      'iteration': 'iter', 'comparison': 'comp',
      'definition': 'def', 'inheritance': 'inherit',
      'constructor': 'ctor', 'destructor': 'dtor',
      'interface': 'iface', 'namespace': 'ns',
      'argument': 'arg', 'arguments': 'args',
      'callback': 'cb', 'Promise': 'Prom',
      'undefined': 'undef', 'null': 'nl',
      'boolean': 'bool', 'integer': 'int',
      'string': 'str', 'number': 'num',
      'object': 'obj', 'array': 'arr',
      'element': 'el', 'components': 'comps',
      'component': 'comp', 'properties': 'props',
      'property': 'prop', 'attribute': 'attr',
      'attributes': 'attrs', 'selector': 'sel',
      'response': 'resp', 'request': 'req',
      'header': 'hdr', 'headers': 'hdrs',
      'endpoint': 'ep', 'database': 'db',
      'server': 'srv', 'client': 'cli',
      'message': 'msg', 'messages': 'msgs',
      'channel': 'ch', 'channels': 'chs',
      'template': 'tmpl', 'function': 'fn',
      'methods': 'meths', 'method': 'meth',
      'algorithm': 'algo', 'structure': 'struct',
      'reference': 'ref', 'references': 'refs',
      'statement': 'stmt', 'statements': 'stmts',
      'expression': 'expr', 'expressions': 'exprs',
      'condition': 'cond', 'conditions': 'conds',
      'exception': 'exc', 'exceptions': 'excs',
      'iterator': 'iter', 'iterators': 'iters',
      'generator': 'gen', 'generators': 'gens',
      'decorator': 'dec', 'decorators': 'decs',
      'modifier': 'mod', 'modifiers': 'mods',
      'operator': 'op', 'operators': 'ops',
      'function': 'fn', 'functions': 'fns',
      'variable': 'var', 'variables': 'vars',
      'constant': 'const', 'constants': 'consts',
      'constructor': 'ctor', 'constructors': 'ctors',
      'destructor': 'dtor', 'destructors': 'dtors',
      'argument': 'arg', 'arguments': 'args',
      'parameter': 'param', 'parameters': 'params',
      'property': 'prop', 'properties': 'props',
      'attribute': 'attr', 'attributes': 'attrs',
      'element': 'el', 'elements': 'els',
      'component': 'comp', 'components': 'comps',
      'module': 'mod', 'modules': 'mods',
      'package': 'pkg', 'packages': 'pkgs',
      'library': 'lib', 'libraries': 'libs',
      'framework': 'fw', 'frameworks': 'fws',
      'interface': 'iface', 'interfaces': 'ifaces',
      'namespace': 'ns', 'namespaces': 'nss',
      'class': 'cls', 'classes': 'clss',
      'object': 'obj', 'objects': 'objs',
      'array': 'arr', 'arrays': 'arrs',
      'string': 'str', 'strings': 'strs',
      'number': 'num', 'numbers': 'nums',
      'boolean': 'bool', 'booleans': 'bools',
      'null': 'nl', 'undefined': 'undef',
      'true': 'T', 'false': 'F',
      'return': 'ret', 'yield': 'yld',
      'throw': 'thw', 'catch': 'cat',
      'try': 'tr', 'finally': 'fin',
      'if': 'if', 'else': 'els',
      'switch': 'sw', 'case': 'cs',
      'break': 'brk', 'continue': 'cont',
      'for': 'fr', 'while': 'wh',
      'do': 'do', 'loop': 'lp',
      'import': 'imp', 'export': 'exp',
      'from': 'fm', 'default': 'def',
      'async': 'as', 'await': 'aw',
      'class': 'cls', 'extends': 'ext',
      'super': 'sup', 'this': 'ths',
      'new': 'nw', 'delete': 'del',
      'typeof': 'typ', 'instanceof': 'inst',
      'void': 'vd', 'in': 'in',
      'with': 'w', 'of': 'o',
      'let': 'lt', 'const': 'cnst',
      'var': 'vr', 'static': 'stat',
      'get': 'g', 'set': 's',
    };
    this.fillerWords = [
      'please', 'kindly', 'just', 'actually', 'basically', 'literally',
      'I think', 'I believe', 'in my opinion', 'it seems like', 'the thing is',
      'could you', 'would you', 'can you', 'can you please', 'I was wondering',
      'I would like', 'I want', 'I need you to', 'I need',
      'it would be great', 'it would be nice', 'that would be great',
      'at this point in time', 'due to the fact that', 'in order to',
      'for the purpose of', 'make sure to', 'ensure that',
      'is able to', 'has the ability to', 'in the event that',
      'on a regular basis', 'in the near future', 'at your earliest convenience',
    ];
    this.verbosePatterns = [
      [/\bI would like you to\b/gi, 'generate'],
      [/\bI want you to\b/gi, 'do'],
      [/\bI need you to\b/gi, 'do'],
      [/\bCan you help me\b/gi, 'do'],
      [/\bCould you help me\b/gi, 'do'],
      [/\bPlease help me\b/gi, 'do'],
      [/\bI would appreciate it if you\b/gi, ''],
      [/\bI would be grateful if you\b/gi, ''],
      [/\bWrite a function that\b/gi, 'write func that'],
      [/\bWrite a function\b/gi, 'write func'],
      [/\bCreate a function that\b/gi, 'create func that'],
      [/\bCreate a function\b/gi, 'create func'],
      [/\bMake sure to\b/gi, 'must'],
      [/\bEnsure that\b/gi, 'must'],
      [/\bIn order to\b/gi, 'to'],
      [/\bDue to the fact that\b/gi, 'because'],
      [/\bAt this point in time\b/gi, 'now'],
      [/\bIn the event that\b/gi, 'if'],
      [/\bOn a regular basis\b/gi, 'regularly'],
      [/\bAt your earliest convenience\b/gi, 'now'],
      [/\bIt is important to\b/gi, 'must'],
      [/\bIt is necessary to\b/gi, 'must'],
      [/\bIt is essential to\b/gi, 'must'],
      [/\bIt is crucial to\b/gi, 'must'],
      [/\bIt is recommended to\b/gi, 'should'],
      [/\bIt is suggested to\b/gi, 'should'],
      [/\bIt should be noted that\b/gi, 'note:'],
      [/\bIt goes without saying that\b/gi, ''],
      [/\bNeedless to say\b/gi, ''],
      [/\bIt goes without saying\b/gi, ''],
      [/\bAs a matter of fact\b/gi, ''],
      [/\bIn fact\b/gi, ''],
      [/\bAs far as I am concerned\b/gi, ''],
      [/\bFrom my perspective\b/gi, ''],
      [/\bFrom my point of view\b/gi, ''],
      [/\bIn my experience\b/gi, ''],
      [/\bBased on my understanding\b/gi, ''],
      [/\bIf I understand correctly\b/gi, ''],
      [/\bIf I'm not mistaken\b/gi, ''],
      [/\bTo be honest\b/gi, ''],
      [/\bTo tell you the truth\b/gi, ''],
      [/\bFrankly speaking\b/gi, ''],
      [/\bNeedless to say\b/gi, ''],
      [/\bIt is worth mentioning that\b/gi, 'note:'],
      [/\bIt is worth noting that\b/gi, 'note:'],
      [/\bIt should be mentioned that\b/gi, 'note:'],
      [/\bKeep in mind that\b/gi, 'note:'],
      [/\bRemember that\b/gi, 'note:'],
      [/\bDo not hesitate to\b/gi, ''],
      [/\bFeel free to\b/gi, ''],
      [/\bDon't hesitate to\b/gi, ''],
    ];
    this.cavemanAbbrevs = {
      'function': 'func', 'func': 'fn',
      'parameter': 'param', 'return': 'ret',
      'variable': 'var', 'because': 'bc',
      'therefore': '=>', 'example': 'ex',
      'information': 'info', 'description': 'desc',
      'application': 'app', 'environment': 'env',
      'configuration': 'config', 'implementation': 'impl',
      'documentation': 'docs', 'deprecated': 'depr',
      'initialize': 'init', 'authenticate': 'auth',
      'synchronize': 'sync', 'asynchronous': 'async',
      'development': 'dev', 'management': 'mgmt',
      'infrastructure': 'infra', 'repository': 'repo',
      'dependency': 'dep', 'dependencies': 'deps',
      'expression': 'expr', 'collection': 'coll',
      'dictionary': 'dict', 'iteration': 'iter',
      'comparison': 'comp', 'definition': 'def',
      'inheritance': 'inherit', 'constructor': 'ctor',
      'interface': 'iface', 'namespace': 'ns',
      'argument': 'arg', 'arguments': 'args',
      'callback': 'cb', 'response': 'resp',
      'request': 'req', 'header': 'hdr',
      'headers': 'hdrs', 'endpoint': 'ep',
      'database': 'db', 'server': 'srv',
      'client': 'cli', 'message': 'msg',
      'messages': 'msgs', 'channel': 'ch',
      'template': 'tmpl', 'algorithm': 'algo',
      'structure': 'struct', 'reference': 'ref',
      'statement': 'stmt', 'condition': 'cond',
      'exception': 'exc', 'iterator': 'iter',
      'generator': 'gen', 'decorator': 'dec',
      'modifier': 'mod', 'operator': 'op',
      'module': 'mod', 'package': 'pkg',
      'library': 'lib', 'framework': 'fw',
      'class': 'cls', 'object': 'obj',
      'array': 'arr', 'string': 'str',
      'number': 'num', 'boolean': 'bool',
      'function': 'fn', 'methods': 'meths',
      'method': 'meth', 'properties': 'props',
      'property': 'prop', 'attribute': 'attr',
      'attributes': 'attrs', 'element': 'el',
      'elements': 'els', 'component': 'comp',
      'components': 'comps', 'elements': 'els',
    };
  }

  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  estimatePayloadTokens(payload) {
    let total = 0;
    if (payload.system) {
      total += this.estimateTokens(typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system));
    }
    if (Array.isArray(payload.messages)) {
      for (const msg of payload.messages) {
        const text = typeof msg.content === 'string' ? msg.content :
          (Array.isArray(msg.content) ? msg.content.filter(p => p?.type === 'text').map(p => p.text).join(' ') : '');
        total += this.estimateTokens(text);
      }
    }
    return total;
  }

  compactMessages(payload) {
    if (!payload || !Array.isArray(payload.messages)) return payload;
    const isUltra = this.mode === 'ultra';
    for (let i = 0; i < payload.messages.length; i++) {
      payload.messages[i] = this.compactSingleMessage(payload.messages[i]);
    }
    if (payload.system) {
      payload.system = this.compactText(
        typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system)
      );
    }
    if (isUltra) {
      for (let i = 0; i < payload.messages.length; i++) {
        const msg = payload.messages[i];
        if (typeof msg.content === 'string') {
          msg.content = this.rtkFilter(msg.content);
          msg.content = this.codegraphSkeleton(msg.content);
          msg.content = this.contextModeExtract(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              part.text = this.rtkFilter(part.text);
              part.text = this.codegraphSkeleton(part.text);
              part.text = this.contextModeExtract(part.text);
            }
          }
        }
      }
    }
    if (isUltra) {
      const compactNote = '[System: input token-compressed (tokless protocol: caveman, rtk, codegraph, context-mode). Rules: (1) text aggressively compressed for max context window. (2) NOT=!, EQUAL==, GREATER>, LESS<, →CAUSES/LEADS-TO, <-BECAUSED-BY, ?IF/WHEN, :THEN, |ELSE. (3) abbreviations: fn=function, func=function, args=arguments, resp=response, req=request, hdr=headers, desc=description, docs=documentation, impl=implementation, env=env, cfg=config, ref=reference, stmt=statement, expr=expression, cond=condition, el=element, cls=class, obj=obj, arr=array, str=str, num=num, bool=bool, cb=callback, ep=endpoint, srv=server, cli=client, msg=message, mod=module, pkg=package, lib=lib, prop=property, attr=attr, meth=method, algo=algo, struct=struct, pre=before, post=after, w/=without, w/o=without. (4) number words → digits (twenty=20, hundred=100, million=1M). (5) articles/pronouns/copulas stripped. (6) RTK: code blocks compressed (comments stripped, collapsed to key lines), repeated keys deduped with [xN]. (7) CodeGraph: function bodies → signatures + {...}, imports kept, structural skeleton only. (8) Context-Mode: long outputs → only error/warn/key lines extracted, or condensed to N key lines. (9) interpret compressed text at face value, reconstruct full meaning from fragments. Respond normally but be concise.]';
      if (typeof payload.system === 'string') {
        payload.system = compactNote + '\n\n' + payload.system;
      } else if (Array.isArray(payload.system)) {
        payload.system = [{ type: 'text', text: compactNote }, ...payload.system];
      } else {
        payload.system = compactNote;
      }
    }
    return payload;
  }

  compactSingleMessage(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    if (typeof msg.content === 'string') {
      msg.content = this.compactText(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          part.text = this.compactText(part.text);
        }
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.function && typeof tc.function.arguments === 'string') {
          tc.function.arguments = this.compactToolArguments(tc.function.arguments);
        }
      }
    }
    return msg;
  }

  compactToolArguments(argsStr) {
    try {
      const args = JSON.parse(argsStr);
      const compacted = this.compactObject(args);
      return JSON.stringify(compacted);
    } catch {
      return argsStr;
    }
  }

  compactObject(obj) {
    if (typeof obj === 'string') return this.compactText(obj);
    if (Array.isArray(obj)) return obj.map(v => this.compactObject(v));
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = this.compactObject(v);
      }
      return result;
    }
    return obj;
  }

  compactText(text) {
    if (!text || typeof text !== 'string') return text;
    if (this.mode === 'gentle') return this.gentleCompact(text);
    if (this.mode === 'caveman') return this.cavemanCompact(text);
    if (this.mode === 'ultra') return this.ultraCompact(text);
    return this.aggressiveCompact(text);
  }

  gentleCompact(text) {
    let result = text;
    for (const phrase of this.fillerWords) {
      const regex = new RegExp(`\\b${this.escapeRegex(phrase)}\\b`, 'gi');
      result = result.replace(regex, '');
    }
    result = result.replace(/\s{2,}/g, ' ').trim();
    return result;
  }

  aggressiveCompact(text) {
    let result = this.gentleCompact(text);
    for (const [pattern, replacement] of this.verbosePatterns) {
      result = result.replace(pattern, replacement);
    }
    result = result.replace(/\s{2,}/g, ' ').trim();
    return result;
  }

  cavemanCompact(text) {
    let result = this.aggressiveCompact(text);
    const words = result.split(/(\s+)/);
    const stripped = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (/^\s+$/.test(w)) { stripped.push(w); continue; }
      const lower = w.toLowerCase().replace(/[.,!?;:'"()\[\]{}]/g, '');
      const punct = w.match(/[.,!?;:'"()\[\]{}]+$/)?.[0] || '';
      if (['the', 'a', 'an'].includes(lower)) continue;
      if (['i', 'you', 'we', 'it', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'our', 'its', 'his', 'their'].includes(lower)) continue;
      if (['is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall'].includes(lower)) continue;
      if (['that', 'this', 'these', 'those', 'which', 'who', 'whom', 'whose'].includes(lower)) continue;
      if (['very', 'really', 'quite', 'rather', 'somewhat', 'somehow', 'anyway', 'however', 'moreover', 'furthermore', 'additionally', 'also'].includes(lower)) continue;
      if (['then', 'than', 'too', 'also', 'already', 'still', 'yet', 'ever', 'never', 'always', 'often', 'sometimes', 'usually', 'here', 'there', 'where', 'when', 'while', 'before', 'after', 'during', 'until', 'since'].includes(lower)) continue;
      if (['not', 'no', 'nor', 'neither', 'either'].includes(lower)) continue;
      if (lower.length <= 2 && !/^[A-Z]/.test(w)) continue;
      const abbrev = this.cavemanAbbrevs[lower];
      if (abbrev) { stripped.push(abbrev + punct); continue; }
      stripped.push(w);
    }
    result = stripped.join('');
    result = result.replace(/\s{2,}/g, ' ').trim();
    result = result.replace(/\s+([.,!?;:])/g, '$1');
    return result;
  }

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  ultraCompact(text) {
    let result = this.cavemanCompact(text);
    const numberWords = {
      'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
      'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
      'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
      'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
      'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
      'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
      'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000',
      'million': '1M', 'billion': '1B', 'trillion': '1T',
      'first': '1st', 'second': '2nd', 'third': '3rd', 'fourth': '4th',
      'fifth': '5th', 'sixth': '6th', 'seventh': '7th', 'eighth': '8th',
      'ninth': '9th', 'tenth': '10th',
    };
    const causality = [
      [/\bcauses?\b/gi, '→'], [/\bresults?\s+in\b/gi, '→'],
      [/\bleads?\s+to\b/gi, '→'], [/\bso\b/gi, '→'],
      [/\btherefore\b/gi, '→'], [/\bthus\b/gi, '→'],
      [/\bbecause\b/gi, '<-'], [/\bsince\b/gi, '<-'],
      [/\bdue\s+to\b/gi, '<-'], [/\bcaused\s+by\b/gi, '<-'],
      [/\bif\b/gi, '?'], [/\bwhen\b/gi, '?'],
      [/\bthen\b/gi, ':'], [/\belse\b/gi, '|'],
    ];
    for (const [pat, rep] of causality) result = result.replace(pat, rep);
    const words = result.split(/(\s+)/);
    const out = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (/^\s+$/.test(w)) { out.push(w); continue; }
      const lower = w.toLowerCase().replace(/[.,!?;:'"()\[\]{}]/g, '');
      const punct = w.match(/[.,!?;:'"()\[\]{}]+$/)?.[0] || '';
      if (['to', 'on', 'at', 'by', 'from', 'as', 'so', 'if', 'or', 'in', 'of', 'for', 'with', 'up', 'out'].includes(lower)) continue;
      if (lower === 'and') { out.push('&' + punct); continue; }
      if (lower === 'not' || lower === "n't") { out.push('!' + punct); continue; }
      if (lower === 'equal' || lower === 'equals') { out.push('==' + punct); continue; }
      if (lower === 'greater' || lower === 'more') { out.push('>' + punct); continue; }
      if (lower === 'less' || lower === 'fewer') { out.push('<' + punct); continue; }
      if (lower === 'no' || lower === 'none') { out.push('0' + punct); continue; }
      if (lower === 'before') { out.push('pre' + punct); continue; }
      if (lower === 'after') { out.push('post' + punct); continue; }
      if (lower === 'with') { out.push('w/' + punct); continue; }
      if (lower === 'without') { out.push('w/o' + punct); continue; }
      if (lower === 'should') { out.push('must' + punct); continue; }
      if (lower === 'could') { out.push('can' + punct); continue; }
      if (lower === 'would') { out.push('will' + punct); continue; }
      const num = numberWords[lower];
      if (num) { out.push(num + punct); continue; }
      out.push(w);
    }
    result = out.join('');
    result = result.replace(/\s{2,}/g, ' ').trim();
    result = result.replace(/\s+([.,!?;:])/g, '$1');
    result = result.replace(/,+/g, ',');
    return result;
  }

  rtkFilter(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    result = result.replace(/```[\s\S]*?```/g, (m) => {
      const lines = m.split('\n');
      if (lines.length <= 2) return m;
      const header = lines[0];
      const body = lines.slice(1, -1);
      const stripped = [];
      for (const line of body) {
        const trimmed = line.replace(/^\s+/, '');
        if (/^\/\//.test(trimmed) || /^\/\*/.test(trimmed) || /^\*/.test(trimmed)) continue;
        if (/^#/.test(trimmed)) continue;
        if (/^;/.test(trimmed)) continue;
        if (/^<!--/.test(trimmed)) continue;
        if (/^\s*$/.test(line)) continue;
        stripped.push(line);
      }
      if (stripped.length <= 3) return header + '\n' + stripped.join('\n') + '\n```';
      return header + '\n' + stripped.slice(0, 3).join('\n') + `\n...[${stripped.length - 3} more lines]\n\`\`\``;
    });
    result = result.replace(/(?:^|\n)((?:[^:\n]+:\s*.*\n?){3,})/g, (match) => {
      const lines = match.trim().split('\n');
      const groups = {};
      for (const line of lines) {
        const key = line.split(':')[0].trim().toLowerCase();
        if (!groups[key]) groups[key] = 0;
        groups[key]++;
      }
      const deduped = [];
      const seen = new Set();
      for (const line of lines) {
        const key = line.split(':')[0].trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (groups[key] > 1) {
          deduped.push(line.split(':')[0] + ': [x' + groups[key] + ']');
        } else {
          deduped.push(line);
        }
      }
      return '\n' + deduped.join('\n');
    });
    return result;
  }

  codegraphSkeleton(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    result = result.replace(/```[\s\S]*?```/g, (m) => {
      const lines = m.split('\n');
      if (lines.length <= 4) return m;
      const lang = lines[0].replace(/```/, '').trim();
      const body = lines.slice(1, -1);
      const skeleton = [];
      for (const line of body) {
        const trimmed = line.trim();
        if (/^(import|from|require)\s/.test(trimmed)) { skeleton.push(line); continue; }
        if (/^(export|module\.exports|module\.exports\s*=)/.test(trimmed)) { skeleton.push(line); continue; }
        if (/^(class|interface|type|enum)\s/.test(trimmed)) { skeleton.push(line); continue; }
        if (/^(function|const|let|var|async)\s+\w+\s*[=(]/.test(trimmed)) {
          const sig = trimmed.replace(/\{[\s\S]*$/, '').trim();
          skeleton.push(line.replace(trimmed, sig + ' { ... }'));
          continue;
        }
        if (/^(def|class|async def)\s/.test(trimmed)) {
          const sig = trimmed.replace(/:[\s\S]*$/, '').trim();
          skeleton.push(line.replace(trimmed, sig + ': ...'));
          continue;
        }
        if (/^(fn|pub|impl|struct|enum|trait|mod|use)\s/.test(trimmed)) {
          const sig = trimmed.replace(/\{[\s\S]*$/, '').trim();
          skeleton.push(line.replace(trimmed, sig + ' { ... }'));
          continue;
        }
        if (/^\s*(return|yield|throw|break|continue)\s/.test(trimmed)) { skeleton.push(line); continue; }
        if (/^\s*(if|else|for|while|switch|try|catch)\s/.test(trimmed)) { skeleton.push(line); continue; }
        if (/\bTODO|FIXME|HACK|BUG|XXX\b/.test(trimmed)) { skeleton.push(line); continue; }
      }
      if (skeleton.length <= 2) return '```' + lang + '\n' + body.slice(0, 3).join('\n') + `\n...[${body.length} lines]\n\`\`\``;
      return '```' + lang + '\n' + skeleton.join('\n') + '\n```';
    });
    return result;
  }

  contextModeExtract(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    const lines = result.split('\n');
    if (lines.length <= 20) return result;
    const important = [];
    const seen = new Set();
    for (const line of lines) {
      const trimmed = line.trim();
      if (/\b(error|warn|fatal|panic|fail|exception|traceback|stack\s?trace)\b/i.test(trimmed)) { important.push(line); seen.add(line); continue; }
      if (/\b(TODO|FIXME|HACK|BUG|XXX|NOTE|IMPORTANT|CRITICAL)\b/.test(trimmed) && !seen.has(line)) { important.push(line); seen.add(line); continue; }
      if (/\b(assert|expect|should)\b.*\b(fail|error|equal|match|throw)\b/i.test(trimmed) && !seen.has(line)) { important.push(line); seen.add(line); continue; }
      if (/^\s*(at|from|in)\s+\S+\.\w+[\(:]/.test(trimmed) && !seen.has(line)) { important.push(line); seen.add(line); continue; }
      if (/^\s*(pass|ok|done|success|passed|completed)\b/i.test(trimmed) && !seen.has(line)) { important.push(line); seen.add(line); continue; }
    }
    if (important.length === 0) {
      const condensed = [];
      for (let i = 0; i < lines.length; i++) {
        if (i % Math.ceil(lines.length / 15) === 0) condensed.push(lines[i]);
      }
      return condensed.join('\n') + `\n...[${lines.length - condensed.length} lines condensed]`;
    }
    const header = `[Context-Mode: ${lines.length} lines → ${important.length} key lines]`;
    return header + '\n' + important.join('\n');
  }
}

// --- HTTP Handlers ---
const PROXY_TOOLS = [
  {
    type: 'function',
    function: {
      name: '_fp_skeleton',
      description: 'Extract code skeleton: keeps function signatures, imports, class defs, removes bodies. Returns only structural elements.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Code block to skeletonize' },
          language: { type: 'string', description: 'Language hint (js, py, rs, go, etc.)' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: '_fp_extract',
      description: 'Extract key lines from long output: errors, warnings, TODOs, stack frames. Drops noise. Returns only relevant lines.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Long text/output to extract from' },
          focus: { type: 'string', description: 'What to extract: "errors" (default), "warnings", "key", "all"' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: '_fp_shrink',
      description: 'Aggressively shrink any text. Caveman compaction: strips articles, pronouns, fillers, abbreviates, uses symbols.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to shrink' },
          level: { type: 'string', description: 'Compaction level: "gentle", "aggressive", "caveman", "ultra"' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: '_fp_dedup',
      description: 'Deduplicate repeated lines/blocks in text. Collapses repeated patterns with [xN] counts.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text with potential duplicates' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: '_fp_diff',
      description: 'Condense a diff: keep only changed hunks, strip context lines, collapse unchanged sections.',
      parameters: {
        type: 'object',
        properties: {
          diff: { type: 'string', description: 'Git diff or unified diff text' },
        },
        required: ['diff'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: '_fp_log',
      description: 'Condense git log or similar log output to one-line-per-entry format.',
      parameters: {
        type: 'object',
        properties: {
          log: { type: 'string', description: 'Log output to condense' },
          format: { type: 'string', description: 'Format: "one-line" (default), "hash-msg"' },
        },
        required: ['log'],
      },
    },
  },
];

function executeProxyTool(name, args) {
  const compactor = new TokenCompactor('ultra');
  switch (name) {
    case '_fp_skeleton': return compactor.codegraphSkeleton('```\n' + (args.code || '') + '\n```');
    case '_fp_extract': return compactor.contextModeExtract(args.text || '');
    case '_fp_shrink': {
      const c = new TokenCompactor(args.level || 'ultra');
      return c.compactText(args.text || '');
    }
    case '_fp_dedup': return compactor.rtkFilter(args.text || '');
    case '_fp_diff': {
      const lines = (args.diff || '').split('\n');
      const kept = [];
      let skipCount = 0;
      for (const line of lines) {
        if (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith('diff ')) {
          if (skipCount > 0) { kept.push(`...[${skipCount} lines skipped]`); skipCount = 0; }
          kept.push(line);
        } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
          kept.push(line);
        } else { skipCount++; }
      }
      if (skipCount > 0) kept.push(`...[${skipCount} lines skipped]`);
      return kept.join('\n');
    }
    case '_fp_log': {
      const lines = (args.log || '').split('\n');
      const condensed = [];
      for (const line of lines) {
        const hashMatch = line.match(/^([a-f0-9]{7,})\s/);
        const msgMatch = line.match(/\)\s*(.+)/);
        if (hashMatch && msgMatch) {
          condensed.push(`${hashMatch[1]} ${msgMatch[1].substring(0, 60)}`);
        } else if (line.trim()) {
          condensed.push(line.trim().substring(0, 80));
        }
      }
      return condensed.join('\n');
    }
    default: return `[unknown tool: ${name}]`;
  }
}

// --- Text-based tool call normalization ---
function hasTextToolCalls(text) {
  if (/\b(TOOL_CALLS|tool_call|<function|<tool_call>|<function_call>)/.test(text)) return true;
  const m = text.match(/(?:fenced|json)?\s*`{3,}(?:json)?\s*\n?\s*\{/i);
  if (m) return true;
  return false;
}

function extractTextToolCalls(text) {
  const tcs = [];
  const seen = new Set();

  // Fenced JSON: ```json\n{"name":"func","arguments":{...}}\n```
  const fencedRe = /`{3,}(?:json)?\s*\n?(\{(?:[^{}]|"(?:\\.|[^"\\])*")*?(?:"name"\s*:\s*"[^"]+")\s*,\s*("arguments"|"parameters")\s*:\s*(\{(?:[^{}]|"(?:\\.|[^"\\])*")*?\}|\[.*?\])\s*\}\s*)?\n?`{3,}/gs;
  let match;
  while ((match = fencedRe.exec(text)) !== null) {
    const raw = match[1] || match[0];
    try {
      const parsed = JSON.parse(raw.replace(/^`{3,}(?:json)?\s*/, '').replace(/\s*`{3,}$/, ''));
      const name = parsed.name || parsed.function?.name;
      const args = parsed.arguments || parsed.parameters || parsed.function?.arguments || {};
      if (name && !seen.has(name)) {
        seen.add(name);
        tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
      }
    } catch { /* skip unparseable */ }
  }

  // Bare inline JSON object with name + arguments
  const inlineRe = /(?:\{|,\s*)\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|parameters)"\s*:\s*(\{.*?\})\s*(?:\}|,)/gs;
  while ((match = inlineRe.exec(text)) !== null) {
    const name = match[1];
    let argsRaw = match[2];
    try { JSON.parse(argsRaw); } catch { continue; }
    if (name && !seen.has(name)) {
      seen.add(name);
      tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: argsRaw } });
    }
  }

  // XML: <tool_call>...</tool_call>
  const xmlToolCallRe = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;
  while ((match = xmlToolCallRe.exec(text)) !== null) {
    const inner = match[1].trim();
    // Try JSON inside
    try {
      const parsed = JSON.parse(inner);
      const name = parsed.name || parsed.function?.name;
      const args = parsed.arguments || parsed.function?.arguments || {};
      if (name && !seen.has(name)) {
        seen.add(name);
        tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
        continue;
      }
    } catch { /* not JSON */ }
    // Try <function name="...">...</function>
    const fnRe = /<function\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/function\s*>/i;
    const fnMatch = inner.match(fnRe);
    if (fnMatch) {
      const name = fnMatch[1];
      let argsRaw = fnMatch[2].trim();
      try { JSON.parse(argsRaw); } catch { argsRaw = JSON.stringify(argsRaw); }
      if (name && !seen.has(name)) {
        seen.add(name);
        tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: argsRaw } });
      }
    }
  }

  // <function=name>args</function> (DeepSeek)
  const deepseekRe = /<function\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/function\s*>/gi;
  while ((match = deepseekRe.exec(text)) !== null) {
    const name = match[1];
    let argsRaw = match[2].trim();
    try { JSON.parse(argsRaw); } catch { argsRaw = JSON.stringify(argsRaw); }
    if (name && !seen.has(name)) {
      seen.add(name);
      tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: argsRaw } });
    }
  }

  // <function_call>...</function_call> (MiniMax/DSML)
  const fnCallRe = /<function_call[^>]*>([\s\S]*?)<\/function_call\s*>/gi;
  while ((match = fnCallRe.exec(text)) !== null) {
    const inner = match[1];
    const nameMatch = inner.match(/<function_name[^>]*>([\s\S]*?)<\/function_name\s*>/i);
    const paramsMatch = inner.match(/<parameters[^>]*>([\s\S]*?)<\/parameters\s*>/i);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      let argsRaw = paramsMatch ? paramsMatch[1].trim() : '{}';
      try { JSON.parse(argsRaw); } catch { argsRaw = JSON.stringify(argsRaw); }
      if (name && !seen.has(name)) {
        seen.add(name);
        tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: argsRaw } });
      }
    }
  }

  // <function name="...">...</function> (generic)
  const genericFnRe = /<function\s+name\s*=\s*"([^"]+)"[^>]*>\s*(\{(?:[^{}]|"(?:\\.|[^"\\])*")*?\})\s*<\/function\s*>/gi;
  while ((match = genericFnRe.exec(text)) !== null) {
    const name = match[1];
    let argsRaw = match[2];
    try { JSON.parse(argsRaw); } catch { continue; }
    if (name && !seen.has(name)) {
      seen.add(name);
      tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: argsRaw } });
    }
  }

  // Mistral [TOOL_CALLS] [...] 
  const mistralRe = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])\s*(?:$|\n)/gi;
  while ((match = mistralRe.exec(text)) !== null) {
    try {
      const calls = JSON.parse(match[1]);
      for (const call of calls) {
        const name = call.name || call.function?.name;
        const args = call.arguments || call.function?.arguments || {};
        if (name && !seen.has(name)) {
          seen.add(name);
          tcs.push({ id: `call_${tcs.length}_${Date.now()}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
        }
      }
    } catch { /* skip */ }
  }

  return tcs;
}

function stripToolCallMarkers(text) {
  let result = text;
  // Fenced JSON
  result = result.replace(/`{3,}(?:json)?[\s\S]*?`{3,}/g, '').trim();
  // XML blocks
  result = result.replace(/<tool_call[^>]*>[\s\S]*?<\/tool_call\s*>/gi, '');
  result = result.replace(/<function[^>]*>[\s\S]*?<\/function\s*>/gi, '');
  result = result.replace(/<function_call[^>]*>[\s\S]*?<\/function_call\s*>/gi, '');
  // Mistral marker
  result = result.replace(/\[TOOL_CALLS\][\s\S]*?(?:\n|$)/gi, '');
  result = result.replace(/\s*,\s*"name"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|parameters)"\s*:\s*\{.*?\}\s*/g, '');
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

function normalizeNonStreamToolCalls(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    const choice = data.choices?.[0];
    if (!choice || !choice.message) return bodyText;
    const content = choice.message.content || '';
    if (!content || !hasTextToolCalls(content)) return bodyText;
    const tcs = extractTextToolCalls(content);
    if (tcs.length === 0) return bodyText;
    choice.message.tool_calls = tcs;
    choice.message.content = stripToolCallMarkers(content) || null;
    choice.finish_reason = 'tool_calls';
    console.log(`[TextToolCalls] Normalized ${tcs.length} text tool calls: ${tcs.map(t => t.function.name).join(', ')}`);
    return JSON.stringify(data);
  } catch { return bodyText; }
}

function normalizeStreamToolCalls(fullText) {
  if (!hasTextToolCalls(fullText)) return fullText;
  const lines = fullText.split('\n');
  const out = [];
  let allContent = '';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        const d = JSON.parse(line.slice(6));
        const delta = d.choices?.[0]?.delta;
        if (delta?.content) allContent += delta.content;
        dataLines.push({ line, data: d, delta });
      } catch {
        out.push(line);
      }
    } else {
      out.push(line);
    }
  }
  if (!allContent || !hasTextToolCalls(allContent)) return fullText;
  const tcs = extractTextToolCalls(allContent);
  if (tcs.length === 0) return fullText;
  const cleanedContent = stripToolCallMarkers(allContent);
  let inserted = false;
  for (let i = 0; i < dataLines.length; i++) {
    const { data: d } = dataLines[i];
    const choice = d.choices?.[0];
    const delta = choice?.delta;
    if (delta && delta.content) {
      const idx = allContent.indexOf(delta.content);
      if (idx >= 0) {
        const before = allContent.substring(0, idx);
        const after = allContent.substring(idx + delta.content.length);
        allContent = before + after;
        delta.content = '';
      }
    }
  }
  for (const dl of dataLines) {
    const { data: d } = dl;
    const choice = d.choices?.[0];
    if (!choice) { out.push(dl.line); continue; }
    if (!inserted && tcs.length > 0) {
      choice.delta.tool_calls = tcs.map((tc, idx) => ({
        index: idx,
        id: tc.id,
        type: tc.type,
        function: tc.function
      }));
      if (cleanedContent && dl.delta?.content !== undefined) {
        choice.delta.content = cleanedContent;
      }
      choice.finish_reason = 'tool_calls';
      inserted = true;
    } else {
      if (dl.delta?.content !== undefined) choice.delta.content = '';
    }
    out.push('data: ' + JSON.stringify(d));
  }
  out.push('data: [DONE]');
  console.log(`[TextToolCalls] Normalized ${tcs.length} text tool calls (stream): ${tcs.map(t => t.function.name).join(', ')}`);
  return out.join('\n');
}

function estimateRequestTokens(payload, model) {
  let total = 0;
  if (payload.system) {
    total += Math.ceil((typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system)).length / 4);
  }
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (typeof msg.content === 'string') total += Math.ceil(msg.content.length / 4);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p && p.type === 'text' && typeof p.text === 'string') total += Math.ceil(p.text.length / 4);
        }
      }
    }
  }
  if (Array.isArray(payload.tools)) {
    total += Math.ceil(JSON.stringify(payload.tools).length / 4);
  }
  return total;
}

function hasProxyToolCalls(responseText) {
  try {
    const data = JSON.parse(responseText);
    return data.choices?.[0]?.message?.tool_calls?.some(tc => tc.function?.name?.startsWith('_fp_'));
  } catch { return false; }
}

function extractProxyToolCalls(responseText) {
  try {
    const data = JSON.parse(responseText);
    return data.choices?.[0]?.message?.tool_calls || [];
  } catch { return []; }
}

function buildToolResponseMessage(toolCalls, results) {
  const toolResponses = [];
  for (let i = 0; i < toolCalls.length; i++) {
    toolResponses.push({
      role: 'tool',
      tool_call_id: toolCalls[i].id,
      content: results[i],
    });
  }
  return toolResponses;
}

function stripProxyToolCalls(responseText) {
  try {
    const data = JSON.parse(responseText);
    if (data.choices?.[0]?.message?.tool_calls) {
      data.choices[0].message.tool_calls = data.choices[0].message.tool_calls.filter(tc => !tc.function?.name?.startsWith('_fp_'));
      if (data.choices[0].message.tool_calls.length === 0) {
        delete data.choices[0].message.tool_calls;
      }
    }
    return JSON.stringify(data);
  } catch { return responseText; }
}

function injectProxyTools(payload) {
  if (!config.compactEnabled) return payload;
  if (!payload.tools) payload.tools = [];
  const existingNames = new Set(payload.tools.map(t => t.function?.name));
  for (const tool of PROXY_TOOLS) {
    if (!existingNames.has(tool.function.name)) {
      payload.tools.push(cloneMap(tool));
    }
  }
  return payload;
}

function addToolResultToMessages(payload, toolCalls, results) {
  if (!payload.messages) payload.messages = [];
  const assistantMsg = { role: 'assistant', tool_calls: toolCalls };
  payload.messages.push(assistantMsg);
  const toolResponses = buildToolResponseMessage(toolCalls, results);
  payload.messages.push(...toolResponses);
}
function authorized(req) {
  if (!config.apiKeys || config.apiKeys.length === 0) return true;
  const xApiKey = (req.headers['x-api-key'] || '').trim();
  if (xApiKey && config.apiKeys.includes(xApiKey)) return true;
  const authorization = (req.headers['authorization'] || '').trim();
  if (!authorization.startsWith('Bearer ')) return false;
  return config.apiKeys.includes(authorization.substring(7).trim());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJSON(res, statusCode, payload) {
  try { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }
  catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"encode failed","type":"server_error"}}'); }
}

function writeOpenAIError(res, statusCode, message, errorType, code) {
  if (!message) message = http.STATUS_CODES[statusCode] || 'Unknown error';
  const payload = { error: { message, type: errorType } };
  if (code) payload.error.code = code;
  writeJSON(res, statusCode, payload);
}

async function handleHealthz(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let modelsData = userInfoCache.data;
  if (!modelsData || Date.now() - userInfoCache.time > userInfoCache.ttl) {
    try { modelsData = await upstream.getUserInfo(); userInfoCache = { data: modelsData, time: Date.now(), ttl: 60000 }; }
    catch (e) { modelsData = userInfoCache.data; }
  }
  const tokenState = (config.keys || []).map(t => {
    const maskedToken = t.key ? t.key.substring(0, 10) + '...' + t.key.substring(t.key.length - 4) : '';
    return {
      name: t.name || 'Unnamed Key',
      key: maskedToken,
      status: t.key ? (modelsData ? 'active' : 'unknown') : 'none',
    };
  });
  writeJSON(res, 200, {
    ok: true,
    started_at: startTime.toISOString(),
    uptime_sec: Math.floor((Date.now() - startTime.getTime()) / 1000),
    api_key_valid: !!modelsData,
    provider: 'featherless',
    token_state: tokenState,
    valid_tokens: tokenState.filter(t => t.status !== 'none').length,
    models_count: (config.enabledModels || []).length,
    runtime: IS_BUN ? 'bun' : 'node',
    runtime_version: RUNTIME_VERSION,
    cache: { ...responseCache.stats, enabled: config.cacheEnabled },
    compact: { enabled: config.compactEnabled, mode: config.compactMode },
    tokenSaver: ctxManager ? ctxManager.getStats() : { enabled: false },
  });
}

async function handleModels(req, res) {
  if (req.method !== 'GET') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }

  const models = config?.enabledModels || [];

  const created = Math.floor(startTime.getTime() / 1000);
  const payload = JSON.stringify({
    object: 'list',
    data: models.map(m => ({
      id: m,
      object: 'model',
      created,
      owned_by: 'featherless',
      root: m,
      permission: []
    }))
  });
  try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(payload); }
  catch (e) { writeJSON(res, 500, { error: { message: 'encode failed', type: 'server_error' } }); }
}

async function handleChatCompletions(req, res) {
  if (req.method !== 'POST') { writeOpenAIError(res, 405, 'method not allowed', 'invalid_request_error', ''); return; }
  let requestBody;
  try { requestBody = await readBody(req); } catch (e) { writeOpenAIError(res, 400, 'failed to read request body', 'invalid_request_error', ''); return; }
  let payload;
  try { payload = JSON.parse(requestBody); } catch (e) { writeOpenAIError(res, 400, 'request body must be valid JSON', 'invalid_request_error', ''); return; }
  const requestedModel = (payload.model || '').trim();
  if (!requestedModel) { writeOpenAIError(res, 400, 'model is required', 'invalid_request_error', ''); return; }
  await proxyChatRequest(res, payload, requestedModel, writeOpenAIError, writePassthroughError);
}

async function proxyChatRequest(res, payload, requestedModel, writeError, writeUpstreamError) {
  const reqStart = Date.now();

  const session = detectSessionSignal(payload);

  if (!config.apiKey) { writeError(res, 503, 'no API key configured', 'server_error', 'no_api_key'); return; }

  const cacheEnabled = config.cacheEnabled && !payload.stream;
  let ck;
  if (cacheEnabled) {
    ck = cacheKey(payload, requestedModel);
    const cached = responseCache.get(ck);
    if (cached) {
      const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const tokens = config.keys || [];
      const curIdx = currentTokenIndex;
      const name = curIdx >= 0 && curIdx < tokens.length ? tokens[curIdx].name : '?';
      const sessNum = session?.sessNum || '?';
      const promptPreview = extractUserPrompt(payload).substring(0, 120);
      console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-${JSON.stringify(promptPreview)}-cache:HIT`);
      try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(cached); }
      catch (e) { /* ignore */ }
      console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-done:0ms (cached)`);
      return;
    }
  }

  const tokens = config.keys || [];
  const curIdx = currentTokenIndex;
  const name = curIdx >= 0 && curIdx < tokens.length ? tokens[curIdx].name : '?';
  const sessNum = session?.sessNum || '?';
  const promptPreview = extractUserPrompt(payload).substring(0, 120);
  const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-${JSON.stringify(promptPreview)}`);

  let cloned = cloneMap(payload);
  cloned.model = requestedModel;
  if (cloned.tools) normalizeToolSchemas(cloned.tools);

  const originalTokens = estimateRequestTokens(payload, requestedModel);

  if (config.tokenSaverEnabled && ctxManager) {
    const fingerprint = fingerprintPayload(cloned);
    ctxManager.compressMessages(cloned, fingerprint);
    const offloadResult = ctxManager.offloadMessages(cloned, fingerprint);
    cloned = offloadResult.payload;
    if (offloadResult.offloaded.length > 0) {
      console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-saver offloaded: ${offloadResult.offloaded.map(o => o.count + 'msgs->' + o.hash).join(', ')} (${offloadResult.stats.before}→${offloadResult.stats.after} tokens, saved ${offloadResult.stats.saved})`);
    }
    if (fingerprint) {
      ctxManager.updateSessionContext(fingerprint, { lastModel: requestedModel, lastSeen: Date.now(), requestCount: (ctxManager.getSessionContext(fingerprint)?.requestCount || 0) + 1 });
    }
  }

  if (config.compactEnabled) {
    const compactor = new TokenCompactor(config.compactMode || 'caveman');
    compactor.compactMessages(cloned);
  }

  const finalTokens = estimateRequestTokens(cloned, requestedModel);
  const totalSavings = originalTokens - finalTokens;
  if (totalSavings > 0) {
    const pct = originalTokens > 0 ? Math.round((totalSavings / originalTokens) * 100) : 0;
    console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-tokens: ${originalTokens}→${finalTokens} (-${totalSavings}, ${pct}%)`);
  } else if (totalSavings < 0) {
    console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-tokens: ${originalTokens}→${finalTokens} (+${-totalSavings} overhead)`);
  }

  injectProxyTools(cloned);

  const MAX_TOOL_ROUNDS = 5;
  let lastResponse = null;
  let lastBodyText = null;

  for (let toolRound = 0; toolRound < MAX_TOOL_ROUNDS; toolRound++) {
    let roundSuccess = false;
    await retryLoop(async ({ attempt, isLast }) => {
      await enforceRateLimit(requestedModel);
      let resp;
      try {
        resp = await upstream.chatCompletions(cloned);
      } catch (e) {
        writeError(res, 502, e.message, 'server_error', '');
        return { retry: false };
      }

      const contentType = resp.headers['content-type'] || '';
      console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-upstream:${resp.status} ct:${contentType} round:${toolRound}`);

      if (resp.status >= 200 && resp.status < 300) {
        try {
          if (contentType.includes('text/event-stream')) {
            const chunks = [];
            if (isNodeStream(resp.body)) {
              await new Promise((resolve) => {
                resp.body.on('data', chunk => { chunks.push(chunk); });
                resp.body.on('end', () => resolve());
                resp.body.on('error', () => resolve());
              });
            } else {
              const reader = resp.body.getReader();
              await new Promise(async (resolve) => {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) { resolve(); return; }
                  chunks.push(Buffer.from(value));
                }
              });
            }
            const fullText = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString();
            if (isModelUnavailableError(fullText)) {
              if (isLast) {
                console.error(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-error:200-stream-FINAL`);
                writeUpstreamError(res, 503, fullText);
                return { retry: false };
              }
              return { retry: true };
            }
            if (hasProxyToolCalls(fullText) && toolRound < MAX_TOOL_ROUNDS - 1) {
              const toolCalls = extractProxyToolCalls(fullText);
              console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-proxy-tools:${toolCalls.map(tc => tc.function.name).join(',')}`);
              const results = toolCalls.map(tc => {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch {}
                return executeProxyTool(tc.function.name, args);
              });
              addToolResultToMessages(cloned, toolCalls, results);
              roundSuccess = true;
              return { retry: false };
            }
            const normalizedFullText = normalizeStreamToolCalls(fullText);
            res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            res.end(normalizedFullText);
            const lines = fullText.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');
            const lastContent = [...lines].reverse().find(l => {
              try { const d = JSON.parse(l.replace('data: ', '')); return d.choices && d.choices.length > 0 && d.choices[0].delta?.content; } catch { return false; }
            });
            if (lastContent) {
              try { const d = JSON.parse(lastContent.replace('data: ', '')); console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-body:${d.choices[0].delta.content.substring(0, 800)}`); } catch {}
            }
            console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-stream:${lines.length} chunks`);
          } else {
            const bodyText = await readBodyText(resp.body);
            if (hasProxyToolCalls(bodyText) && toolRound < MAX_TOOL_ROUNDS - 1) {
              const toolCalls = extractProxyToolCalls(bodyText);
              console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-proxy-tools:${toolCalls.map(tc => tc.function.name).join(',')}`);
              const results = toolCalls.map(tc => {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch {}
                return executeProxyTool(tc.function.name, args);
              });
              addToolResultToMessages(cloned, toolCalls, results);
              if (cacheEnabled && ck) responseCache.set(ck, bodyText);
              roundSuccess = true;
              return { retry: false };
            }
            const normalizedBodyText = normalizeNonStreamToolCalls(bodyText);
            if (cacheEnabled && ck) responseCache.set(ck, normalizedBodyText);
            const skipHeaders = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'content-encoding']);
            for (const [key, values] of Object.entries(resp.headers)) {
              if (skipHeaders.has(key.toLowerCase())) continue;
              res.setHeader(key, values);
            }
            res.writeHead(resp.status);
            res.end(normalizedBodyText);
            lastBodyText = normalizedBodyText;
            console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-body:${normalizedBodyText.substring(0, 800)}`);
          }
        } catch (e) { console.error(`proxy response copy failed: ${e.message}`); return { retry: false }; }
        console.log(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-done:${Date.now() - reqStart}ms`);
        return { retry: false };
      }

      const errorBodyStr = await readBodyText(resp.body);
      if (isModelUnavailableError(errorBodyStr)) {
        if (isLast) {
          console.error(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-error:${resp.status}-FINAL`);
          writeUpstreamError(res, resp.status, errorBodyStr);
          return { retry: false };
        }
        return { retry: true };
      }
      if (RATE_LIMIT_MAP[requestedModel] && isRateLimitError(resp.status, errorBodyStr)) {
        if (isLast) {
          console.error(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-429-FINAL`);
          writeUpstreamError(res, 429, errorBodyStr);
          return { retry: false };
        }
        return { retry: true };
      }
      console.error(`${ts} [Session#${sessNum}>${name}]-[${requestedModel}]-error:${resp.status}`);
      writeUpstreamError(res, resp.status, errorBodyStr);
      return { retry: false };
    });
    if (!roundSuccess) break;
  }
}

function isModelUnavailableError(body) {
  const re = /model.*?currently.*?(unavaliable|unavailable|not available)/i;
  if (re.test(body)) return true;
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message || parsed?.message || '';
    if (re.test(msg)) return true;
  } catch {}
  return false;
}

function isRateLimitError(statusCode, body) {
  if (statusCode === 429) return true;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error?.code === '429' || parsed?.error?.type === 'limitation') return true;
  } catch {}
  return false;
}

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3000;

async function retryLoop(fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await fn({ attempt, isLast: attempt === MAX_RETRIES });
    if (!result.retry) return result;
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS + (3000 * (attempt - 1));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function writePassthroughError(res, statusCode, body) {
  const trimmed = body.trim();
  try { const payload = JSON.parse(trimmed); writeOpenAIError(res, statusCode, payload.error?.message || payload.message || trimmed, payload.error?.type || 'upstream_error', payload.error?.code || ''); }
  catch (e) { writeOpenAIError(res, statusCode, trimmed, 'upstream_error', ''); }
}

// --- Token Validation ---
async function validateApiKey() {
  if (!config.apiKey) { console.log('No API key configured'); return false; }
  try {
    const data = await upstream.getUserInfo();
    userInfoCache = { data, time: Date.now(), ttl: 60000 };
    console.log('API key valid');
    return true;
  } catch (e) {
    console.error(`API key validation failed: ${e.message}`);
    return false;
  }
}

// --- Main Request Handler ---
async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (config.apiKeys && config.apiKeys.length > 0 && !authorized(req)) {
    writeOpenAIError(res, 401, 'invalid proxy api key', 'authentication_error', '');
    return;
  }

  if (pathname === '/dashboard' || pathname === '/') {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (!fs.existsSync(dashboardPath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Dashboard not found'); return; }
    const html = fs.readFileSync(dashboardPath);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': html.length });
    res.end(html);
    return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') { writeJSON(res, 200, { ...config, apiKey: config.apiKey ? config.apiKey.substring(0, 10) + '...' : '' }); return; }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const newConfig = JSON.parse(body);
        if (newConfig.apiKey) config.apiKey = newConfig.apiKey;
        if (newConfig.apiKeys) config.apiKeys = newConfig.apiKeys;
        if (newConfig.listenAddr) config.listenAddr = newConfig.listenAddr;
        if (Array.isArray(newConfig.enabledModels)) config.enabledModels = newConfig.enabledModels;
        if (newConfig.modelDisplayNames && typeof newConfig.modelDisplayNames === 'object') config.modelDisplayNames = newConfig.modelDisplayNames;
        if (Array.isArray(newConfig.keys)) config.keys = newConfig.keys;
        if (newConfig.compactEnabled !== undefined) config.compactEnabled = newConfig.compactEnabled !== false;
        if (newConfig.compactMode) config.compactMode = newConfig.compactMode;
        if (newConfig.tokenSaverEnabled !== undefined) { config.tokenSaverEnabled = newConfig.tokenSaverEnabled !== false; if (ctxManager) ctxManager.enabled = config.tokenSaverEnabled; }
        if (newConfig.tokenSaverMode) { config.tokenSaverMode = newConfig.tokenSaverMode; if (ctxManager) ctxManager.autoOffload = newConfig.tokenSaverMode === 'auto' || newConfig.tokenSaverMode === 'aggressive'; }
        saveConfig(config);
        setupOpencodeConfig();
        writeJSON(res, 200, { success: true });
      }
      catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/validate' && req.method === 'GET') {
    const valid = await validateApiKey();
    writeJSON(res, 200, { valid, hasApiKey: !!config.apiKey });
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const models = config.enabledModels || [];
    writeJSON(res, 200, { models });
    return;
  }

  if (pathname === '/api/models/search' && req.method === 'GET') {
    try {
      const query = parsedUrl.searchParams.get('q') || '';
      const filters = {};
      if (parsedUrl.searchParams.get('family')) filters.family = parsedUrl.searchParams.get('family');
      if (parsedUrl.searchParams.get('license')) filters.license = parsedUrl.searchParams.get('license');
      if (parsedUrl.searchParams.get('modalities')) filters.modalities = parsedUrl.searchParams.get('modalities');
      if (parsedUrl.searchParams.get('capabilities')) filters.capabilities = parsedUrl.searchParams.get('capabilities');
      if (parsedUrl.searchParams.get('context_length_min')) filters.context_length_min = parsedUrl.searchParams.get('context_length_min');
      if (parsedUrl.searchParams.get('context_length_max')) filters.context_length_max = parsedUrl.searchParams.get('context_length_max');
      if (parsedUrl.searchParams.get('per_page')) filters.per_page = parseInt(parsedUrl.searchParams.get('per_page'));
      if (parsedUrl.searchParams.get('page')) filters.page = parsedUrl.searchParams.get('page');

      const data = await searchFeatherlessModels(query, filters);
      // Attach already_added flag to each result
      const enabledSet = new Set(config.enabledModels || []);
      if (data.data && Array.isArray(data.data)) {
        for (const m of data.data) {
          m.already_added = enabledSet.has(m.id);
        }
      }
      writeJSON(res, 200, data);
    } catch (e) {
      writeJSON(res, 502, { error: { message: `Featherless API error: ${e.message}`, type: 'upstream_error' } });
    }
    return;
  }

  if (pathname === '/api/models/add' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const modelIds = Array.isArray(data.models) ? data.models : (data.model ? [data.model] : []);
      if (modelIds.length === 0) { writeJSON(res, 400, { error: 'No models specified' }); return; }

      if (!config.enabledModels) config.enabledModels = [];
      let added = 0;
      for (const id of modelIds) {
        if (typeof id === 'string' && id.trim() && !config.enabledModels.includes(id.trim())) {
          config.enabledModels.push(id.trim());
          added++;
        }
      }
      modelsCache = null;
      saveConfig(config);
      setupOpencodeConfig();
      writeJSON(res, 200, { success: true, added, total: config.enabledModels.length });
    } catch (e) { writeJSON(res, 400, { error: e.message }); }
    return;
  }

  if (pathname === '/api/models/remove' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const modelIds = Array.isArray(data.models) ? data.models : (data.model ? [data.model] : []);
      if (modelIds.length === 0) { writeJSON(res, 400, { error: 'No models specified' }); return; }

      if (!config.enabledModels) config.enabledModels = [];
      const idSet = new Set(modelIds.map(id => typeof id === 'string' ? id.trim() : ''));
      config.enabledModels = config.enabledModels.filter(m => !idSet.has(m));
      modelsCache = null;
      saveConfig(config);
      setupOpencodeConfig();
      writeJSON(res, 200, { success: true, removed: modelIds.length, total: config.enabledModels.length });
    } catch (e) { writeJSON(res, 400, { error: e.message }); }
    return;
  }

  if (pathname === '/api/bg' && req.method === 'GET') {
    const cacheDir = path.join(__dirname, '..', '.cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const imgCacheFile = path.join(cacheDir, 'wallpaper.jpg');
    const today = new Date().toISOString().split('T')[0];
    const cachedDate = fs.existsSync(imgCacheFile) ? fs.statSync(imgCacheFile).mtime.toISOString().split('T')[0] : '';
    const expireHeader = cachedDate ? { 'Expires': new Date(cachedDate + 'T23:59:59Z').toUTCString() } : { 'Cache-Control': 'public, max-age=86400' };
    if (cachedDate === today && fs.existsSync(imgCacheFile)) {
      const imgData = fs.readFileSync(imgCacheFile);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': imgData.length, ...expireHeader });
      res.end(imgData);
      return;
    }
    try {
      const response = await fetch('https://peapix.com/bing/feed', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const text = await response.text();
      const data = JSON.parse(text);
      const item = Array.isArray(data) ? data[0] : data;
      const imgUrl = item.fullUrl || item.imageUrl || item.url || '';
      if (!imgUrl) { writeJSON(res, 404, { error: 'not found' }); return; }
      const imgResp = await new Promise((resolve, reject) => {
        const u = new URL(imgUrl);
        const mod = u.protocol === 'https:' ? require('https') : require('http');
        mod.get(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, resolve).on('error', reject);
      });
      const chunks = [];
      imgResp.on('data', c => chunks.push(c));
      imgResp.on('end', () => {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(imgCacheFile, buf);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, ...expireHeader });
        res.end(buf);
      });
    } catch (e) {
      if (fs.existsSync(imgCacheFile)) {
        const buf = fs.readFileSync(imgCacheFile);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, ...expireHeader });
        res.end(buf);
        return;
      }
      writeJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/keys') {
    if (req.method === 'GET') {
      const safe = (config.keys || []).map(t => ({
        name: t.name,
        token_masked: t.key ? t.key.substring(0, 10) + '...' + t.key.substring(t.key.length - 4) : '',
        has_token: !!t.key,
        has_session: !!t.session,
      }));
      writeJSON(res, 200, { keys: config.keys || [], safe });
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (data.action === 'add') {
          if (!config.keys) config.keys = [];
          config.keys.push({ name: data.name || `Key ${config.keys.length + 1}`, key: data.key || '', session: '' });
          if (!config.apiKey && data.key) config.apiKey = data.key;
          saveConfig(config);
          setupOpencodeConfig();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'update') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          if (data.name !== undefined) config.keys[data.index].name = data.name;
          if (data.key !== undefined) config.keys[data.index].key = data.key;
          if (data.index === 0 && config.keys[0].key) config.apiKey = config.keys[0].key;
          saveConfig(config);
          setupOpencodeConfig();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else if (data.action === 'delete') {
          if (typeof data.index !== 'number' || !config.keys || !config.keys[data.index]) { writeJSON(res, 404, { error: 'Key not found' }); return; }
          config.keys.splice(data.index, 1);
          if (config.keys.length === 0) config.keys.push({ name: 'Key 1', key: '', session: '' });
          if (data.index === 0) config.apiKey = config.keys[0].key || '';
          saveConfig(config);
          setupOpencodeConfig();
          writeJSON(res, 200, { success: true, keys: config.keys });
        } else {
          writeJSON(res, 400, { error: 'Unknown action' });
        }
      } catch (e) { writeJSON(res, 400, { error: e.message }); }
      return;
    }
  }

  if (pathname === '/api/cache') {
    if (req.method === 'GET') { writeJSON(res, 200, { ...responseCache.stats, enabled: config.cacheEnabled }); return; }
    if (req.method === 'DELETE') { responseCache.clear(); writeJSON(res, 200, { success: true, cache: responseCache.stats }); return; }
  }

  if (pathname.startsWith('/api/saver/') && ctxManager) {
    if (handleSaverRoutes(req, res, pathname, ctxManager)) return;
  }

  if (pathname === '/healthz') { await handleHealthz(req, res); return; }
  if (pathname === '/v1/models') { await handleModels(req, res); return; }
  if (pathname === '/v1/chat/completions') { await handleChatCompletions(req, res); return; }

  // Context Mode routes
  if (pathname.startsWith('/api/ctx/')) {
    const handled = await handleContextMode(req, res, pathname);
    if (handled !== false) return;
  }

  // CodeGraph routes
  if (pathname.startsWith('/api/cg/')) {
    const handled = await handleCodeGraph(req, res, pathname);
    if (handled !== false) return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// --- Opencode Config ---
function setupOpencodeConfig() {
  const enabled = config.enabledModels || [];
  const displayNames = config.modelDisplayNames || {};
  const port = parseInt(config.listenAddr.split(':').pop()) || 8082;

  const configPaths = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  ];
  if (process.platform === 'win32') {
    configPaths.unshift(path.join(os.homedir(), '.opencode', 'opencode.json'));
    const systemProfile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config', 'systemprofile', '.opencode', 'opencode.json');
    try { if (fs.existsSync(path.dirname(systemProfile))) configPaths.push(systemProfile); } catch {}
  }

  for (const configFile of configPaths) {
    try {
      const models = {};
      for (const m of enabled) {
        models[m] = { name: displayNames[m] || m.split('/').pop() };
      }
      const providerEntry = {
        npm: '@ai-sdk/openai-compatible',
        name: 'Featherless',
        options: { baseURL: `http://localhost:${port}/v1` },
        models,
      };

      const dir = path.dirname(configFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existing = { $schema: 'https://opencode.ai/config.json' };
      if (fs.existsSync(configFile)) {
        existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const backupFile = path.join(dir, 'openconfig.b4feather.json');
        if (!fs.existsSync(backupFile)) {
          fs.copyFileSync(configFile, backupFile);
          console.log(`[Opencode] Backup created: ${backupFile}`);
        }
      }
      if (!existing.provider || typeof existing.provider !== 'object') existing.provider = {};
      existing.provider['featherless'] = providerEntry;
      fs.writeFileSync(configFile, JSON.stringify(existing, null, 2));
      console.log(`[Opencode] Config updated: ${configFile}`);
    } catch (e) {
      console.error(`[Opencode] Failed to update ${configFile}: ${e.message}`);
    }
  }
}

// --- Server Startup ---
let upstream;

async function startServer() {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  FeatherProxy - Starting...                                 │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  try { config = loadConfig(); } catch (e) { console.error('Failed to load config:', e.message); process.exit(1); }

  responseCache = new ResponseCache(config.cacheMaxSize, config.cacheTtl);

  ctxManager = createContextManager(config);

  if (!config.apiKey) {
    console.log('[Warning] No API key configured. Set FEATHERLESS_API_KEY env var or add API_KEY to .config/config.json');
  }

  upstream = new UpstreamClient(config);
  const apiKeyValid = await validateApiKey();

  setupOpencodeConfig();

  const port = parseInt(config.listenAddr.split(':').pop()) || 8082;
  const server = http.createServer(handleRequest);
  server.listen(port, '127.0.0.1', () => {
    console.log(`\nFeatherProxy on http://127.0.0.1:${port}`);
    console.log(`  Provider: Featherless AI`);
    console.log(`  Upstream: ${config.upstreamBaseURL}`);
    console.log(`  API Key: ${config.apiKey ? 'configured (' + config.apiKey.substring(0, 10) + '...)' : 'NOT SET'}`);
    console.log(`  API Key Valid: ${apiKeyValid}`);
    console.log(`  Enabled Models: ${(config.enabledModels || []).length} (search & add via dashboard)`);
    console.log(`  Response Cache: ${config.cacheEnabled ? 'enabled (' + config.cacheMaxSize + ' entries, ' + (config.cacheTtl / 1000) + 's TTL)' : 'disabled'}`);
    console.log(`  Proxy API Keys: ${config.apiKeys.length > 0 ? config.apiKeys.length + ' (auth enabled)' : 'none (open access)'}`);
    console.log(`  Token Saver: ${config.tokenSaverEnabled && ctxManager ? 'enabled (' + config.tokenSaverMode + ' mode, ' + ctxManager.store.stats.size + ' cached)' : 'disabled'}`);
    console.log('');
  });
}

startServer().catch(e => { console.error('Failed to start server:', e.message); process.exit(1); });
