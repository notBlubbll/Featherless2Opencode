// FeatherProxy - v2026-06-09
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const FEATHERLESS_API_BASE = 'https://api.featherless.ai/v1';
const API_KEY_ENV_VAR = 'FEATHERLESS_API_KEY';



const IS_BUN = typeof Bun !== 'undefined';
const RUNTIME_VERSION = IS_BUN ? Bun.version : process.version.replace('v', '');

let config = null;
let modelsCache = null;
let userInfoCache = { data: null, time: 0, ttl: 60000 };
let startTime = new Date();
let currentTokenIndex = 0;
let globalSessionCounter = 0;
let conversationMap = new Map();
let dashboardHtmlCache = null;
const CONVERSATION_MAP_MAX = 10000;
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
  const user = msgs.findLast(m => m.role === 'user');
  if (!user) return '';
  return msgText(user).replace(/^\[[^\]]+\]\s*/, '');
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

  }, null, 2));
}

const TITLE_PROMPT_RE = /generate\s+a\s+title\s+for\s+this\s+conversation/i;
const msgText = (m) => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === 'text')?.text || '' : '');

// --- Session tracking ---
function fingerprintPayload(payload) {
  const msgs = payload.messages;
  if (!Array.isArray(msgs)) return null;
  let idx = msgs.findIndex(m => m.role === 'user' && !TITLE_PROMPT_RE.test(msgText(m)));
  if (idx < 0) idx = msgs.findIndex(m => m.role === 'user');
  if (idx < 0) return null;
  const raw = msgText(msgs[idx]);
  const stripped = raw.replace(/^\[[^\]]+\]\s*/, '');
  return crypto.createHash('md5').update(stripped).digest('hex').slice(0, 12);
}

function detectSessionSignal(payload) {
  const tokens = config.keys || [];
  if (tokens.length < 1) return null;

  if (tokens.length === 1) {
    const msgs = payload.messages;
    if (!Array.isArray(msgs)) return null;
    const firstUserIdx = msgs.findIndex(m => m.role === 'user' && !TITLE_PROMPT_RE.test(msgText(m)));
    if (firstUserIdx < 0) return null;
    const sessNum = ++globalSessionCounter;
    const m = msgs[firstUserIdx];
    const label = `${tokens[0].name}|sess${sessNum}`;
    const setter = (c) => { if (typeof c === 'string') return `[${label}] ${c}`; if (Array.isArray(c)) { const b = c.find(p => p?.type === 'text'); if (b) b.text = `[${label}] ${b.text}`; } return c; };
    m.content = setter(m.content);
    return { sessNum };
  }

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
  if (conversationMap.size > CONVERSATION_MAP_MAX) {
    const oldest = conversationMap.keys().next().value;
    conversationMap.delete(oldest);
  }

  const msgs = payload.messages;
  let stampIdx = msgs.findIndex(m => m.role === 'user' && !TITLE_PROMPT_RE.test(msgText(m)));
  if (stampIdx < 0) stampIdx = msgs.findIndex(m => m.role === 'user');
  const m = msgs[stampIdx];
  const curIdx = currentTokenIndex;
  const label = `${tokens[curIdx].name}|sess${newEntry.sessNum}`;
  const setter = (c) => { if (typeof c === 'string') return `[${label}] ${c}`; if (Array.isArray(c)) { const b = c.find(p => p?.type === 'text'); if (b) b.text = `[${label}] ${b.text}`; } return c; };
  m.content = setter(m.content);
  return newEntry;
}

// --- Upstream Client ---
const UPSTREAM_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 128, timeout: 300000, maxFreeSockets: 64, scheduling: 'lifo' });

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
      'Connection': 'keep-alive',
    };
  }

  async getUserInfo() {
    const requestURL = `${this.baseURL}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(requestURL, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Connection': 'keep-alive' },
        signal: controller.signal,
        agent: UPSTREAM_AGENT,
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
        signal: controller.signal,
        agent: UPSTREAM_AGENT,
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
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}`, 'Connection': 'keep-alive' } : {},
      signal: controller.signal,
      agent: UPSTREAM_AGENT,
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

