/**
 * ATLAS MCP Server — stdio transport (v1.0)
 * All tools. Read-only access to logistics data.
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Atlas } from "./atlas.js";
import { ConnectorRunner } from "./connector-runner.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const atlas = new Atlas();
try { atlas.loadConfig(process.env.ATLAS_CONFIG); }
catch (e) { process.stderr.write(`[ATLAS] Config: ${e.message}\n`); }
atlas.initDb(process.env.ATLAS_DB_PATH ?? atlas.config?.storage?.path ?? ":memory:");

const runner = new ConnectorRunner(atlas, atlas.config);
runner.start();

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "atlas", version: "1.0.0" });

const ok  = data  => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const err = (code, msg) => ({
  content: [{ type: "text", text: JSON.stringify({ error_code: code, message: msg }) }],
  isError: true,
});

// ─── Discovery ────────────────────────────────────────────────────────────────

server.tool("get_available_models",
  "List all enabled ATLAS data models with record counts. Use before querying to know what data is indexed.",
  {},
  async () => {
    try { return ok({ models: atlas.getAvailableModels() }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_schema",
  "Return the schema and description for an ATLAS data model.",
  { model: z.string().describe("Model name (e.g. shipments, carriers, tenders, tracking_events)") },
  async ({ model }) => {
    try {
      const schema = atlas.getModelSchema(model);
      if (!schema) return err("MODEL_NOT_FOUND", `Unknown model: "${model}". Call get_available_models() to see what's enabled.`);
      return ok(schema);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_available_carriers",
  "List all carriers indexed in ATLAS with id, name, country, type, and rating.",
  {},
  async () => {
    try { const c = atlas.getAvailableCarriers(); return ok({ carriers: c, total: c.length }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_available_lanes",
  "List all indexed origin→destination lanes with available rate data.",
  {},
  async () => {
    try { const l = atlas.getAvailableLanes(); return ok({ lanes: l, total: l.length }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_available_document_types",
  "List document types indexed in ATLAS with counts.",
  {},
  async () => {
    try { return ok({ document_types: atlas.getAvailableDocumentTypes() }); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_sync_status",
  "Return data freshness per table: record counts and last sync timestamps. Also shows connector health.",
  {},
  async () => {
    try {
      return ok({
        sync_status: atlas.getSyncStatus(),
        connectors: runner.getStats(),
        checked_at: new Date().toISOString(),
      });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── Generic ─────────────────────────────────────────────────────────────────

server.tool("get_records",
  "Query any enabled ATLAS model by name with optional filters. Use get_available_models() first.",
  {
    model:  z.string().describe("Model table name (e.g. tenders, assets, load_listings)"),
    filters: z.record(z.any()).optional().describe("Field equality filters as {field: value}"),
    limit:  z.number().int().min(1).max(200).optional().default(50),
  },
  async ({ model, filters, limit }) => {
    try {
      const result = atlas.getRecords(model, filters ?? {}, limit);
      if (result.error) return err("MODEL_ERROR", result.error);
      if (!result.records.length) return err("NO_RESULTS", `No records found in ${model}.`);
      return ok(result);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("query",
  "Natural language search across all indexed logistics data (shipments, carriers, lanes).",
  {
    question: z.string(),
    limit:    z.number().int().min(1).max(100).optional().default(10),
  },
  async ({ question, limit }) => {
    try {
      const r = atlas.query(question, { limit });
      return ok({ query: question, result_count: r.results.length, results: r.results, context: r.context });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── Shipments ────────────────────────────────────────────────────────────────

server.tool("get_shipment",
  "Get full details for a single shipment by ID.",
  { id: z.string() },
  async ({ id }) => {
    try {
      const s = atlas.getShipment(id);
      return s ? ok({ shipment: s }) : err("SHIPMENT_NOT_FOUND", `No shipment: ${id}`);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_shipments",
  "List shipments with optional filters by status, mode, and date range.",
  {
    status:     z.enum(["pending","in_transit","customs","delivered","exception","cancelled"]).optional(),
    mode:       z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit:      z.number().int().min(1).max(200).optional().default(20),
  },
  async (args) => {
    try { return ok(atlas.listShipments(args)); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_shipment_events",
  "Get the full tracking event timeline for a shipment.",
  {
    shipment_id:    z.string(),
    exceptions_only: z.boolean().optional().default(false),
    limit:          z.number().int().min(1).max(200).optional().default(50),
  },
  async ({ shipment_id, exceptions_only, limit }) => {
    try {
      const s = atlas.getShipment(shipment_id);
      if (!s) return err("SHIPMENT_NOT_FOUND", `No shipment: ${shipment_id}`);
      return ok({ ...atlas.listEvents({ shipment_id, exceptions_only, limit }), shipment_id });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_unsigned_documents",
  "Return documents for a shipment that are still pending signature.",
  { shipment_id: z.string() },
  async ({ shipment_id }) => {
    try { return ok(atlas.getUnsignedDocuments(shipment_id)); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_closure_checklist",
  "Return a checklist of what's still needed to close (POD, signatures, review) for a shipment.",
  { shipment_id: z.string() },
  async ({ shipment_id }) => {
    try {
      const r = atlas.getClosureChecklist(shipment_id);
      if (r.error) return err("SHIPMENT_NOT_FOUND", r.error);
      return ok(r);
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── Carriers ─────────────────────────────────────────────────────────────────

server.tool("search_carriers",
  "Search carriers by country, type, minimum rating, or free text query.",
  {
    query:      z.string().optional(),
    country:    z.string().length(2).optional(),
    type:       z.enum(["trucking","shipping_line","airline","rail","freight_broker","3pl"]).optional(),
    min_rating: z.number().min(0).max(5).optional(),
    limit:      z.number().int().min(1).max(100).optional().default(20),
  },
  async (args) => {
    try {
      const r = atlas.searchCarriers(args);
      return r.carriers.length ? ok(r) : err("NO_RESULTS", "No carriers found matching filters.");
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_carrier_shipments",
  "Get all shipments handled by a specific carrier.",
  {
    carrier_id: z.string(),
    limit:      z.number().int().min(1).max(100).optional().default(20),
  },
  async ({ carrier_id, limit }) => {
    try {
      const c = atlas.getCarrier(carrier_id);
      if (!c) return err("CARRIER_NOT_FOUND", `No carrier: ${carrier_id}`);
      return ok({ ...atlas.getCarrierShipments(carrier_id, { limit }), carrier_name: c.name ?? carrier_id });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── Rates ────────────────────────────────────────────────────────────────────

server.tool("get_rate_history",
  "Retrieve freight rate history for a lane or carrier with optional date range.",
  {
    origin:      z.string().length(2).optional(),
    destination: z.string().length(2).optional(),
    carrier_id:  z.string().optional(),
    mode:        z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    start_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit:       z.number().int().min(1).max(200).optional().default(50),
  },
  async (args) => {
    try {
      if (!args.origin && !args.destination && !args.carrier_id)
        return err("MISSING_PARAMS", "Provide at least one of: origin, destination, carrier_id");
      const r = atlas.getRateHistory(args);
      return r.rates.length ? ok(r) : err("NO_RESULTS", "No rates found for the given filters.");
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── Documents ────────────────────────────────────────────────────────────────

server.tool("list_documents",
  "List logistics documents with optional filters by shipment or document type.",
  {
    shipment_id: z.string().optional(),
    type:        z.enum(["bol","cmr","awb","invoice","customs_export","customs_import","pod","packing_list","certificate_of_origin","dangerous_goods","other"]).optional(),
    limit:       z.number().int().min(1).max(200).optional().default(50),
  },
  async (args) => {
    try {
      const r = atlas.listDocuments(args);
      return r.documents.length ? ok(r) : err("NO_RESULTS", "No documents found.");
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── SLA & Operations ─────────────────────────────────────────────────────────

server.tool("get_sla_violations",
  "Return shipments that have exceeded their ServiceLevel planned transit time. Core tool for exception management.",
  {
    since:              z.string().optional().describe("ISO datetime — only check shipments synced after this time"),
    mode:               z.enum(["road","ocean","air","rail","multimodal"]).optional(),
    origin_country:     z.string().length(2).optional(),
    destination_country: z.string().length(2).optional(),
    limit:              z.number().int().min(1).max(200).optional().default(50),
  },
  async (args) => {
    try {
      const r = atlas.getSlaViolations(args);
      return ok({ ...r, checked_at: new Date().toISOString() });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_idle_assets",
  "Return assets (trucks/vehicles) that appear to be stationary with engine running for longer than the threshold.",
  {
    idle_minutes: z.number().int().min(1).optional().default(30),
  },
  async ({ idle_minutes }) => {
    try { return ok(atlas.getIdleAssets(idle_minutes)); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

server.tool("get_anomalies",
  "Return all tracking events flagged as exceptions since a given timestamp.",
  {
    since: z.string().optional().describe("ISO datetime threshold"),
    limit: z.number().int().min(1).max(200).optional().default(50),
  },
  async (args) => {
    try { return ok(atlas.getAnomalies(args)); }
    catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);


server.tool("get_active_issues",
  "Return all active (unresolved) operational disruption issues. Covers: carrier no-show, cargo not ready, mechanical failure, customs hold, border closure, tender withdrawal, and 20+ other standard logistics disruption types.",
  {
    type:                z.string().optional().describe("Issue type: carrier_no_show, cargo_not_ready, mechanical_failure, delay_border, tender_withdrawal, etc."),
    severity:            z.enum(["low","medium","high","critical"]).optional(),
    requires_replanning: z.boolean().optional().describe("Filter to only issues that require immediate replanning"),
    limit:               z.number().int().min(1).max(200).optional().default(50),
  },
  async (args) => {
    try {
      const r = atlas.getActiveIssues(args);
      return ok({ ...r, checked_at: new Date().toISOString() });
    } catch (e) { return err("INTERNAL_ERROR", e.message); }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[ATLAS] MCP server ready (stdio). 35 tools registered.\n");
