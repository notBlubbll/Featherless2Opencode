// context-mode.js - Context window optimization for FeatherProxy
// Sandbox execution, session tracking, content indexing, and search
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const CONTEXT_DIR = path.join(__dirname, '..', '.context-mode');
const SESSIONS_DIR = path.join(CONTEXT_DIR, 'sessions');
const CONTENT_DIR = path.join(CONTEXT_DIR, 'content');
const STATS_FILE = path.join(CONTEXT_DIR, 'stats.json');

// --- Polyglot Sandbox Executor ---
const RUNTIMES = {
  javascript: { ext: '.js', cmd: 'node', timeout: 30000 },
  python:     { ext: '.py', cmd: 'python', timeout: 30000 },
  bash:       { ext: '.sh', cmd: 'bash', timeout: 30000 },
  typescript: { ext: '.ts', cmd: 'node --loader ts-node/esm', timeout: 30000 },
  ruby:       { ext: '.rb', cmd: 'ruby', timeout: 30000 },
  go:         { ext: '.go', cmd: 'go run', timeout: 30000 },
  rust:       { ext: '.rs', cmd: 'rustc', timeout: 30000 },
  php:        { ext: '.php', cmd: 'php', timeout: 30000 },
  perl:       { ext: '.pl', cmd: 'perl', timeout: 30000 },
  r:          { ext: '.R', cmd: 'Rscript', timeout: 30000 },
  elixir:     { ext: '.exs', cmd: 'elixir', timeout: 30000 },
  csharp:     { dotnet: true, timeout: 30000 },
};

const DENY_ENV = new Set([
  'BASH_ENV', 'CDPATH', 'ENV', 'NODE_OPTIONS', 'NODE_DEBUG',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'PERLIO',
  'PHPRC', 'PHP_INI_SCAN_DIR', 'MALLOC_OPTIONS',
  'GCONV_PATH', 'GETCONF_DIR',
]);

function buildSafeEnv() {
  const safe = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!DENY_ENV.has(k) && !k.startsWith('NODE_FUNCTION_')) safe[k] = v;
  }
  return safe;
}

