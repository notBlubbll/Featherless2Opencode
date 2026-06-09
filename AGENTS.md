# FeatherProxy — Developer Guide

## Project Structure

```
FEATHER-PROXY/
├── src/
│   ├── proxy.js              # Main proxy implementation + request router
│   ├── codegraph.js          # Code knowledge graph (symbol extraction, edges, search, explore, impact)
│   ├── context-mode.js       # Context optimization (sandbox executor, session DB, content store, search)
│   └── dashboard.html        # Liquid glass dashboard with model search + CodeGraph + Context Mode UI
├── .config/
│   └── config.json       # Runtime configuration
├── .codegraph/           # CodeGraph graph database (auto-created)
│   └── graph.json        # Symbols, edges, files, routes
├── .context-mode/        # Context Mode data (auto-created)
│   ├── sessions/         # Session events and metadata
│   ├── content/          # Indexed content chunks
│   └── stats.json        # Global context savings stats
├── bin/
│   ├── warp-plus.exe     # Warp+ VPN binary
│   ├── opera-proxy.exe   # Opera Proxy binary
│   ├── README.md         # Warp-Plus usage docs
│   └── LICENSE           # Warp-Plus license
├── package.json          # Project metadata (MIT, no deps)
├── start.cmd             # Auto-detect launcher (Bun preferred, Node fallback)
├── start-node.cmd        # Node.js-only launcher
├── skills.md             # Opencode provider configuration reference
├── README.md             # User documentation
└── AGENTS.md             # This file
```

## Key Components

### 1. Constants & Config (proxy.js lines 1-170)

- `FEATHERLESS_API_BASE` — `https://api.featherless.ai/v1`
- `API_KEY_ENV_VAR` — `FEATHERLESS_API_KEY`
- `loadConfig()` — Loads `.config/config.json` with env var overrides
- `saveConfig()` — Writes config back to `.config/config.json`
- `parseDuration()` — Parses duration strings like `15m`, `6h`, `30s`

### 2. UpstreamClient (proxy.js lines 170-230)

- `headers(stream)` — Returns Bearer token + Content-Type/Accept headers
- `getUserInfo()` — `GET /models` with 10s timeout to validate API key
- `chatCompletions(body)` — `POST /chat/completions` (streaming-aware)

### 3. Model Management (proxy.js lines 232-400)

- `searchFeatherlessModels(query, filters)` — Searches Featherless catalog with query params
- `GET /api/models/search?q=...&family=...` — Search Featherless catalog via proxy
- `POST /api/models/add` — Add models to enabled list
- `POST /api/models/remove` — Remove models from enabled list
- `modelDisplayNames` — Custom display names persisted to config and opencode

### 4. CodeGraph Module (codegraph.js)

**Symbol Extraction** — Regex-based AST parsing for 20+ languages:
- TypeScript/JavaScript: functions, classes, interfaces, types, enums, method calls, imports
- Python: functions, classes, inheritance, method calls, imports
- Go: functions, structs, interfaces, method calls, imports
- Rust: functions, structs, traits, enums, impl blocks, use statements
- Java/C#: classes, interfaces, methods, inheritance, imports
- PHP/Ruby: classes, modules, functions, inheritance, requires
- C/C++: functions, structs, includes
- Swift/Kotlin/Scala/Dart/Lua: language-specific constructs
- Vue/Svelte: script block extraction → TypeScript parser

**Framework Route Detection** — Django, Flask, FastAPI, Express, Rails, Laravel, Spring, Gin

**Graph Operations:**
- `indexFile(path)` — Extract symbols + edges from one file (incremental via MD5 hash)
- `indexDirectory(path, recursive)` — Walk directory tree, index all source files
- `search(query, limit)` — Symbol search with exact/prefix/substring ranking
- `explore(query, options)` — Full exploration: symbols + source + callers/callees + relationships + blast radius
- `getCallers(name)` — Find what calls a symbol
- `getCallees(name)` — Find what a symbol calls
- `getImpact(name, depth)` — BFS impact analysis up to N levels deep
- `getFiles()` — List all indexed files with symbol counts
- `getStatus()` — Total nodes, edges, files, routes, per-language breakdown

