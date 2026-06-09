# FeatherProxy

OpenAI-compatible proxy server for [Featherless AI](https://featherless.ai), with built-in **CodeGraph** code intelligence and **Context Mode** context window optimization. Zero external dependencies — uses only Node.js built-in modules.

<img width="867" height="562" alt="image" src="https://github.com/user-attachments/assets/cf2e102f-7c9a-49f1-aa7e-56090457c749" />

## Features

- **OpenAI-Compatible API** — Standard `/v1/chat/completions` and `/v1/models` endpoints
- **Model Search & Add** — Search the Featherless.ai catalog from the dashboard and add models with one click
- **Streaming Support** — SSE streaming for chat completions
- **Tool Schema Normalization** — Resolves `$ref` and `$defs` in tool schemas before forwarding
- **Dashboard UI** — Liquid glass effects, model search, code intelligence, context optimization
- **Auto-Config** — Automatically configures opencode provider on startup
- **Response Caching** — Configurable LRU cache for non-streaming responses
- **CodeGraph** — Pre-indexed code knowledge graph with symbol search, explore, callers/callees, impact analysis
- **Context Mode** — Sandbox code execution (12 languages), session tracking, content indexing, compaction recovery

## Quick Start

```bash
# Clone and start (zero deps — no npm install needed)
cd FEATHER-PROXY
node proxy.js

# Open dashboard
open http://localhost:8082
```

## Authentication

Get a Featherless API key from [featherless.ai/account/api-keys](https://featherless.ai/account/api-keys).

Add to `.config/config.json`:

```json
{
  "API_KEY": "rc_your-api-key-here"
}
```

Or set environment variable:

```bash
set FEATHERLESS_API_KEY=rc_your-api-key-here
node proxy.js
```

## Configuration

Edit `.config/config.json` or set environment variables:

| Key | Description | Default |
|-----|-------------|---------|
| `LISTEN_ADDR` | Proxy listen address | `127.0.0.1:8082` |
| `UPSTREAM_BASE_URL` | Featherless API URL | `https://api.featherless.ai/v1` |
| `API_KEY` | Featherless API key (`rc_*`) | — |
| `REQUEST_TIMEOUT` | Upstream request timeout | `15m` |
| `API_KEYS` | Client API keys for proxy auth | `[]` (open access) |
| `TOKENS` | Array of `{name, token}` for multi-key support | auto-populated |

## Dashboard

Access at `http://localhost:8082`:

- **Search & Add Models** — Search Featherless.ai catalog, filter by family/context size, add models with one click
- **Enabled Models** — Click to edit display names, remove with X
- **CodeGraph** — Index projects, search symbols, explore code, impact analysis, framework route detection
- **Context Mode** — Execute code in sandbox (12 languages), search/index knowledge base, context savings stats
- **API Key Management** — Add/edit/delete multiple API keys
- **Liquid Glass Effects** — Canvas-generated SVG displacement maps
- **Bing Wallpaper** — Daily rotating backgrounds toggle
- **SS Mode** — Blur sensitive tokens on hover

## API Endpoints

### Core API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check with API key status and uptime |
| `GET` | `/v1/models` | OpenAI models list |
| `POST` | `/v1/chat/completions` | OpenAI chat completions (streaming supported) |

### Model Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/models/search?q=...` | Search Featherless.ai model catalog |
| `POST` | `/api/models/add` | Add models to enabled list |
| `POST` | `/api/models/remove` | Remove models from enabled list |

### CodeGraph API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/cg/index` | Index project directory |
| `POST` | `/api/cg/index-file` | Index single file |
| `GET` | `/api/cg/search?q=...` | Search symbols |
| `GET` | `/api/cg/explore?q=...` | Explore codebase (symbols + source + relationships) |
| `GET` | `/api/cg/symbol/:name` | Symbol details |
| `GET` | `/api/cg/callers/:name` | Find callers |
| `GET` | `/api/cg/callees/:name` | Find callees |
| `GET` | `/api/cg/impact/:name` | Impact analysis |
| `GET` | `/api/cg/files` | Indexed files |
| `GET` | `/api/cg/status` | Graph stats |
| `GET` | `/api/cg/routes` | Framework routes |
| `POST` | `/api/cg/clear` | Reset graph |

### Context Mode API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ctx/execute` | Run code in sandbox |
| `POST` | `/api/ctx/batch-execute` | Run multiple commands |
| `POST` | `/api/ctx/index` | Index text content |
| `POST` | `/api/ctx/index-file` | Index file/directory |
| `GET` | `/api/ctx/search?q=...` | Search knowledge base |
| `GET` | `/api/ctx/stats` | Context savings stats |
| `GET` | `/api/ctx/events` | Session events |
| `GET` | `/api/ctx/resume` | Resume snapshot |
| `POST` | `/api/ctx/purge` | Clear indexed content |
| `POST` | `/api/ctx/fetch-and-index` | Fetch URL and index |

### Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` / `POST` | `/api/config` | Read/write proxy configuration |
| `GET` | `/api/validate` | Validate API key |
| `GET` | `/api/bg` | Get Bing wallpaper URL |
| `GET` / `POST` | `/api/keys` | Multi-key CRUD |
| `GET` | `/api/cache` | Response cache stats |
| `DELETE` | `/api/cache` | Clear response cache |

## CodeGraph

Semantic code intelligence — symbol extraction, relationship mapping, and impact analysis for 20+ languages.

### Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, Swift, Kotlin, Scala, Dart, Lua, Vue, Svelte

### Framework Routes

Django, Flask, FastAPI, Express, Rails, Laravel, Spring, Gin — automatically detected and linked to handlers.

### Usage

```bash
# Index a project
curl -X POST http://localhost:8082/api/cg/index \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/path/to/project"}'

# Search symbols
curl "http://localhost:8082/api/cg/search?q=userService"

# Explore codebase
curl "http://localhost:8082/api/cg/explore?q=how+does+auth+work&includeCode=true"

# Impact analysis
curl "http://localhost:8082/api/cg/impact/UserService?depth=2"
```

## Context Mode

Context window optimization — sandbox execution, session tracking, content indexing, and compaction recovery.

### Sandbox Execution

Run code in 12 languages with process isolation:

```bash
curl -X POST http://localhost:8082/api/ctx/execute \
  -H "Content-Type: application/json" \
  -d '{"code": "console.log(process.versions)", "language": "javascript"}'
```

### Supported Languages

JavaScript, TypeScript, Python, Bash, Ruby, Go, Rust, PHP, Perl, R, Elixir, C#

### Content Indexing

```bash
# Index a file
curl -X POST http://localhost:8082/api/ctx/index-file \
  -H "Content-Type: application/json" \
  -d '{"filePath": "README.md"}'

# Index text
curl -X POST http://localhost:8082/api/ctx/index \
  -H "Content-Type: application/json" \
  -d '{"label": "notes", "content": "Important context..."}'

# Search
curl "http://localhost:8082/api/ctx/search?q=authentication+setup"
```

## Architecture

```
proxy.js            — Main proxy, request router, OpenAI endpoints
codegraph.js        — Code knowledge graph (20+ languages, symbol extraction, impact analysis)
context-mode.js     — Context optimization (sandbox, session tracking, content indexing)
dashboard.html      — Liquid glass dashboard with model search + CodeGraph + Context Mode UI
.config/config.json — Runtime configuration
```

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
curl "http://localhost:8082/api/models/search?q=llama"
curl http://localhost:8082/api/cg/status
curl http://localhost:8082/api/ctx/stats
```

## Dependencies

No external npm dependencies — uses Node.js built-in modules only: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`, `child_process`.

## License

MIT
