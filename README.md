# ATLAS — AI Transport Logistics Agent Standard

**The open-source MCP server that gives AI agents deep context about your logistics operations — without your data ever leaving your infrastructure.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)
[![Docker](https://img.shields.io/badge/Docker-cargofy%2Fatlas-blue?logo=docker)](https://hub.docker.com/r/cargofy/atlas)

---

## The Problem

Enterprise logistics companies have years of operational data — emails, contracts, TMS records, carrier relationships, pricing history. AI agents need this context to be useful. But sharing raw data with external cloud services is a non-starter for compliance, legal, and security teams.

The result: AI stays shallow. Agents can't negotiate from context. Every interaction starts from zero.

## The Solution

ATLAS runs **inside your security perimeter**. It connects to your existing systems, indexes your data locally, and exposes a standardized MCP interface. Any AI agent can query ATLAS — getting deep operational context — without your data ever leaving your infrastructure.

```
[Your Company]                        [Cargofy / Any AI Agent]
  ├── Email                                      │
  ├── TMS                    MCP Protocol        │
  ├── ERP          ←─────────────────────────────┤
  ├── Contracts              (questions only,    │
  ├── Knowledge Base          no raw data out)   │
  └── ATLAS instance ────────────────────────────┘
```

Your data stays with you. Agents get the context they need.

---

## Quick Start

**Option 1: Docker (recommended)**

```bash
docker run -p 3000:3000 cargofy/atlas
```

Open http://localhost:3000 — the Setup Wizard will guide you through initial configuration.

For production use with persistent data and AI features, see [DOCKER.md](DOCKER.md).

**Option 2: Claude Desktop**

Add to your `claude_desktop_config.json` under `mcpServers`:

```json
{
  "atlas": {
    "command": "docker",
    "args": ["run", "--rm", "-i", "cargofy/atlas", "node", "src/index.js"]
  }
}
```

**Option 3: Run from source**

```bash
git clone https://github.com/cargofy/ATLAS
cd ATLAS
npm install
cp config.example.yml config.yml   # edit with your settings
node seed.js                       # optional: load sample data
node src/ui-server.js              # Web UI + API on port 3000
# or
node src/index.js                  # MCP server on stdio
```

---

## Web UI

ATLAS ships with a full web interface at `http://localhost:3000`:

| Page | Description |
|------|-------------|
| **Dashboard** | Server status, record counts, connector health, SLA violations |
| **Explorer** | Browse data models, execute queries with visual filters |
| **Chat** | Conversational AI interface with tool calling for logistics queries |
| **Playground** | Test MCP tools directly from the browser |
| **Knowledge Base** | Manage enterprise knowledge files (markdown, folders, CRUD) |
| **Import** | Upload data files (JSON, CSV, XLSX), seed database, import from folders |
| **Connectors** | View and manage data source configurations, trigger manual sync |
| **Modules** | Enable/disable plugins, trigger sync, view module status |
| **Settings** | Visual + YAML config editor with live reload |
| **Setup Wizard** | First-run configuration (AI provider, security, instance name) |

---

## MCP Tools

ATLAS exposes **35 MCP tools** via the [Model Context Protocol](https://modelcontextprotocol.io). Any MCP-compatible agent can connect:

| Category | Tools |
|----------|-------|
| **Discovery** | `get_available_models`, `get_schema`, `get_available_carriers`, `get_available_lanes`, `get_available_document_types`, `get_sync_status` |
| **Query** | `get_records`, `query` (natural language search across all data) |
| **Shipments** | `get_shipment`, `get_shipments`, `get_shipment_events`, `get_unsigned_documents`, `get_closure_checklist` |
| **Carriers** | `search_carriers`, `get_carrier_shipments` |
| **Rates** | `get_rate_history` |
| **Documents** | `list_documents` |
| **Operations** | `get_sla_violations`, `get_idle_assets`, `get_anomalies`, `get_active_issues` (20+ disruption types) |

---

## AI Features

ATLAS supports multiple AI providers with role-based model routing:

| Provider | Models | Use |
|----------|--------|-----|
| **Anthropic** | Claude Sonnet/Opus/Haiku | Chat, extraction, knowledge enrichment |
| **OpenAI** | GPT-4o, GPT-4o-mini | Chat, extraction |
| **Ollama** | Any local model | Fully offline operation |

**AI capabilities:**
- **Entity extraction** — upload any logistics document (PDF, CSV, XLSX, email) and extract structured data (shipments, carriers, rates, documents)
- **Knowledge enrichment** — AI automatically updates your knowledge base from extracted data, detecting contradictions and appending new facts
- **Chat with tools** — conversational interface that queries your data using MCP tools
- **Role routing** — assign different models to different tasks (chat, extraction, knowledge)

---

## Data Models

### Core Models (always enabled)

| Model | Description |
|-------|-------------|
| **Shipments** | Ocean, air, road, rail, multimodal — status, mode, route, carrier, planned delivery |
| **Carriers** | Profiles, type (trucking, shipping line, airline, rail, broker), country, rating |
| **Lanes** | Origin → destination pairs with mode and average transit days |
| **Rates** | Freight pricing by carrier, lane, mode, date range |
| **Documents** | BOL, CMR, AWB, invoice, customs, POD, packing list, certificate of origin |
| **Tracking Events** | Pickup, transit, delivery, exception events with location and geolocation |
| **Service Levels** | Planned transit times per lane/mode/service type |

### Extension Models (opt-in via config)

Assets, Drivers, Transport Orders, Facilities, Tenders, Tender Quotes, Tender Awards, Dispatches, Legs, Customs Entries

---

## Connectors

| Connector | Status | Description |
|-----------|--------|-------------|
| REST API | Available | Generic REST with JSONPath mapping, bearer/basic/api_key auth |
| Filesystem | Available | Local JSON, CSV, TXT, MD files (optional PDF/DOCX/XLSX) |
| AI Extract | Available | Upload files for AI-powered entity extraction |
| Email (IMAP/Exchange) | v0.2 | Indexes logistics-related emails |
| SAP TM | Coming soon | SAP Transportation Management |
| Oracle TMS | Coming soon | Oracle Transportation Management |
| Transporeon | Coming soon | Transporeon platform integration |
| project44 | Coming soon | Visibility and tracking data |

## Modules (Plugins)

| Module | Description |
|--------|-------------|
| **file-watch** | Monitor a local folder for new files, auto-process through AI extraction pipeline |
| **knowledge-enricher** | Automatically enrich knowledge base from AI extractions |
| **google-drive** | Sync files from Google Drive folders with AI analysis (Docs/Sheets export, recursion) |

Modules are enabled/disabled via `config.yml` or the Modules page in Web UI.

---

## Architecture

```
ATLAS Instance (your infrastructure)
├── AI Layer
│   ├── Multi-provider LLM client (Claude, OpenAI, Ollama)
│   ├── Entity extraction pipeline
│   ├── Knowledge engine (enrichment + contradiction detection)
│   └── Chat with tool calling
├── Module System (plugin architecture)
│   ├── file-watch
│   ├── knowledge-enricher
│   └── google-drive
├── Connectors
│   ├── REST API connector
│   ├── Filesystem connector
│   └── AI extraction connector
├── Storage Layer
│   ├── SQLite (default) or PostgreSQL
│   └── Knowledge base (markdown files)
├── MCP Server
│   ├── stdio transport (CLI / Claude Desktop)
│   └── HTTP/SSE transport (remote agents)
└── Web UI + REST API
    ├── Dashboard, Explorer, Chat, Playground
    ├── Knowledge Base manager
    ├── Settings, Modules, Import
    └── Setup Wizard
```

---

## Security & Privacy

- **Zero data egress** — ATLAS never sends your raw data outside your network
- **Local AI option** — run Ollama for fully offline operation
- **Bearer token auth** — scoped permissions (read/write) per token
- **Non-root Docker** — runs as unprivileged `atlas` user
- **Audit logs** — full log of every query made to your instance
- **Open source** — inspect every line of code

---

## Use Cases

**Carrier Negotiation Agent**
> Agent queries ATLAS: "What's our volume with DHL on DE→PL in Q4?" → Gets answer from your own data → Negotiates from a position of knowledge.

**Customer Service Agent**
> "Where is shipment #12345?" → Agent queries ATLAS for shipment status from your TMS → Answers instantly without manual lookup.

**Procurement Agent**
> "Who are the top 3 carriers for refrigerated transport to Ukraine?" → Agent pulls from your historical performance data in ATLAS → Makes data-driven recommendation.

---

## Powered by Cargofy

ATLAS is built and maintained by [Cargofy](https://cargofy.com) — the AI platform for logistics. We built ATLAS because our enterprise customers needed it. We open-sourced it because the logistics industry needs a standard.

**Cargofy platform** connects to your ATLAS instance to provide:
- AI agents that make calls, send messages, negotiate on your behalf
- Analytics and reporting on top of your ATLAS data
- Managed ATLAS hosting (if you prefer not to self-host)
- Enterprise connectors and SLA support

> [Learn more about Cargofy](https://cargofy.com)

---

## Contributing

ATLAS is Apache 2.0 licensed. Contributions welcome.

```bash
git clone https://github.com/cargofy/atlas
cd atlas
npm install
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE)

---

## Listed In

ATLAS is submitted to the following MCP directories and lists:

[![punkpeye/awesome-mcp-servers](https://img.shields.io/badge/awesome--mcp--servers-punkpeye-blue?logo=github)](https://github.com/punkpeye/awesome-mcp-servers)
[![appcypher/awesome-mcp-servers](https://img.shields.io/badge/awesome--mcp--servers-appcypher-blue?logo=github)](https://github.com/appcypher/awesome-mcp-servers)
[![wong2/awesome-mcp-servers](https://img.shields.io/badge/awesome--mcp--servers-wong2-blue?logo=github)](https://github.com/wong2/awesome-mcp-servers)
[![modelcontextprotocol/servers](https://img.shields.io/badge/MCP%20Official-Community%20Server-green?logo=github)](https://github.com/modelcontextprotocol/servers)
[![PulseMCP](https://img.shields.io/badge/PulseMCP-Listed-orange)](https://pulsemcp.com)
[![MCP Index](https://img.shields.io/badge/MCP%20Index-Listed-purple)](https://mcpindex.net)
[![Cursor Directory](https://img.shields.io/badge/Cursor%20Directory-Listed-black)](https://cursor.directory)

> Submit, discover, and explore MCP servers in the ecosystem.