function cloneObj(obj) {
  return JSON.parse(JSON.stringify(obj));
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
  if (maxDepth <= 0) return cloneObj(node);
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
  return typeof def === 'object' && !Array.isArray(def) ? cloneObj(def) : def;
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



// --- HTTP Handlers ---
const PROXY_TOOLS = [
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
  switch (name) {
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

const PROXY_TOOL_CLONES = PROXY_TOOLS.map(t => JSON.parse(JSON.stringify(t)));
const PROXY_TOOL_NAMES = new Set(PROXY_TOOLS.map(t => t.function.name));

function injectProxyTools(payload) {
  if (!payload.tools) payload.tools = [];
  const existingNames = payload.tools.reduce((s, t) => { const n = t.function?.name; if (n) s.add(n); return s; }, new Set());
  for (let i = 0; i < PROXY_TOOL_CLONES.length; i++) {
    if (!existingNames.has(PROXY_TOOLS[i].function.name)) {
      payload.tools.push(PROXY_TOOL_CLONES[i]);
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
      const tokens = config.keys || [];
      const name = tokens.length > 0 ? tokens[0].name : '?';
      const promptPreview = extractUserPrompt(payload).substring(0, 80);
      console.log(`${reqStart} [${name}]-[${requestedModel}]-cache:HIT ${promptPreview}`);
      try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(cached); }
      catch (e) { /* ignore */ }
      return;
    }
  }

  const tokens = config.keys || [];
  const name = tokens.length > 0 ? tokens[0].name : '?';
  const sessNum = session?.sessNum || '?';
  const promptPreview = extractUserPrompt(payload).substring(0, 80);
  console.log(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-${promptPreview}`);

  payload.model = requestedModel;
  if (payload.tools) {
    const needNorm = payload.tools.some(t => t.function?.parameters?.$defs || t.function?.parameters?.definitions || t.function?.parameters?.$ref);
    if (needNorm) normalizeToolSchemas(payload.tools);
  }

  injectProxyTools(payload);

  const MAX_TOOL_ROUNDS = 5;
  let lastResponse = null;
  let lastBodyText = null;

  for (let toolRound = 0; toolRound < MAX_TOOL_ROUNDS; toolRound++) {
    let roundSuccess = false;
    await retryLoop(async ({ attempt, isLast }) => {
      await enforceRateLimit(requestedModel);
      let resp;
      try {
        resp = await upstream.chatCompletions(payload);
      } catch (e) {
        writeError(res, 502, e.message, 'server_error', '');
        return { retry: false };
      }

      const contentType = resp.headers['content-type'] || '';
      console.log(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-upstream:${resp.status} ct:${contentType} round:${toolRound}`);

      if (resp.status >= 200 && resp.status < 300) {
        try {
          if (contentType.includes('text/event-stream')) {
            const chunks = [];
            let headersSent = false;

            const onData = (chunk) => {
              const buf = Buffer.from(chunk);
              chunks.push(buf);
              if (!headersSent) {
                res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                headersSent = true;
              }
              res.write(buf);
            };
            const onEnd = () => { if (!headersSent) { res.writeHead(resp.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); headersSent = true; } try { res.end(); } catch {} };
            const onError = () => { if (!headersSent) { res.writeHead(502); } try { res.end(); } catch {} };

            if (resp.body && typeof resp.body.pipe === 'function') {
              resp.body.on('data', onData);
              resp.body.on('end', onEnd);
              resp.body.on('error', onError);
              await new Promise((resolve) => resp.body.on('end', () => { setTimeout(resolve, 100); }));
              resp.body.removeListener('data', onData);
              resp.body.removeListener('end', onEnd);
              resp.body.removeListener('error', onError);
            } else if (resp.body && typeof resp.body.getReader === 'function') {
              const reader = resp.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) { onEnd(); break; }
                onData(value);
              }
            }

            const fullText = Buffer.concat(chunks).toString();
            if (isModelUnavailableError(fullText)) {
              if (isLast) {
                console.error(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-error:200-stream-FINAL`);
                writeUpstreamError(res, 503, fullText);
                return { retry: false };
              }
              return { retry: true };
            }
            if (fullText.includes('_fp_') && toolRound < MAX_TOOL_ROUNDS - 1) {
              const toolCalls = extractProxyToolCalls(fullText);
              if (toolCalls.length > 0) {
                console.log(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-proxy-tools:${toolCalls.map(tc => tc.function.name).join(',')}`);
                const results = toolCalls.map(tc => {
                  let args = {};
                  try { args = JSON.parse(tc.function.arguments); } catch {}
                  return executeProxyTool(tc.function.name, args);
                });
                addToolResultToMessages(payload, toolCalls, results);
                roundSuccess = true;
                return { retry: false };
              }
            }
          } else {
            const bodyText = await readBodyText(resp.body);
            if (hasProxyToolCalls(bodyText) && toolRound < MAX_TOOL_ROUNDS - 1) {
              const toolCalls = extractProxyToolCalls(bodyText);
              console.log(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-proxy-tools:${toolCalls.map(tc => tc.function.name).join(',')}`);
              const results = toolCalls.map(tc => {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch {}
                return executeProxyTool(tc.function.name, args);
              });
              addToolResultToMessages(payload, toolCalls, results);
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
            console.log(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-body:${normalizedBodyText.substring(0, 800)}`);
          }
        } catch (e) { console.error(`proxy response copy failed: ${e.message}`); return { retry: false }; }
        console.log(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-done:${Date.now() - reqStart}ms`);
        return { retry: false };
      }

      const errorBodyStr = await readBodyText(resp.body);
      if (isModelUnavailableError(errorBodyStr)) {
        if (isLast) {
          console.error(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-error:${resp.status}-FINAL`);
          writeUpstreamError(res, resp.status, errorBodyStr);
          return { retry: false };
        }
        return { retry: true };
      }
      if (RATE_LIMIT_MAP[requestedModel] && isRateLimitError(resp.status, errorBodyStr)) {
        if (isLast) {
          console.error(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-429-FINAL`);
          writeUpstreamError(res, 429, errorBodyStr);
          return { retry: false };
        }
        return { retry: true };
      }
      console.error(`${reqStart} [Session#${sessNum}>${name}]-[${requestedModel}]-error:${resp.status}`);
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

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

async function retryLoop(fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await fn({ attempt, isLast: attempt === MAX_RETRIES });
    if (!result.retry) return result;
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
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
    if (!dashboardHtmlCache) {
      const dashboardPath = path.join(__dirname, 'dashboard.html');
      if (!fs.existsSync(dashboardPath)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Dashboard not found'); return; }
      dashboardHtmlCache = fs.readFileSync(dashboardPath);
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': dashboardHtmlCache.length });
    res.end(dashboardHtmlCache);
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

  if (pathname === '/api/models/families' && req.method === 'GET') {
    try {
      const data = await searchFeatherlessModels('', { per_page: 5 });
      const families = new Set();
      let page = 1;
      const known = ['llama', 'qwen', 'deepseek', 'mistral', 'gemma', 'phi', 'yi', 'internlm', 'falcon', 'rwkv', 'starcoder', 'bloom', 'command-r', 'mpt', 'flux', 'sd', 'cog'];
      for (const name of known) {
        try {
          const d = await searchFeatherlessModels('', { family: name, per_page: 1, page: String(page) });
          if (d.data && d.data.length > 0) families.add(name);
        } catch (_) {}
      }
      writeJSON(res, 200, { families: [...families].sort() });
    } catch (e) {
      writeJSON(res, 502, { error: { message: e.message } });
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

  if (pathname === '/healthz') { await handleHealthz(req, res); return; }
  if (pathname === '/v1/models') { await handleModels(req, res); return; }
  if (pathname === '/v1/chat/completions') { await handleChatCompletions(req, res); return; }

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

// --- Crash Protection ---
process.on('uncaughtException', (err) => {
  console.error(`[CRASH] uncaughtException: ${err.message}`);
  console.error(err.stack);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[CRASH] unhandledRejection: ${reason?.message || reason}`);
  if (reason?.stack) console.error(reason.stack);
});

// --- Server Startup ---
let upstream;
let server;

async function startServer(retryPort = null) {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  FeatherProxy - Starting...                                 │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  try { config = loadConfig(); } catch (e) { console.error('Failed to load config:', e.message); process.exit(1); }

  responseCache = new ResponseCache(config.cacheMaxSize, config.cacheTtl);

  if (!config.apiKey) {
    console.log('[Warning] No API key configured. Set FEATHERLESS_API_KEY env var or add API_KEY to .config/config.json');
  }

  upstream = new UpstreamClient(config);
  try {
    await validateApiKey();
  } catch (e) {
    console.log(`[Warning] API key validation skipped: ${e.message}`);
  }

  setupOpencodeConfig();

  let retryCount = 0;
  const MAX_RETRIES = 3;
  const basePort = parseInt(config.listenAddr.split(':').pop()) || 8082;
  let port = retryPort || basePort;
  server = http.createServer(handleRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount > MAX_RETRIES) {
        port = basePort + 1;
        console.log(`[Warning] Port ${basePort} busy after ${MAX_RETRIES} retries, trying port ${port}`);
        retryCount = 0;
        server.close();
        server.listen(port, '127.0.0.1');
        return;
      }
      console.log(`[Warning] Port ${port} in use (attempt ${retryCount}/${MAX_RETRIES}), retrying in 2s...`);
      setTimeout(() => {
        server.close();
        server.listen(port, '127.0.0.1');
      }, 2000);
      return;
    }
    console.error(`[CRASH] Server error: ${err.message}`);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\nFeatherProxy on http://127.0.0.1:${port}`);
    console.log(`  Provider: Featherless AI`);
    console.log(`  Upstream: ${config.upstreamBaseURL}`);
    console.log(`  API Key: ${config.apiKey ? 'configured (' + config.apiKey.substring(0, 10) + '...)' : 'NOT SET'}`);
    console.log(`  Enabled Models: ${(config.enabledModels || []).length} (search & add via dashboard)`);
    console.log(`  Response Cache: ${config.cacheEnabled ? 'enabled (' + config.cacheMaxSize + ' entries, ' + (config.cacheTtl / 1000) + 's TTL)' : 'disabled'}`);
    console.log(`  Proxy API Keys: ${config.apiKeys.length > 0 ? config.apiKeys.length + ' (auth enabled)' : 'none (open access)'}`);
    console.log('');
  });
}

startServer().catch(e => {
  console.error(`[CRASH] Failed to start server: ${e.message}`);
  setTimeout(() => process.exit(1), 1000);
});