**Data Storage:** `.codegraph/graph.json` — JSON graph with nodes, edges, files, routes

### 5. Context Mode Module (context-mode.js)

**Sandbox Executor** — 12 languages with process isolation:
- Languages: JavaScript, TypeScript, Python, Bash, Ruby, Go, Rust, PHP, Perl, R, Elixir, C#
- Auto-detection from code patterns when language not specified
- Environment sanitization (60+ denied env vars: `NODE_OPTIONS`, `BASH_ENV`, `LD_PRELOAD`, etc.)
- 100MB output cap, configurable timeout (default 30s)
- Temp directory cleanup after execution

**Content Store** — BM25-like search over indexed content:
- Chunking: markdown split by headings, code blocks kept intact, plain text by paragraphs
- Scoring: title match 5x weight, content match 1x, proximity bonus for adjacent terms
- Source tracking with labels, content types (code/prose), categories

**Session DB** — Event tracking with dedup and FIFO eviction:
- 23+ event types: file_edit, file_write, git_commit, error, decision, sandbox_execute, etc.
- SHA-256 deduplication (sliding window of 5 recent events)
- FIFO eviction at 1000 events per session
- Tool call counters with bytes returned tracking

**Compaction Recovery** — XML resume snapshots:
- Sections: files, errors, decisions, recent events
- Each section includes runnable `ctx_search` queries for on-demand detail retrieval
- Generated before context compaction, consumed on session restart

**Data Storage:**
- `.context-mode/sessions/meta.json` — Session events and tool call stats
- `.context-mode/content/` — Indexed content chunks (JSON batches)
- `.context-mode/stats.json` — Global savings stats

### 6. HTTP Handlers (proxy.js lines 500-800)

- `authorized(req)` — Checks `x-api-key` header or `Authorization: Bearer` against `config.apiKeys`
- `readBody(req)` — Buffers incoming request body to string
- `writeJSON(res, statusCode, payload)` — JSON response with error-safe write
- `handleHealthz(req, res)` — Returns uptime, API key validity, models count, runtime info
- `handleModels(req, res)` — OpenAI-format model list
- `handleChatCompletions(req, res)` — Parses body, calls `proxyChatRequest`
- `proxyChatRequest(res, payload, model, ...)` — Core proxy: clone payload, normalize tools, forward to upstream

### 7. Request Router (proxy.js lines 1550-1820)

Routes by pathname:
- `/` or `/dashboard` → Serve `dashboard.html`
- `/api/config` (GET/POST) → Config read/write
- `/api/validate` (GET) → Validate API key
- `/api/models` (GET) → Model list
- `/api/models/search` (GET) → Search Featherless catalog
- `/api/models/add` (POST) → Add models to enabled list
- `/api/models/remove` (POST) → Remove models from enabled list
- `/api/bg` (GET) → Bing wallpaper via peapix.com
- `/api/keys` (GET/POST) → Multi-key CRUD
- `/api/cache` (GET/DELETE) → Response cache stats/clear
- `/api/cg/*` → CodeGraph routes (index, search, explore, symbol, callers, callees, impact, files, status, routes, clear)
- `/api/ctx/*` → Context Mode routes (execute, batch-execute, index, index-file, search, stats, events, resume, purge, fetch-and-index)
- `/healthz` → Health check
- `/v1/models` → OpenAI models
- `/v1/chat/completions` → OpenAI chat

### 8. Opencode Config (proxy.js lines 1830-1880)

- `setupOpencodeConfig()` — Writes provider config with display names from `modelDisplayNames`
- Creates `openconfig.b4feather.json` backup before first edit
- Provider key: `featherless`, using `@ai-sdk/openai-compatible`

