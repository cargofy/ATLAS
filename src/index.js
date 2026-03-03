/**
 * ATLAS MCP Server — v0.2
 * AI Transport Logistics Agent Standard
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Atlas } from "./atlas.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const atlas = new Atlas();
try { atlas.loadConfig(process.env.ATLAS_CONFIG); }
catch (err) { console.error(`[ATLAS] Config warning: ${err.message}`); }
try { atlas.initDb(process.env.ATLAS_DB_PATH ?? ":memory:"); }
catch (err) { console.error(`[ATLAS] DB init error: ${err.message}`); process.exit(1); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const err = (code, message) => ({
  content: [{ type: "text", text: JSON.stringify({ error_code: code, message }) }],
  isError: true,
});

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({ name: "atlas", version: "0.2.0" });

// ──────────────────────────────────────────────────────────────────────────────
// DISCOVERY TOOLS — "What data do you have?"
// ──────────────────────────────────────────────────────────────────────────────

server.tool(
  "get_available_carriers",
  "List all carriers indexed by ATLAS with their IDs, names, countries, and types. Call this first to discover available carrier IDs before querying details.",
  {},
  async () => {
    try {
      const carriers = atlas.getAvailableCarriers();
      return ok({ carriers, total: carriers.length });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool(
  "get_available_lanes",
  "List all unique origin→destination lanes with rate data indexed in ATLAS. Use to discover available routes before querying rate history.",
  {},
  async () => {
    try {
      const lanes = atlas.getAvailableLanes();
      return ok({ lanes, total: lanes.length });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool(
  "get_available_document_types",
  "List all document types indexed in ATLAS with counts. Use to discover what document types exist before filtering.",
  {},
  async () => {
    try {
      const types = atlas.getAvailableDocumentTypes();
      return ok({ document_types: types });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool(
  "get_sync_status",
  "Return data freshness for every ATLAS table: record counts and last sync timestamp. Use to check if data is up to date before making decisions.",
  {},
  async () => {
    try {
      const sync = atlas.getSyncStatus();
      return ok({ sync_status: sync, checked_at: new Date().toISOString() });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// SHIPMENT TOOLS
// ──────────────────────────────────────────────────────────────────────────────

server.tool(
  "get_shipment",
  "Retrieve full details for a specific shipment by ID.",
  { id: z.string().describe("Shipment ID") },
  async ({ id }) => {
    try {
      const shipment = atlas.getShipment(id);
      if (!shipment) return err("SHIPMENT_NOT_FOUND", `No shipment found with ID: ${id}`);
      return ok({ shipment });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool(
  "get_shipments",
  "List shipments with optional filters. Returns named envelope with total count and sync timestamp.",
  {
    status: z
      .enum(["pending","in_transit","customs","delivered","exception","cancelled"])
      .optional()
      .describe("Filter by shipment status"),
    mode: z
      .enum(["road","ocean","air","rail","multimodal"])
      .optional()
      .describe("Filter by transport mode"),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Created from date (YYYY-MM-DD)"),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Created to date (YYYY-MM-DD)"),
    limit: z.number().int().min(1).max(200).optional().default(20)
      .describe("Max results (default: 20)"),
  },
  async ({ status, mode, start_date, end_date, limit }) => {
    try {
      const result = atlas.listShipments({ status, mode, start_date, end_date, limit });
      return ok(result);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool(
  "get_shipment_events",
  "Get the event timeline for a specific shipment: scans, status changes, exceptions.",
  {
    shipment_id: z.string().describe("Shipment ID"),
    exceptions_only: z.boolean().optional().default(false)
      .describe("Return only exception events"),
    limit: z.number().int().min(1).max(200).optional().default(50),
  },
  async ({ shipment_id, exceptions_only, limit }) => {
    try {
      const shipment = atlas.getShipment(shipment_id);
      if (!shipment) return err("SHIPMENT_NOT_FOUND", `No shipment found: ${shipment_id}`);
      const result = atlas.listEvents({ shipment_id, exceptions_only, limit });
      return ok({ ...result, shipment_id });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// CARRIER TOOLS
// ──────────────────────────────────────────────────────────────────────────────

server.tool(
  "search_carriers",
  "Search carriers by country, type, minimum rating, or free-text query. Returns named envelope with total and sync timestamp.",
  {
    query: z.string().optional()
      .describe("Free-text search (name, description, specialization)"),
    country: z.string().length(2).optional()
      .describe("ISO 3166-1 alpha-2 country code (e.g. DE, NL, PL)"),
    type: z.enum(["trucking","shipping_line","airline","rail","broker"]).optional(),
    min_rating: z.number().min(0).max(5).optional()
      .describe("Minimum carrier rating (0–5)"),
    limit: z.number().int().min(1).max(100).optional().default(20),
  },
  async ({ query, country, type, min_rating, limit }) => {
    try {
      const result = atlas.searchCarriers({ query, country, type, min_rating, limit });
      if (!result.carriers.length) return err("NO_RESULTS", "No carriers found matching criteria.");
      return ok(result);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool(
  "get_carrier_shipments",
  "Get all shipments handled by a specific carrier. Useful for performance analysis and relationship traversal.",
  {
    carrier_id: z.string().describe("Carrier ID (use get_available_carriers to discover IDs)"),
    limit: z.number().int().min(1).max(100).optional().default(20),
  },
  async ({ carrier_id, limit }) => {
    try {
      const carrier = atlas.getCarrier(carrier_id);
      if (!carrier) return err("CARRIER_NOT_FOUND", `No carrier found with ID: ${carrier_id}`);
      const result = atlas.getCarrierShipments(carrier_id, { limit });
      return ok({ ...result, carrier_name: carrier.name ?? carrier_id });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// RATE TOOLS
// ──────────────────────────────────────────────────────────────────────────────

server.tool(
  "get_rate_history",
  "Retrieve freight rate history for a lane (origin→destination) with optional carrier and date range filters.",
  {
    origin: z.string().length(2).optional()
      .describe("Origin country code (ISO 3166-1 alpha-2, e.g. PL)"),
    destination: z.string().length(2).optional()
      .describe("Destination country code (ISO 3166-1 alpha-2, e.g. DE)"),
    carrier_id: z.string().optional()
      .describe("Filter by specific carrier ID"),
    mode: z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("Rate valid from (YYYY-MM-DD). Defaults to 90 days ago."),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe("Rate valid to (YYYY-MM-DD). Defaults to today."),
    limit: z.number().int().min(1).max(200).optional().default(50),
  },
  async ({ origin, destination, carrier_id, mode, start_date, end_date, limit }) => {
    try {
      if (!origin && !destination && !carrier_id) {
        return err("MISSING_PARAMS", "Provide at least one of: origin, destination, carrier_id");
      }
      const result = atlas.getRateHistory({ carrier_id, origin, destination, mode, start_date, end_date, limit });
      if (!result.rates.length) return err("NO_RESULTS", "No rate records found for the specified criteria.");
      return ok(result);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// DOCUMENT TOOLS
// ──────────────────────────────────────────────────────────────────────────────

server.tool(
  "list_documents",
  "List logistics documents filtered by shipment ID or document type.",
  {
    shipment_id: z.string().optional()
      .describe("Filter by shipment ID"),
    type: z.enum([
      "bol","cmr","awb","invoice","customs_export","customs_import",
      "pod","packing_list","certificate_of_origin","dangerous_goods","other",
    ]).optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  },
  async ({ shipment_id, type, limit }) => {
    try {
      const result = atlas.listDocuments({ shipment_id, type, limit });
      if (!result.documents.length) return err("NO_RESULTS", "No documents found.");
      return ok(result);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// QUERY (natural language)
// ──────────────────────────────────────────────────────────────────────────────

server.tool(
  "query",
  "Full-text search across all indexed logistics data using natural language. Use specific tools (get_shipments, search_carriers, get_rate_history) when you know what type of data you need.",
  {
    question: z.string().describe("Natural language question about logistics data"),
    mode: z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    limit: z.number().int().min(1).max(100).optional().default(10),
  },
  async ({ question, mode, limit }) => {
    try {
      const { results, context } = atlas.query(question, { mode, limit });
      return ok({ query: question, result_count: results.length, results, context });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[ATLAS] MCP server v0.2 running on stdio");
