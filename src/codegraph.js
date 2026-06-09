// codegraph.js - Code knowledge graph for FeatherProxy
// Symbol extraction, relationship mapping, search, explore, impact analysis
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GRAPH_DIR = path.join(__dirname, '..', '.codegraph');
const DB_FILE = path.join(GRAPH_DIR, 'graph.json');

// --- Language Support (regex-based extraction) ---
const LANGUAGES = {
  '.ts':   { name: 'typescript', extract: 'ts' },
  '.tsx':  { name: 'typescript', extract: 'ts' },
  '.js':   { name: 'javascript', extract: 'js' },
  '.jsx':  { name: 'javascript', extract: 'js' },
  '.mjs':  { name: 'javascript', extract: 'js' },
  '.py':   { name: 'python', extract: 'py' },
  '.go':   { name: 'go', extract: 'go' },
  '.rs':   { name: 'rust', extract: 'rs' },
  '.java': { name: 'java', extract: 'java' },
  '.cs':   { name: 'csharp', extract: 'cs' },
  '.php':  { name: 'php', extract: 'php' },
  '.rb':   { name: 'ruby', extract: 'rb' },
  '.c':    { name: 'c', extract: 'c' },
  '.h':    { name: 'c', extract: 'c' },
  '.cpp':  { name: 'cpp', extract: 'cpp' },
  '.hpp':  { name: 'cpp', extract: 'cpp' },
  '.swift':{ name: 'swift', extract: 'swift' },
  '.kt':   { name: 'kotlin', extract: 'kt' },
  '.scala':{ name: 'scala', extract: 'scala' },
  '.dart': { name: 'dart', extract: 'dart' },
  '.lua':  { name: 'lua', extract: 'lua' },
  '.vue':  { name: 'vue', extract: 'vue' },
  '.svelte': { name: 'svelte', extract: 'svelte' },
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv',
  'Pods', '.next', '__pycache__', '.cache', '.codegraph', '.context-mode',
  'vendor', 'coverage', '.nyc_output', 'tmp', 'temp',
]);