function detectRuntime(code, language) {
  if (language && RUNTIMES[language]) return language;
  if (/^\s*#!/.test(code)) {
    if (/python/.test(code)) return 'python';
    if (/ruby/.test(code)) return 'ruby';
    if (/node/.test(code) || /deno/.test(code)) return 'javascript';
    if (/perl/.test(code)) return 'perl';
    if (/Rscript/.test(code)) return 'r';
    if (/elixir/.test(code)) return 'elixir';
    return 'bash';
  }
  if (/^\s*(import|from|def |class |print\()/.test(code)) return 'python';
  if (/^\s*(const|let|var|function|async|require\(|import )/.test(code)) return 'javascript';
  if (/^\s*(fn |struct |impl |use |pub )/.test(code)) return 'rust';
  if (/^\s*(func |package |import )/.test(code)) return 'go';
  if (/^\s*(class |def |end|require|puts)/.test(code)) return 'ruby';
  if (/^\s*(<\?php|\$)/.test(code)) return 'php';
  if (/^\s*(#|library\(|require\(|install\.packages)/.test(code)) return 'r';
  return 'javascript';
}

async function executeInSandbox(code, language, timeout = 30000, intent = null) {
  const lang = detectRuntime(code, language);
  const runtime = RUNTIMES[lang];
  if (!runtime) throw new Error(`Unsupported language: ${lang}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  let scriptPath;

  if (lang === 'csharp') {
    scriptPath = path.join(tmpDir, 'Program.cs');
    fs.writeFileSync(scriptPath, code);
  } else {
    scriptPath = path.join(tmpDir, `script${runtime.ext}`);
    fs.writeFileSync(scriptPath, code);
  }

  const startTime = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      let cmd, args;
      if (lang === 'csharp') {
        cmd = 'dotnet';
        args = ['script', scriptPath];
      } else if (lang === 'go') {
        cmd = 'go';
        args = ['run', scriptPath];
      } else if (lang === 'rust') {
        const outBin = path.join(tmpDir, 'out');
        try {
          execSync(`rustc ${scriptPath} -o ${outBin}`, { timeout: 10000 });
          cmd = outBin;
          args = [];
        } catch (e) {
          resolve({ stdout: '', stderr: `Compilation failed: ${e.message}`, exitCode: 1, duration: Date.now() - startTime });
          return;
        }
      } else {
        const parts = runtime.cmd.split(' ');
        cmd = parts[0];
        args = [...parts.slice(1), scriptPath];
      }

      const proc = spawn(cmd, args, {
        cwd: tmpDir,
        env: buildSafeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeout,
      });

      proc.stdout.on('data', d => { stdout += d; if (stdout.length > 100 * 1024 * 1024) { killed = true; proc.kill('SIGKILL'); } });
      proc.stderr.on('data', d => { stderr += d; });

      proc.on('close', code => {
        if (killed) { resolve({ stdout: stdout.substring(0, 50000), stderr: 'Output truncated (>100MB)', exitCode: -1, duration: Date.now() - startTime }); return; }
        resolve({ stdout, stderr, exitCode: code, duration: Date.now() - startTime });
      });
      proc.on('error', err => { resolve({ stdout: '', stderr: err.message, exitCode: -1, duration: Date.now() - startTime }); });
    });

    return result;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// --- Content Store (JSON-backed, FTS5-like search) ---
class ContentStore {
  constructor() {
    this.chunks = [];
    this.sources = [];
    this.vocabulary = new Set();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(CONTENT_DIR)) {
        const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
          const data = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8'));
          if (f.startsWith('source-')) this.sources.push(data);
          else if (f.startsWith('chunks-')) this.chunks.push(...data);
        }
      }
    } catch {}
  }

  _save() {
    if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
    // Save sources
    for (const s of this.sources) {
      fs.writeFileSync(path.join(CONTENT_DIR, `source-${s.id}.json`), JSON.stringify(s));
    }
    // Save chunks in batches
    const batchSize = 500;
    for (let i = 0; i < this.chunks.length; i += batchSize) {
      const batch = this.chunks.slice(i, i + batchSize);
      fs.writeFileSync(path.join(CONTENT_DIR, `chunks-${Math.floor(i / batchSize)}.json`), JSON.stringify(batch));
    }
    // Save vocabulary
    fs.writeFileSync(path.join(CONTENT_DIR, 'vocabulary.json'), JSON.stringify([...this.vocabulary]));
  }

  index(label, content, contentType = 'prose', sourceCategory = 'general') {
    const sourceId = this.sources.length + 1;
    const source = { id: sourceId, label, chunkCount: 0, indexedAt: new Date().toISOString() };
    this.sources.push(source);

    const chunks = this._chunkContent(content, contentType, sourceId, sourceCategory);
    this.chunks.push(...chunks);
    source.chunkCount = chunks.length;

    // Update vocabulary
    for (const chunk of chunks) {
      const words = (chunk.title + ' ' + chunk.content).toLowerCase().split(/\W+/).filter(w => w.length > 2);
      for (const w of words) this.vocabulary.add(w);
    }

    this._save();
    return { sourceId, chunkCount: chunks.length };
  }

  _chunkContent(content, contentType, sourceId, sourceCategory) {
    const chunks = [];
    const MAX_CHUNK = 2000;

    if (contentType === 'code') {
      // Keep code blocks intact
      const lines = content.split('\n');
      let current = '';
      for (const line of lines) {
        if (current.length + line.length > MAX_CHUNK && current.length > 0) {
          chunks.push(this._makeChunk(current, sourceId, contentType, sourceCategory));
          current = line;
        } else {
          current += (current ? '\n' : '') + line;
        }
      }
      if (current.trim()) chunks.push(this._makeChunk(current, sourceId, contentType, sourceCategory));
    } else {
      // Split by paragraphs/headings
      const sections = content.split(/\n(?=#{1,6}\s|\n\n)/);
      let current = '';
      for (const section of sections) {
        if (current.length + section.length > MAX_CHUNK && current.length > 0) {
          chunks.push(this._makeChunk(current, sourceId, contentType, sourceCategory));
          current = section;
        } else {
          current += (current ? '\n\n' : '') + section;
        }
      }
      if (current.trim()) chunks.push(this._makeChunk(current, sourceId, contentType, sourceCategory));
    }

    return chunks;
  }

  _makeChunk(content, sourceId, contentType, sourceCategory) {
    const title = content.split('\n')[0].substring(0, 200);
    return {
      title, content, sourceId, contentType, sourceCategory,
      timestamp: new Date().toISOString()
    };
  }

  search(query, options = {}) {
    const { sourceFilter, contentTypeFilter, sortBy = 'relevance', limit = 20 } = options;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    let results = this.chunks.filter(c => {
      if (sourceFilter && c.sourceId !== sourceFilter) return false;
      if (contentTypeFilter && c.contentType !== contentTypeFilter) return false;
      const text = (c.title + ' ' + c.content).toLowerCase();
      return terms.every(t => text.includes(t));
    });

    // Score with BM25-like ranking
    for (const r of results) {
      const text = (r.title + ' ' + r.content).toLowerCase();
      let score = 0;
      for (const term of terms) {
        const titleMatches = (r.title.toLowerCase().match(new RegExp(term, 'g')) || []).length;
        const contentMatches = (text.match(new RegExp(term, 'g')) || []).length;
        score += titleMatches * 5 + contentMatches;
      }
      // Proximity bonus: terms appearing close together
      for (let i = 0; i < terms.length - 1; i++) {
        const idx1 = text.indexOf(terms[i]);
        const idx2 = text.indexOf(terms[i + 1]);
        if (idx1 >= 0 && idx2 >= 0 && Math.abs(idx1 - idx2) < 100) score += 3;
      }
      r.score = score;
    }

    if (sortBy === 'relevance') results.sort((a, b) => b.score - a.score);
    else if (sortBy === 'timeline') results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return results.slice(0, limit).map(r => ({
      title: r.title,
      content: r.content.substring(0, 500),
      sourceId: r.sourceId,
      score: r.score,
      timestamp: r.timestamp,
    }));
  }

  getStats() {
    return {
      totalChunks: this.chunks.length,
      totalSources: this.sources.length,
      vocabularySize: this.vocabulary.size,
    };
  }

  purge() {
    this.chunks = [];
    this.sources = [];
    this.vocabulary.clear();
    if (fs.existsSync(CONTENT_DIR)) fs.rmSync(CONTENT_DIR, { recursive: true, force: true });
    this._save();
  }
}

// --- Session DB ---
class SessionDB {
  constructor() {
    this.events = [];
    this.toolCalls = {};
    this._load();
  }

  _load() {
    try {
      const metaFile = path.join(SESSIONS_DIR, 'meta.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        this.toolCalls = meta.toolCalls || {};
        this.events = (meta.events || []).slice(-1000); // FIFO cap
      }
    } catch {}
  }

  _save() {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    // FIFO eviction: keep last 1000 events
    if (this.events.length > 1000) this.events = this.events.slice(-1000);
    fs.writeFileSync(path.join(SESSIONS_DIR, 'meta.json'), JSON.stringify({
      toolCalls: this.toolCalls,
      events: this.events,
      lastSaved: new Date().toISOString(),
    }, null, 2));
  }

  addEvent(type, category, data, sourceHook = 'proxy') {
    const event = {
      id: this.events.length + 1,
      type, category, data,
      sourceHook,
      timestamp: new Date().toISOString(),
      dataHash: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16),
    };
    // Dedup: skip if same hash in last 5 events
    const recentHashes = this.events.slice(-5).map(e => e.dataHash);
    if (!recentHashes.includes(event.dataHash)) {
      this.events.push(event);
    }
    this._save();
    return event;
  }

  trackToolCall(tool, bytesReturned = 0) {
    if (!this.toolCalls[tool]) this.toolCalls[tool] = { calls: 0, bytesReturned: 0 };
    this.toolCalls[tool].calls++;
    this.toolCalls[tool].bytesReturned += bytesReturned;
    this._save();
  }

  getEvents(type = null, limit = 50) {
    let events = this.events;
    if (type) events = events.filter(e => e.type === type);
    return events.slice(-limit).reverse();
  }

  getStats() {
    const totalEvents = this.events.length;
    const totalToolCalls = Object.values(this.toolCalls).reduce((s, t) => s + t.calls, 0);
    const totalBytesReturned = Object.values(this.toolCalls).reduce((s, t) => s + t.bytesReturned, 0);
    const byType = {};
    for (const e of this.events) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return { totalEvents, totalToolCalls, totalBytesReturned, byType, toolCalls: this.toolCalls };
  }

  buildResumeSnapshot() {
    const events = this.events;
    const files = events.filter(e => e.type === 'file_edit' || e.type === 'file_write').map(e => e.data);
    const errors = events.filter(e => e.type === 'error').map(e => e.data);
    const decisions = events.filter(e => e.type === 'decision').map(e => e.data);
    const recent = events.slice(-20).map(e => `${e.type}: ${typeof e.data === 'string' ? e.data.substring(0, 200) : JSON.stringify(e.data).substring(0, 200)}`);

    return `<session_resume events="${events.length}" generated_at="${new Date().toISOString()}">
<files count="${files.length}">${files.map(f => `\n  <file>${typeof f === 'string' ? f : JSON.stringify(f)}</file>`).join('')}</files>
<errors count="${errors.length}">${errors.map(e => `\n  <error>${typeof e === 'string' ? e : JSON.stringify(e)}</error>`).join('')}</errors>
<decisions count="${decisions.length}">${decisions.map(d => `\n  <decision>${typeof d === 'string' ? d : JSON.stringify(d)}</decision>`).join('')}</decisions>
<recent count="${recent.length}">${recent.map(r => `\n  <event>${r}</event>`).join('')}</recent>
</session_resume>`;
  }
}

// --- Global instances ---
let contentStore = null;
let sessionDB = null;

function getStore() {
  if (!contentStore) contentStore = new ContentStore();
  return contentStore;
}

function getSession() {
  if (!sessionDB) sessionDB = new SessionDB();
  return sessionDB;
}

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch {}
  return { sessions: 0, totalBytesSaved: 0, totalToolCalls: 0 };
}

function saveStats(stats) {
  if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// --- API Handler ---
async function handleContextMode(req, res, pathname) {
  const readBody = () => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const writeJSON = (code, data) => {
    try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
    catch (e) { res.writeHead(500); res.end('{"error":"encode failed"}'); }
  };

  try {
    // POST /api/ctx/execute - Run code in sandbox
    if (pathname === '/api/ctx/execute' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      const { code, language, timeout, intent } = body;
      if (!code) return writeJSON(400, { error: 'code is required' });

      const result = await executeInSandbox(code, language, timeout || 30000, intent);
      const session = getSession();
      session.trackToolCall('ctx_execute', result.stdout.length);
      session.addEvent('sandbox_execute', 'code', {
        language: detectRuntime(code, language),
        exitCode: result.exitCode,
        stdoutLen: result.stdout.length,
        duration: result.duration,
      });

      const stats = loadStats();
      stats.totalBytesSaved = (stats.totalBytesSaved || 0) + result.stdout.length;
      stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;
      saveStats(stats);

      return writeJSON(200, result);
    }

    // POST /api/ctx/batch-execute - Run multiple commands
    if (pathname === '/api/ctx/batch-execute' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      const { commands, queries } = body;
      if (!Array.isArray(commands) || commands.length === 0) return writeJSON(400, { error: 'commands array required' });

      const results = [];
      for (const cmd of commands) {
        const r = await executeInSandbox(cmd.code || cmd.command, cmd.language, cmd.timeout || 30000);
        results.push({ label: cmd.label || 'unnamed', ...r });
        // Index output
        if (r.stdout) getStore().index(`batch:${cmd.label || 'unnamed'}`, r.stdout, 'code', 'batch');
      }

      const session = getSession();
      session.trackToolCall('ctx_batch_execute', results.reduce((s, r) => s + r.stdout.length, 0));

      // Search across results if queries provided
      let searchResults = null;
      if (queries && queries.length > 0) {
        searchResults = [];
        for (const q of queries) searchResults.push(...getStore().search(q, { sourceCategory: 'batch' }));
      }

      return writeJSON(200, { results, searchResults });
    }

    // POST /api/ctx/index - Index content into knowledge base
    if (pathname === '/api/ctx/index' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      const { label, content, contentType, sourceCategory, filePath } = body;
      if (!content) return writeJSON(400, { error: 'content is required' });

      let actualContent = content;
      if (filePath && !content) {
        actualContent = fs.readFileSync(filePath, 'utf8');
      }

      const result = getStore().index(label || filePath || 'manual', actualContent, contentType || 'prose', sourceCategory || 'general');
      return writeJSON(200, { success: true, ...result });
    }

    // POST /api/ctx/index-file - Index a file or directory
    if (pathname === '/api/ctx/index-file' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      const { filePath, recursive } = body;
      if (!filePath) return writeJSON(400, { error: 'filePath is required' });

      const stat = fs.statSync(filePath);
      let indexed = 0;

      if (stat.isFile()) {
        const content = fs.readFileSync(filePath, 'utf8');
        const ext = path.extname(filePath).toLowerCase();
        const contentType = ['.js', '.ts', '.py', '.go', '.rs', '.rb', '.php', '.java', '.c', '.cpp', '.sh'].includes(ext) ? 'code' : 'prose';
        getStore().index(filePath, content, contentType, 'file');
        indexed++;
      } else if (stat.isDirectory()) {
        const files = fs.readdirSync(filePath, { recursive: !!recursive });
        for (const f of files) {
          const fullPath = path.join(filePath, f);
          try {
            if (fs.statSync(fullPath).isFile()) {
              const content = fs.readFileSync(fullPath, 'utf8');
              const ext = path.extname(fullPath).toLowerCase();
              const contentType = ['.js', '.ts', '.py', '.go', '.rs', '.rb', '.php', '.java', '.c', '.cpp', '.sh'].includes(ext) ? 'code' : 'prose';
              getStore().index(fullPath, content, contentType, 'file');
              indexed++;
            }
          } catch {}
        }
      }

      return writeJSON(200, { success: true, indexed });
    }

    // GET /api/ctx/search?q=... - Search indexed content
    if (pathname === '/api/ctx/search' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q');
      if (!q) return writeJSON(400, { error: 'q parameter required' });

      const options = {};
      if (url.searchParams.get('source')) options.sourceFilter = parseInt(url.searchParams.get('source'));
      if (url.searchParams.get('type')) options.contentTypeFilter = url.searchParams.get('type');
      if (url.searchParams.get('sort')) options.sortBy = url.searchParams.get('sort');
      if (url.searchParams.get('limit')) options.limit = parseInt(url.searchParams.get('limit'));

      const results = getStore().search(q, options);
      return writeJSON(200, { query: q, results, count: results.length });
    }

    // GET /api/ctx/stats - Show context savings stats
    if (pathname === '/api/ctx/stats' && req.method === 'GET') {
      const session = getSession();
      const store = getStore();
      const stats = loadStats();
      const sessionStats = session.getStats();
      const storeStats = store.getStats();

      return writeJSON(200, {
        session: sessionStats,
        store: storeStats,
        global: stats,
        savings: {
          totalBytesSaved: stats.totalBytesSaved || 0,
          totalToolCalls: stats.totalToolCalls || 0,
          avgBytesPerCall: stats.totalToolCalls > 0 ? Math.round((stats.totalBytesSaved || 0) / stats.totalToolCalls) : 0,
        },
      });
    }

    // GET /api/ctx/events - List session events
    if (pathname === '/api/ctx/events' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const type = url.searchParams.get('type');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const events = getSession().getEvents(type, limit);
      return writeJSON(200, { events });
    }

    // GET /api/ctx/resume - Get resume snapshot
    if (pathname === '/api/ctx/resume' && req.method === 'GET') {
      const snapshot = getSession().buildResumeSnapshot();
      return writeJSON(200, { snapshot });
    }

    // POST /api/ctx/purge - Clear all indexed content
    if (pathname === '/api/ctx/purge' && req.method === 'POST') {
      getStore().purge();
      return writeJSON(200, { success: true, message: 'All indexed content purged' });
    }

    // POST /api/ctx/fetch-and-index - Fetch URL and index
    if (pathname === '/api/ctx/fetch-and-index' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      const { url: fetchUrl } = body;
      if (!fetchUrl) return writeJSON(400, { error: 'url is required' });

      try {
        const resp = await fetch(fetchUrl, {
          headers: { 'User-Agent': 'FeatherProxy/1.0 ContextMode' },
          signal: AbortSignal.timeout(15000),
        });
        const html = await resp.text();
        // Simple HTML to text conversion
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const result = getStore().index(fetchUrl, text, 'prose', 'url');
        return writeJSON(200, { success: true, url: fetchUrl, ...result });
      } catch (e) {
        return writeJSON(502, { error: `Fetch failed: ${e.message}` });
      }
    }

    return false; // Not handled
  } catch (e) {
    try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch {}
    return true;
  }
}

module.exports = { executeInSandbox, getStore, getSession, handleContextMode, loadStats, saveStats, detectRuntime };
