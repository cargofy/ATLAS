/**
 * ATLAS Combined Server — v0.3
 * Serves:
 *   - Web UI at /
 *   - REST API at /api/*
 *   - MCP over HTTP/SSE at /mcp  (GET=stream, POST=message)
 *   - Bearer token auth on /mcp endpoints
 */
import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

import { Atlas } from "./atlas.js";
import { ConnectorRunner } from "./connector-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(__dirname, "ui", "index.html");

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const atlas = new Atlas();
try { atlas.loadConfig(process.env.ATLAS_CONFIG); }
catch (e) { console.error(`[ATLAS] Config warning: ${e.message}`); }
atlas.initDb(process.env.ATLAS_DB_PATH ?? atlas.config?.storage?.path ?? ":memory:");

// Start connector runner (polls configured data sources)
const runner = new ConnectorRunner(atlas, atlas.config);
runner.start();

// ─── Auth ─────────────────────────────────────────────────────────────────────

const configuredTokens = (atlas.config?.auth?.tokens ?? []).map(t => ({
  id: t.id ?? t.name ?? 'unnamed',
  token: t.token?.startsWith('${') ? (process.env[t.token.slice(2,-1)] ?? t.token) : t.token,
  permissions: t.permissions ?? ['read'],
}));

function checkAuth(req) {
  // No tokens configured → open access (dev mode)
  if (!configuredTokens.length) return { ok: true, id: 'anonymous' };

  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, reason: 'Missing Bearer token' };

  const found = configuredTokens.find(t => t.token === token);
  if (!found) return { ok: false, reason: 'Invalid token' };
  return { ok: true, id: found.id, permissions: found.permissions };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