const EXTRACTORS = {
  ts: (content, filePath) => {
    const symbols = [];
    const edges = [];
    // Functions
    for (const m of content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    // Arrow functions / const assignments
    for (const m of content.matchAll(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    // Classes
    for (const m of content.matchAll(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) edges.push({ from: m[1], to: m[2], type: 'extends' });
      if (m[3]) m[3].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'implements' }));
    }
    // Interfaces
    for (const m of content.matchAll(/(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?/g)) {
      symbols.push({ name: m[1], kind: 'interface', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) m[2].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'extends' }));
    }
    // Types
    for (const m of content.matchAll(/(?:export\s+)?type\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'type', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    // Enums
    for (const m of content.matchAll(/(?:export\s+)?enum\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'enum', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    // Method calls (simple heuristic)
    for (const m of content.matchAll(/(\w+)\.(\w+)\s*\(/g)) {
      if (m[1] !== 'console' && m[1] !== 'this' && m[1] !== 'self') {
        edges.push({ from: m[1], to: m[2], type: 'calls' });
      }
    }
    // Imports
    for (const m of content.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  js: function(content, filePath) { return EXTRACTORS.ts(content, filePath); },

  py: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:async\s+)?def\s+(\w+)\s*\(/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/class\s+(\w+)(?:\(([^)]+)\))?:/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) m[2].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'extends' }));
    }
    for (const m of content.matchAll(/(\w+)\.(\w+)\s*\(/g)) {
      if (!['print', 'self', 'cls'].includes(m[1])) edges.push({ from: m[1], to: m[2], type: 'calls' });
    }
    for (const m of content.matchAll(/(?:from\s+(\S+)\s+)?import\s+(\w+)/g)) {
      if (m[1]) edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  go: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/type\s+(\w+)\s+struct/g)) {
      symbols.push({ name: m[1], kind: 'struct', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/type\s+(\w+)\s+interface/g)) {
      symbols.push({ name: m[1], kind: 'interface', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/(\w+)\.(\w+)\s*\(/g)) {
      edges.push({ from: m[1], to: m[2], type: 'calls' });
    }
    for (const m of content.matchAll(/import\s+(?:\(\s*)?["']([^"']+)["']/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  rs: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/(?:pub\s+)?struct\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'struct', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/(?:pub\s+)?trait\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'trait', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/(?:pub\s+)?enum\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'enum', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/impl(?:<[^>]+>)?\s+(\w+)/g)) {
      edges.push({ from: m[1], to: m[1], type: 'implements' });
    }
    for (const m of content.matchAll(/use\s+([\w:]+)/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  java: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+(\w+)\s*\(/g)) {
      if (!['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) {
        symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
      }
    }
    for (const m of content.matchAll(/(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) edges.push({ from: m[1], to: m[2], type: 'extends' });
      if (m[3]) m[3].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'implements' }));
    }
    for (const m of content.matchAll(/(?:public|private|protected)?\s*interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?/g)) {
      symbols.push({ name: m[1], kind: 'interface', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) m[2].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'extends' }));
    }
    for (const m of content.matchAll(/import\s+([\w.]+);/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  cs: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:public|private|protected|internal|static|async|virtual|override|\s)+[\w<>\[\]]+\s+(\w+)\s*\(/g)) {
      if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'using'].includes(m[1])) {
        symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
      }
    }
    for (const m of content.matchAll(/(?:public|private|protected|internal)?\s*(?:abstract\s+|sealed\s+|partial\s+)*class\s+(\w+)(?:\s*:\s*([\w,\s]+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) m[2].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'extends' }));
    }
    for (const m of content.matchAll(/(?:public|private|internal)?\s*interface\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'interface', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    return { symbols, edges };
  },

  php: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:public|private|protected|static|\s)+function\s+(\w+)\s*\(/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) edges.push({ from: m[1], to: m[2], type: 'extends' });
      if (m[3]) m[3].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'implements' }));
    }
    for (const m of content.matchAll(/interface\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'interface', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/(?:use|require|include)(?:_once)?\s+['"]([^'"]+)['"]/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  rb: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:def|function)\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/class\s+(\w+)(?:\s*<\s*(\w+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) edges.push({ from: m[1], to: m[2], type: 'extends' });
    }
    for (const m of content.matchAll(/module\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'module', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/require(?:_relative)?\s+['"]([^'"]+)['"]/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  c: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:[\w*\s]+)\s+(\w+)\s*\([^)]*\)\s*\{/g)) {
      if (!['if', 'for', 'while', 'switch', 'return', 'sizeof'].includes(m[1])) {
        symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
      }
    }
    for (const m of content.matchAll(/struct\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'struct', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/#include\s+[<"]([^>"]+)[>"]/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  cpp: function(content, filePath) { return EXTRACTORS.c(content, filePath); },

  swift: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:func|static func)\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/class\s+(\w+)(?::\s*(\w+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) edges.push({ from: m[1], to: m[2], type: 'extends' });
    }
    for (const m of content.matchAll(/struct\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'struct', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/protocol\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'protocol', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/import\s+(\w+)/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  kt: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:fun|suspend fun)\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/(?:open\s+|data\s+|sealed\s+|abstract\s+)*class\s+(\w+)(?:\s*\([^)]*\))?(?:\s*:\s*([\w,\s()]+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) m[2].split(',').map(s => s.trim().split('(')[0]).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'extends' }));
    }
    for (const m of content.matchAll(/interface\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'interface', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/import\s+([\w.]+)/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  scala: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:def|val|var)\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/(?:class|case class|object)\s+(\w+)(?:\s*\([^)]*\))?(?:\s+extends\s+([\w,\s()]+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) m[2].split(',').map(s => s.trim().split('(')[0]).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'extends' }));
    }
    for (const m of content.matchAll(/trait\s+(\w+)/g)) {
      symbols.push({ name: m[1], kind: 'trait', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    return { symbols, edges };
  },

  dart: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:void|Future|Stream|dynamic|int|String|bool|List|Map|Set)\s+(\w+)\s*\(/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+with\s+([\w,\s]+))?/g)) {
      symbols.push({ name: m[1], kind: 'class', file: filePath, line: content.substring(0, m.index).split('\n').length });
      if (m[2]) edges.push({ from: m[1], to: m[2], type: 'extends' });
      if (m[3]) m[3].split(',').map(s => s.trim()).filter(Boolean).forEach(i => edges.push({ from: m[1], to: i, type: 'implements' }));
    }
    for (const m of content.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  lua: (content, filePath) => {
    const symbols = [];
    const edges = [];
    for (const m of content.matchAll(/(?:local\s+)?function\s+(\w+(?:\.\w+)*)\s*\(/g)) {
      symbols.push({ name: m[1], kind: 'function', file: filePath, line: content.substring(0, m.index).split('\n').length });
    }
    for (const m of content.matchAll(/require\s+['"]([^'"]+)['"]/g)) {
      edges.push({ from: filePath, to: m[1], type: 'imports' });
    }
    return { symbols, edges };
  },

  vue: (content, filePath) => {
    const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (scriptMatch) return EXTRACTORS.ts(scriptMatch[1], filePath);
    return { symbols: [], edges: [] };
  },

  svelte: (content, filePath) => {
    const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (scriptMatch) return EXTRACTORS.ts(scriptMatch[1], filePath);
    return { symbols: [], edges: [] };
  },
};

// --- Framework Route Detection ---
const FRAMEWORK_ROUTES = {
  django: /(?:path|re_path|url)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w[\w.]*)/g,
  flask:  /@(?:app|bp|router)\.(?:route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
  fastapi: /@(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g,
  express: /(?:app|router)\.(?:get|post|put|delete|patch|use)\s*\(\s*['"]([^'"]+)['"]/g,
  rails:  /(?:get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s*(?:=>|,\s*['"](\w[\w#]*)['"])/g,
  laravel: /Route::(?:get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g,
  spring: /@(?:Get|Post|Put|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g,
  gin:    /(?:r|router|group)\.(?:GET|POST|PUT|DELETE|PATCH)\s*\(\s*['"]([^'"]+)['"]/g,
};

// --- Graph Database ---
class GraphDB {
  constructor() {
    this.nodes = [];     // symbols
    this.edges = [];     // relationships
    this.files = {};     // file -> content hash
    this.routes = [];    // framework routes
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        this.nodes = data.nodes || [];
        this.edges = data.edges || [];
        this.files = data.files || {};
        this.routes = data.routes || [];
      }
    } catch {}
  }

  _save() {
    if (!fs.existsSync(GRAPH_DIR)) fs.mkdirSync(GRAPH_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify({
      nodes: this.nodes, edges: this.edges, files: this.files, routes: this.routes,
      savedAt: new Date().toISOString(),
    }));
  }

  clear() {
    this.nodes = [];
    this.edges = [];
    this.files = {};
    this.routes = [];
    this._save();
  }

  indexFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const lang = LANGUAGES[ext];
    if (!lang) return { symbols: 0, edges: 0 };

    const content = fs.readFileSync(filePath, 'utf8');
    const hash = crypto.createHash('md5').update(content).digest('hex');

    if (this.files[filePath] === hash) return { symbols: 0, edges: 0, cached: true };

    // Remove old nodes/edges for this file
    this.nodes = this.nodes.filter(n => n.file !== filePath);
    this.edges = this.edges.filter(e => {
      const fromNode = this.nodes.find(n => n.name === e.from);
      const toNode = this.nodes.find(n => n.name === e.to);
      return fromNode || toNode;
    });

    const extractor = EXTRACTORS[lang.extract];
    if (!extractor) return { symbols: 0, edges: 0 };

    const { symbols, edges } = extractor(content, filePath);
    const relPath = path.relative(process.cwd(), filePath);

    for (const s of symbols) {
      this.nodes.push({ ...s, file: relPath, language: lang.name, id: crypto.createHash('md5').update(`${relPath}:${s.name}`).digest('hex').slice(0, 12) });
    }

    // Resolve edges: only keep if both ends exist as symbols or files
    const nodeNames = new Set(symbols.map(s => s.name));
    nodeNames.add(relPath);
    for (const e of edges) {
      if (nodeNames.has(e.from) || nodeNames.has(e.to) || e.type === 'imports') {
        this.edges.push({ ...e, file: relPath, language: lang.name });
      }
    }

    // Framework routes
    for (const [framework, regex] of Object.entries(FRAMEWORK_ROUTES)) {
      const re = new RegExp(regex.source, regex.flags);
      for (const m of content.matchAll(re)) {
        this.routes.push({ path: m[1], handler: m[2] || null, framework, file: relPath });
      }
    }

    this.files[filePath] = hash;
    return { symbols: symbols.length, edges: edges.length };
  }

  indexDirectory(dirPath, recursive = true) {
    let totalSymbols = 0;
    let totalEdges = 0;
    let filesIndexed = 0;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && recursive) {
        const result = this.indexDirectory(fullPath, true);
        totalSymbols += result.symbols;
        totalEdges += result.edges;
        filesIndexed += result.files;
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (LANGUAGES[ext]) {
          const result = this.indexFile(fullPath);
          totalSymbols += result.symbols;
          totalEdges += result.edges;
          if (!result.cached) filesIndexed++;
        }
      }
    }

    this._save();
    return { symbols: totalSymbols, edges: totalEdges, files: filesIndexed };
  }

  search(query, limit = 20) {
    const q = query.toLowerCase();
    return this.nodes
      .filter(n => n.name.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q) || (n.file && n.file.toLowerCase().includes(q)))
      .sort((a, b) => {
        const aExact = a.name.toLowerCase() === q ? 0 : 1;
        const bExact = b.name.toLowerCase() === q ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, limit);
  }

  getSymbol(name) {
    return this.nodes.filter(n => n.name === name);
  }

  getCallers(symbolName) {
    const callerEdges = this.edges.filter(e => e.to === symbolName && e.type === 'calls');
    return callerEdges.map(e => {
      const node = this.nodes.find(n => n.name === e.from);
      return { name: e.from, file: e.file, line: node?.line, kind: node?.kind };
    });
  }

  getCallees(symbolName) {
    const calleeEdges = this.edges.filter(e => e.from === symbolName && e.type === 'calls');
    return calleeEdges.map(e => {
      const node = this.nodes.find(n => n.name === e.to);
      return { name: e.to, file: node?.file, line: node?.line, kind: node?.kind };
    });
  }

  getImpact(symbolName, depth = 2) {
    const visited = new Set();
    const impact = [];
    const queue = [{ name: symbolName, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current.name) || current.depth > depth) continue;
      visited.add(current.name);

      const callers = this.getCallers(current.name);
      for (const c of callers) {
        if (!visited.has(c.name)) {
          impact.push({ ...c, depth: current.depth + 1, relation: 'calls' });
          queue.push({ name: c.name, depth: current.depth + 1 });
        }
      }

      // Also check extends/implements chains
      const extEdges = this.edges.filter(e => e.from === current.name && (e.type === 'extends' || e.type === 'implements'));
      for (const e of extEdges) {
        if (!visited.has(e.to)) {
          impact.push({ name: e.to, file: null, kind: e.type, depth: current.depth + 1, relation: e.type });
          queue.push({ name: e.to, depth: current.depth + 1 });
        }
      }
    }

    return impact;
  }

  getFiles() {
    const fileMap = {};
    for (const n of this.nodes) {
      if (!fileMap[n.file]) fileMap[n.file] = { symbols: 0, languages: new Set() };
      fileMap[n.file].symbols++;
      fileMap[n.file].languages.add(n.language);
    }
    return Object.entries(fileMap).map(([file, info]) => ({
      file, symbols: info.symbols, languages: [...info.languages],
    }));
  }

  explore(query, options = {}) {
    const { maxNodes = 20, includeCode = false } = options;
    const symbols = this.search(query, maxNodes);
    const result = { symbols: [], relationships: [], routes: [], blastRadius: 0 };

    for (const s of symbols) {
      const entry = { ...s, code: null, callers: [], callees: [] };
      if (includeCode && s.file) {
        try {
          const fullPath = path.resolve(s.file);
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          // Extract ~30 lines around the symbol
          const start = Math.max(0, (s.line || 1) - 5);
          const end = Math.min(lines.length, start + 30);
          entry.code = lines.slice(start, end).join('\n');
        } catch {}
      }
      entry.callers = this.getCallers(s.name).slice(0, 5);
      entry.callees = this.getCallees(s.name).slice(0, 5);
      result.symbols.push(entry);
    }

    // Collect relationships
    const symbolNames = new Set(symbols.map(s => s.name));
    result.relationships = this.edges.filter(e => symbolNames.has(e.from) || symbolNames.has(e.to)).slice(0, 50);

    // Routes
    result.routes = this.routes.filter(r => {
      return symbols.some(s => r.handler && r.handler.includes(s.name));
    });

    // Blast radius
    if (symbols.length > 0) {
      result.blastRadius = this.getImpact(symbols[0].name, 2).length;
    }

    return result;
  }

  getStatus() {
    const languages = {};
    for (const n of this.nodes) {
      languages[n.language] = (languages[n.language] || 0) + 1;
    }
    return {
      totalNodes: this.nodes.length,
      totalEdges: this.edges.length,
      totalFiles: Object.keys(this.files).length,
      totalRoutes: this.routes.length,
      languages,
    };
  }
}

// --- API Handler ---
let graphDB = null;
function getGraph() {
  if (!graphDB) graphDB = new GraphDB();
  return graphDB;
}

async function handleCodeGraph(req, res, pathname) {
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
    // POST /api/cg/index - Index a directory
    if (pathname === '/api/cg/index' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      const { filePath, recursive } = body;
      if (!filePath) return writeJSON(400, { error: 'filePath required' });
      const graph = getGraph();
      const result = graph.indexDirectory(filePath, recursive !== false);
      return writeJSON(200, { success: true, ...result });
    }

    // POST /api/cg/index-file - Index single file
    if (pathname === '/api/cg/index-file' && req.method === 'POST') {
      const body = JSON.parse(await readBody());
      const { filePath } = body;
      if (!filePath) return writeJSON(400, { error: 'filePath required' });
      const graph = getGraph();
      const result = graph.indexFile(path.resolve(filePath));
      graph._save();
      return writeJSON(200, { success: true, ...result });
    }

    // GET /api/cg/search?q=... - Search symbols
    if (pathname === '/api/cg/search' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q');
      if (!q) return writeJSON(400, { error: 'q parameter required' });
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const results = getGraph().search(q, limit);
      return writeJSON(200, { query: q, results, count: results.length });
    }

    // GET /api/cg/explore?q=... - Explore codebase
    if (pathname === '/api/cg/explore' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('q');
      if (!q) return writeJSON(400, { error: 'q parameter required' });
      const maxNodes = parseInt(url.searchParams.get('maxNodes') || '20');
      const includeCode = url.searchParams.get('includeCode') === 'true';
      const result = getGraph().explore(q, { maxNodes, includeCode });
      return writeJSON(200, result);
    }

    // GET /api/cg/symbol/:name - Get symbol details
    if (pathname.startsWith('/api/cg/symbol/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.split('/api/cg/symbol/')[1]);
      const symbols = getGraph().getSymbol(name);
      return writeJSON(200, { symbol: name, occurrences: symbols });
    }

    // GET /api/cg/callers/:name - Find callers
    if (pathname.startsWith('/api/cg/callers/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.split('/api/cg/callers/')[1]);
      const callers = getGraph().getCallers(name);
      return writeJSON(200, { symbol: name, callers });
    }

    // GET /api/cg/callees/:name - Find callees
    if (pathname.startsWith('/api/cg/callees/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.split('/api/cg/callees/')[1]);
      const callees = getGraph().getCallees(name);
      return writeJSON(200, { symbol: name, callees });
    }

    // GET /api/cg/impact/:name - Impact analysis
    if (pathname.startsWith('/api/cg/impact/') && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const name = decodeURIComponent(pathname.split('/api/cg/impact/')[1]);
      const depth = parseInt(url.searchParams.get('depth') || '2');
      const impact = getGraph().getImpact(name, depth);
      return writeJSON(200, { symbol: name, depth, impact, count: impact.length });
    }

    // GET /api/cg/files - List indexed files
    if (pathname === '/api/cg/files' && req.method === 'GET') {
      const files = getGraph().getFiles();
      return writeJSON(200, { files, count: files.length });
    }

    // GET /api/cg/status - Graph status
    if (pathname === '/api/cg/status' && req.method === 'GET') {
      const status = getGraph().getStatus();
      return writeJSON(200, status);
    }

    // GET /api/cg/routes - Framework routes
    if (pathname === '/api/cg/routes' && req.method === 'GET') {
      const routes = getGraph().routes;
      return writeJSON(200, { routes, count: routes.length });
    }

    // POST /api/cg/clear - Clear graph
    if (pathname === '/api/cg/clear' && req.method === 'POST') {
      getGraph().clear();
      return writeJSON(200, { success: true });
    }

    return false;
  } catch (e) {
    try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch {}
    return true;
  }
}

module.exports = { handleCodeGraph, getGraph, GraphDB };