### 9. Dashboard (dashboard.html)

- **Liquid Glass Engine** — Canvas-generated displacement maps with refraction profiles
- **Model Search UI** — Search Featherless catalog with family filter, sort by params/context, rich cards with model class/context/max tokens
- **Enabled Models** — Click to edit display name (inline input), remove with X
- **CodeGraph Section** — Index projects, search symbols, explore code with source display, impact analysis, status/files/routes views
- **Context Mode Section** — Execute code in 12 languages with output display, search knowledge base, index files/text, stats badge
- **Key Manager Modal** — Inline add/edit/delete for multiple API keys
- **SS Mode** — `token-blurred` CSS class (blur on hover)
- **Auto-refresh** — Health check every 15s
- **Collapsible Sections** — Models, Search, Enabled, API Key, Quick Actions, Context Mode, CodeGraph, Environment, Proxy Configuration
- **Bing Wallpaper** — Daily rotating backgrounds toggle

## Request Lifecycle

```
Client request arrives
    ↓
Check API key authorization (if apiKeys configured)
    ↓
Route by pathname → handler
    ↓
Parse + validate request body
    ↓
Detect session signal (fingerprint first user msg)
    ↓
  ├─ Known fingerprint → pin to same token (sticky)
  └─ New fingerprint → rotate to next key, store mapping
    ↓
Clone payload, normalize tool schemas
    ↓
Forward to upstream api.featherless.ai/v1
    ↓
Success → pipe/buffer response (stream or JSON), log done
Error   → parse upstream error, return formatted response
```

## Startup Sequence

1. `loadConfig()` — Load `.config/config.json` + env var overrides
2. `UpstreamClient` — Initialize HTTP client
3. `validateApiKey()` — Verify via `/models` (optional, warns if missing)
4. `setupOpencodeConfig()` — Write/update opencode provider config
5. `http.createServer(handleRequest).listen(port)` — Start HTTP server on port 8082

## Testing

```bash
# Syntax check
node --check proxy.js
node --check codegraph.js
node --check context-mode.js

# Start proxy
node proxy.js

# Test endpoints
curl http://localhost:8082/healthz
curl http://localhost:8082/v1/models
curl http://localhost:8082/api/models

# Test model search
curl "http://localhost:8082/api/models/search?q=llama"

# Test CodeGraph
curl -X POST http://localhost:8082/api/cg/index \
  -H "Content-Type: application/json" \
  -d '{"filePath": "."}'
curl "http://localhost:8082/api/cg/search?q=proxy"
curl "http://localhost:8082/api/cg/explore?q=handleRequest"

# Test Context Mode
curl -X POST http://localhost:8082/api/ctx/execute \
  -H "Content-Type: application/json" \
  -d '{"code": "console.log(42)", "language": "javascript"}'
curl "http://localhost:8082/api/ctx/stats"
```

## Dependencies

No external npm dependencies — uses Node.js built-in modules only: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`, `child_process`.

## Data Storage

- `.config/config.json` — Proxy configuration (API keys, enabled models, display names)
- `.codegraph/graph.json` — CodeGraph knowledge graph (nodes, edges, files, routes)
- `.context-mode/sessions/meta.json` — Session events and tool call stats
- `.context-mode/content/` — Indexed content chunks
- `.context-mode/stats.json` — Global context savings stats
- `.cache/wallpaper.jpg` — Cached Bing wallpaper

## Response Caching

Configurable LRU cache for non-streaming LLM responses.

- **Key**: MD5 hash of `(model + stream_flag + system + messages + tools)`
- **TTL**: Configurable via `CACHE_TTL` (env or config, default `60s`)
- **Max size**: Configurable via `CACHE_MAX_SIZE` (env or config, default 100 entries)
- **Disable**: Set `CACHE_ENABLED=false`
- **Stats**: `GET /api/cache` — hits, misses, evictions, size
- **Clear**: `DELETE /api/cache`