function buildMcpServer() {
  const server = new McpServer({ name: "atlas", version: "0.3.0" });

  const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  const err = (code, msg) => ({ content: [{ type: "text", text: JSON.stringify({ error_code: code, message: msg }) }], isError: true });

  // Discovery
  server.tool("get_available_carriers", "List all indexed carrier IDs and names.", {}, async () => {
    try { return ok({ carriers: atlas.getAvailableCarriers(), total: atlas.getAvailableCarriers().length }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  });
  server.tool("get_available_lanes", "List all indexed origin→destination lanes with rate data.", {}, async () => {
    try { const l = atlas.getAvailableLanes(); return ok({ lanes: l, total: l.length }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  });
  server.tool("get_available_document_types", "List document types indexed in ATLAS with counts.", {}, async () => {
    try { return ok({ document_types: atlas.getAvailableDocumentTypes() }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  });
  server.tool("get_sync_status", "Return data freshness per table: counts and last sync timestamps.", {}, async () => {
    try { return ok({ sync_status: atlas.getSyncStatus(), checked_at: new Date().toISOString(), connectors: runner.getStats() }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  });

  // Shipments
  server.tool("get_shipment", "Get full details for a shipment by ID.", { id: z.string() }, async ({ id }) => {
    try {
      const s = atlas.getShipment(id);
      return s ? ok({ shipment: s }) : err("SHIPMENT_NOT_FOUND", `No shipment: ${id}`);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  });
  server.tool("get_shipments", "List shipments with optional filters.", {
    status: z.enum(["pending","in_transit","customs","delivered","exception","cancelled"]).optional(),
    mode: z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.number().int().min(1).max(200).optional().default(20),
  }, async (args) => {
    try { return ok(atlas.listShipments(args)); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  });
  server.tool("get_shipment_events", "Get event timeline for a shipment.", {
    shipment_id: z.string(),
    exceptions_only: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(200).optional().default(50),
  }, async (args) => {
    try {
      const s = atlas.getShipment(args.shipment_id);
      if (!s) return err("SHIPMENT_NOT_FOUND", `No shipment: ${args.shipment_id}`);
      return ok({ ...atlas.listEvents(args), shipment_id: args.shipment_id });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  });

  // Carriers
  server.tool("search_carriers", "Search carriers by country, type, rating, or free text.", {
    query: z.string().optional(),
    country: z.string().length(2).optional(),
    type: z.enum(["trucking","shipping_line","airline","rail","broker"]).optional(),
    min_rating: z.number().min(0).max(5).optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }, async (args) => {
    try {
      const r = atlas.searchCarriers(args);
      return r.carriers.length ? ok(r) : err("NO_RESULTS", "No carriers found.");
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  });
  server.tool("get_carrier_shipments", "Get all shipments for a carrier.", {
    carrier_id: z.string(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }, async ({ carrier_id, limit }) => {
    try {
      const c = atlas.getCarrier(carrier_id);
      if (!c) return err("CARRIER_NOT_FOUND", `No carrier: ${carrier_id}`);
      return ok({ ...atlas.getCarrierShipments(carrier_id, { limit }), carrier_name: c.name ?? carrier_id });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  });

  // Rates
  server.tool("get_rate_history", "Freight rate history for a lane with optional carrier and date range.", {
    origin: z.string().length(2).optional(),
    destination: z.string().length(2).optional(),
    carrier_id: z.string().optional(),
    mode: z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  }, async (args) => {
    try {
      if (!args.origin && !args.destination && !args.carrier_id) return err("MISSING_PARAMS", "Provide origin, destination, or carrier_id");
      const r = atlas.getRateHistory(args);
      return r.rates.length ? ok(r) : err("NO_RESULTS", "No rates found.");
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  });

  // Documents
  server.tool("list_documents", "List logistics documents with optional filters.", {
    shipment_id: z.string().optional(),
    type: z.enum(["bol","cmr","awb","invoice","customs_export","customs_import","pod","packing_list","certificate_of_origin","dangerous_goods","other"]).optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  }, async (args) => {
    try {
      const r = atlas.listDocuments(args);
      return r.documents.length ? ok(r) : err("NO_RESULTS", "No documents found.");
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  });

  // Query
  server.tool("query", "Natural language search across all indexed logistics data.", {
    question: z.string(),
    mode: z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    limit: z.number().int().min(1).max(100).optional().default(10),
  }, async ({ question, mode, limit }) => {
    try {
      const r = atlas.query(question, { mode, limit });
      return ok({ query: question, result_count: r.results.length, results: r.results, context: r.context });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  });

  return server;
}

// ─── SSE session store ────────────────────────────────────────────────────────

const sseTransports = new Map(); // sessionId → SSEServerTransport

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.ATLAS_PORT ?? atlas.config?.atlas?.port ?? "3000");

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  const cors = () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  };

  cors();
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── MCP over HTTP/SSE ───────────────────────────────────────────────────────

  // GET /mcp — open SSE stream (client connects here)
  if (req.method === "GET" && path === "/mcp") {
    const auth = checkAuth(req);
    if (!auth.ok) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", reason: auth.reason }));
      return;
    }

    const mcpServer = buildMcpServer();
    const transport = new SSEServerTransport("/mcp/message", res);
    sseTransports.set(transport.sessionId, transport);

    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
      console.error(`[ATLAS] MCP SSE session closed: ${transport.sessionId} (client: ${auth.id})`);
    });

    await mcpServer.connect(transport);
    console.error(`[ATLAS] MCP SSE session opened: ${transport.sessionId} (client: ${auth.id})`);
    return;
  }

  // POST /mcp/message — client sends MCP message (sessionId in query)
  if (req.method === "POST" && path === "/mcp/message") {
    const auth = checkAuth(req);
    if (!auth.ok) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", reason: auth.reason }));
      return;
    }

    const sessionId = url.searchParams.get("sessionId");
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found. Open GET /mcp first." }));
      return;
    }

    await transport.handlePostMessage(req, res);
    return;
  }

  // ── REST API ─────────────────────────────────────────────────────────────────

  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (path === "/api/status" && req.method === "GET") {
    return json({
      status: "running",
      version: "0.3.0",
      uptime: Math.round(process.uptime()),
      counts: atlas.getSyncStatus(),
      connectors: runner.getStats(),
    });
  }

  if (path === "/api/connectors" && req.method === "GET") {
    return json({ connectors: runner.getStats() });
  }

  // POST /api/connectors/:id/sync — manual trigger
  const syncMatch = path.match(/^\/api\/connectors\/([^/]+)\/sync$/);
  if (syncMatch && req.method === "POST") {
    const connectorId = syncMatch[1];
    const connector = runner.connectors.find(c => c.id === connectorId);
    if (!connector) return json({ error: "Connector not found" }, 404);
    runner._runConnector(connector); // fire-and-forget
    return json({ ok: true, message: `Sync triggered for connector: ${connectorId}` });
  }

  if (path.startsWith("/api/data/") && req.method === "GET") {
    const table = path.split("/")[3];
    const valid = ["shipments","carriers","routes","rates","documents","events"];
    if (!valid.includes(table)) return json({ error: "Unknown table" }, 400);
    try {
      const limit = parseInt(url.searchParams.get("limit") ?? "100");
      const search = url.searchParams.get("search")?.toLowerCase() ?? "";
      let rows = atlas.db.prepare(`SELECT data FROM ${table} LIMIT ?`).all(limit).map(r => JSON.parse(r.data));
      if (search) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(search));
      return json({ table, rows, total: rows.length });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (path === "/api/query" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { tool, params } = JSON.parse(body);
        let result;
        if (tool === "query")               result = atlas.query(params?.question ?? "", { limit: params?.limit });
        else if (tool === "get_shipment")   result = { shipment: atlas.getShipment(params?.id) };
        else if (tool === "search_carriers") result = atlas.searchCarriers(params ?? {});
        else if (tool === "get_rate_history") result = atlas.getRateHistory(params ?? {});
        else if (tool === "list_documents") result = atlas.listDocuments(params ?? {});
        else { json({ error: `Unknown tool: ${tool}` }, 400); return; }
        json({ ok: true, result });
      } catch (e) { json({ error: e.message }, 400); }
    });
    return;
  }

  // ── Admin endpoints (ATLAS-08, ATLAS-09) ─────────────────────────────────────

  if (path === "/api/admin/reload" && req.method === "POST") {
    const result = atlas.reloadConfig();
    runner.stop();
    runner.connectors = (atlas.config?.connectors ?? []).filter(c => c.enabled !== false);
    runner.start();
    return json({ ...result, connectors_restarted: runner.connectors.length });
  }

  if (path === "/api/admin/prune" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { retention_days } = body ? JSON.parse(body) : {};
        const deleted = atlas.pruneOldRecords(retention_days);
        json({ ok: true, deleted, timestamp: new Date().toISOString() });
      } catch (e) { json({ error: e.message }, 400); }
    });
    return;
  }

  // ── Web UI ────────────────────────────────────────────────────────────────────

  if (path === "/" || path === "/index.html") {
    if (existsSync(UI_PATH)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(UI_PATH));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body>
        <h1>ATLAS v0.3</h1>
        <p>Web UI not found. Build or copy src/ui/index.html.</p>
        <p>MCP endpoint: <code>GET /mcp</code> (Bearer auth required if tokens configured)</p>
        <p>API: <code>GET /api/status</code></p>
      </body></html>`);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(PORT, () => {
  console.error(`[ATLAS] Web UI:    http://localhost:${PORT}`);
  console.error(`[ATLAS] MCP/HTTP:  http://localhost:${PORT}/mcp  (SSE, Bearer auth)`);
  console.error(`[ATLAS] REST API:  http://localhost:${PORT}/api/status`);
  if (!configuredTokens.length) {
    console.error(`[ATLAS] Auth: OPEN (no tokens configured — dev mode)`);
  } else {
    console.error(`[ATLAS] Auth: ${configuredTokens.length} token(s) configured`);
  }
});

export function startWebUI(atlasInstance, port) {
  // Legacy export for compatibility
  console.error(`[ATLAS] Use: node src/ui-server.js (standalone entry point)`);
}
