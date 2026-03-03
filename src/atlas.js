/**
 * ATLAS Core v1.0
 * Universal logistics MCP server — data layer only.
 * No actions, no decisions, no external communication.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";
import Database from "better-sqlite3";
import {
  CORE_SCHEMA, EXTENSION_SCHEMA, PARTY_SCHEMA,
  MARKETPLACE_SCHEMA, WORKFLOW_SCHEMA, ISSUE_SCHEMA, MODEL_REGISTRY, MODEL_ALIASES
} from "./models.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class Atlas {
  constructor() {
    this.config = null;
    this.db = null;
    this._enabledModels = new Set();
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  loadConfig(configPath) {
    const resolved = configPath ?? join(__dirname, "..", "config.yml");
    const fallback  = join(__dirname, "..", "config.example.yml");
    const target    = existsSync(resolved) ? resolved : (existsSync(fallback) ? fallback : null);
    if (!target) { this.config = {}; return this.config; }
    this.config = YAML.parse(readFileSync(target, "utf8")) ?? {};
    return this.config;
  }

  // ─── DB init ─────────────────────────────────────────────────────────────

  initDb(dbPath) {
    const path = dbPath ?? this.config?.storage?.path ?? ":memory:";
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this._initCoreSchema();
    this._initConnectorState();
    this._initExtensionModels();
    return this.db;
  }

  _initCoreSchema() {
    // Core tables — always created. New v1.0 names (lanes, tracking_events, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shipments (
        id TEXT PRIMARY KEY,
        status TEXT,
        mode TEXT,
        origin_country TEXT,
        destination_country TEXT,
        managed_by_party_id TEXT,
        synced_at TEXT DEFAULT (datetime('now')),
        data JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS carriers (
        id TEXT PRIMARY KEY,
        country TEXT,
        type TEXT,
        rating REAL,
        synced_at TEXT DEFAULT (datetime('now')),
        data JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lanes (
        id TEXT PRIMARY KEY,
        origin_country TEXT,
        destination_country TEXT,
        mode TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        data JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rates (
        id TEXT PRIMARY KEY,
        carrier_id TEXT,
        origin_country TEXT,
        destination_country TEXT,
        mode TEXT,
        valid_from TEXT,
        valid_to TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        data JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        shipment_id TEXT,
        type TEXT,
        signature_status TEXT DEFAULT 'draft',
        created_at TEXT DEFAULT (datetime('now')),
        data JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracking_events (
        id TEXT PRIMARY KEY,
        shipment_id TEXT,
        timestamp TEXT,
        type TEXT,
        is_exception INTEGER DEFAULT 0,
        lat REAL,
        lon REAL,
        location TEXT,
        data JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_levels (
        id TEXT PRIMARY KEY,
        origin_country TEXT,
        destination_country TEXT,
        mode TEXT,
        service_type TEXT,
        planned_hours INTEGER,
        data JSON NOT NULL
      );
      CREATE TABLE IF NOT EXISTS parties (
        id TEXT PRIMARY KEY,
        name TEXT,
        role TEXT,
        country TEXT,
        data JSON NOT NULL
      );

      -- Backward-compat views for old names (routes, events)
      CREATE VIEW IF NOT EXISTS routes AS SELECT * FROM lanes;
      CREATE VIEW IF NOT EXISTS events AS SELECT * FROM tracking_events;

      CREATE INDEX IF NOT EXISTS idx_shipments_status    ON shipments(status);
      CREATE INDEX IF NOT EXISTS idx_shipments_mode      ON shipments(mode);
      CREATE INDEX IF NOT EXISTS idx_shipments_origin    ON shipments(origin_country);
      CREATE INDEX IF NOT EXISTS idx_shipments_dest      ON shipments(destination_country);
      CREATE INDEX IF NOT EXISTS idx_carriers_country    ON carriers(country);
      CREATE INDEX IF NOT EXISTS idx_carriers_type       ON carriers(type);
      CREATE INDEX IF NOT EXISTS idx_rates_carrier       ON rates(carrier_id);
      CREATE INDEX IF NOT EXISTS idx_rates_lane          ON rates(origin_country, destination_country);
      CREATE INDEX IF NOT EXISTS idx_rates_valid_from    ON rates(valid_from);
      CREATE INDEX IF NOT EXISTS idx_documents_shipment  ON documents(shipment_id);
      CREATE INDEX IF NOT EXISTS idx_documents_type      ON documents(type);
      CREATE INDEX IF NOT EXISTS idx_tevents_shipment    ON tracking_events(shipment_id);
      CREATE INDEX IF NOT EXISTS idx_tevents_exception   ON tracking_events(is_exception);
      CREATE INDEX IF NOT EXISTS idx_svc_lane            ON service_levels(origin_country, destination_country, mode);
    `);
    this._enabledModels.add('shipments');
    this._enabledModels.add('carriers');
    this._enabledModels.add('lanes');
    this._enabledModels.add('rates');
    this._enabledModels.add('documents');
    this._enabledModels.add('tracking_events');
    this._enabledModels.add('service_levels');
    this._enabledModels.add('parties');
  }

  _initConnectorState() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT PRIMARY KEY,
        last_synced_at TEXT,
        last_count INTEGER DEFAULT 0,
        last_error TEXT,
        runs INTEGER DEFAULT 0
      );
    `);
  }

  _initExtensionModels() {
    const modelConfig = this.config?.models ?? {};
    const allSchemas  = {
      ...EXTENSION_SCHEMA,
      ...PARTY_SCHEMA,
      ...MARKETPLACE_SCHEMA,
      ...WORKFLOW_SCHEMA,
      ...ISSUE_SCHEMA,
    };

    // Map singular config key → plural table name
    const keyToTable = {
      asset: 'assets', driver: 'drivers', transport_order: 'transport_orders',
      facility: 'facilities', tender: 'tenders', tender_quote: 'tender_quotes',
      tender_award: 'tender_awards', dispatch: 'dispatches',
      leg: 'legs', customs_entry: 'customs_entries',
      managed_relationship: 'managed_relationships',
      issue: 'issues',
      load_listing: 'load_listings', asset_availability: 'asset_availability',
      freight_offer: 'freight_offers',
      review: 'reviews', market_signal: 'market_signals', claim: 'claims',
      // party and managed_relationships are always core now
    };

    for (const [key, table] of Object.entries(keyToTable)) {
      if (modelConfig[key] === true && allSchemas[table]) {
        try {
          this.db.exec(allSchemas[table]);
          this._enabledModels.add(table);
        } catch (e) {
          console.error(`[ATLAS] Failed to init extension model "${table}": ${e.message}`);
        }
      }
    }
  }

  // ─── Connector State (incremental sync) ──────────────────────────────────

  getConnectorState(connectorId) {
    return this.db.prepare(
      "SELECT last_synced_at, last_count, runs FROM connector_state WHERE connector_id = ?"
    ).get(connectorId) ?? { last_synced_at: null, last_count: 0, runs: 0 };
  }

  setConnectorState(connectorId, { last_synced_at, last_count, last_error }) {
    this.db.prepare(`
      INSERT INTO connector_state (connector_id, last_synced_at, last_count, last_error, runs)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(connector_id) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        last_count     = excluded.last_count,
        last_error     = excluded.last_error,
        runs           = runs + 1
    `).run(connectorId, last_synced_at ?? null, last_count ?? 0, last_error ?? null);
  }

  // ─── Available Models ─────────────────────────────────────────────────────

  getAvailableModels() {
    return Array.from(this._enabledModels).map(table => {
      let count = 0;
      try { count = this.db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n; } catch {}
      return { model: table, count };
    });
  }

  getModelSchema(modelName) {
    const resolved = MODEL_ALIASES[modelName] ?? modelName;
    const entry = Object.entries(MODEL_REGISTRY).find(([, v]) => v.table === resolved);
    if (!entry) return null;
    return { model: entry[0], table: resolved, enabled: this._enabledModels.has(resolved) };
  }

  // ─── Generic get_records ─────────────────────────────────────────────────

  getRecords(modelName, filters = {}, limit = 50) {
    const resolved = MODEL_ALIASES[modelName] ?? modelName;
    if (!this._enabledModels.has(resolved)) {
      return { error: `Model "${resolved}" is not enabled. Check config.yml models: section.` };
    }
    const conditions = [];
    const params = [];
    // Apply simple equality filters on known index columns
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null) {
        conditions.push(`json_extract(data, '$.${k}') = ?`);
        params.push(v);
      }
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    try {
      const rows = this.db.prepare(`SELECT data FROM ${resolved}${where} LIMIT ?`).all(...params, limit);
      return { model: resolved, records: rows.map(r => JSON.parse(r.data)), total: rows.length };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Generic upsert for extension models (connector-runner uses this)
  upsertRecord(modelName, record) {
    const resolved = MODEL_ALIASES[modelName] ?? modelName;
    if (!this._enabledModels.has(resolved)) return;
    if (!record.id) return;
    this.db.prepare(`
      INSERT INTO ${resolved} (id, data) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `).run(record.id, JSON.stringify(record));
  }

  // ─── SLA Violations ──────────────────────────────────────────────────────

  getSlaViolations({ since, mode, origin_country, destination_country, limit = 50 } = {}) {
    if (!this.db) return { violations: [], total: 0 };

    const conds = ["status NOT IN ('delivered','cancelled')"];
    const params = [];

    if (since) { conds.push("synced_at >= ?"); params.push(since); }
    if (mode)  { conds.push("mode = ?"); params.push(mode); }
    if (origin_country)      { conds.push("origin_country = ?");      params.push(origin_country.toUpperCase()); }
    if (destination_country) { conds.push("destination_country = ?"); params.push(destination_country.toUpperCase()); }

    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";

    // Get in-transit shipments
    const shipments = this.db
      .prepare(`SELECT id, data, origin_country, destination_country, mode FROM shipments${where} LIMIT ${limit * 5}`)
      .all(...params)
      .map(r => ({ ...JSON.parse(r.data), _origin: r.origin_country, _dest: r.destination_country, _mode: r.mode }));

    const violations = [];
    const now = Date.now();

    for (const s of shipments) {
      // Check against service level
      const sla = this.db.prepare(`
        SELECT planned_hours FROM service_levels
        WHERE origin_country = ? AND destination_country = ?
          AND (mode = ? OR mode IS NULL)
        ORDER BY CASE WHEN mode = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(s._origin, s._dest, s._mode, s._mode);

      if (!sla) continue;

      // Find first tracking event timestamp
      const firstEvent = this.db.prepare(`
        SELECT MIN(timestamp) as first_ts FROM tracking_events WHERE shipment_id = ?
      `).get(s.id);

      if (!firstEvent?.first_ts) continue;

      const startMs = new Date(firstEvent.first_ts).getTime();
      const elapsedHours = (now - startMs) / 3_600_000;

      if (elapsedHours > sla.planned_hours) {
        violations.push({
          shipment_id: s.id,
          shipment: s,
          planned_hours: sla.planned_hours,
          elapsed_hours: Math.round(elapsedHours * 10) / 10,
          delay_hours: Math.round((elapsedHours - sla.planned_hours) * 10) / 10,
          started_at: firstEvent.first_ts,
        });
      }
    }

    violations.sort((a, b) => b.delay_hours - a.delay_hours);
    return { violations: violations.slice(0, limit), total: violations.length };
  }

  // ─── Idle Assets ─────────────────────────────────────────────────────────

  getIdleAssets(idleMinutes = 30) {
    if (!this._enabledModels.has('assets')) return { assets: [], total: 0 };
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();
    const rows = this.db.prepare(`
      SELECT data FROM assets
      WHERE json_extract(data,'$.status') = 'moving'
        AND json_extract(data,'$.last_movement_at') < ?
    `).all(cutoff);
    const assets = rows.map(r => JSON.parse(r.data));
    return { assets, total: assets.length, idle_threshold_minutes: idleMinutes };
  }

  // ─── Anomalies ────────────────────────────────────────────────────────────

  getAnomalies({ since, limit = 50 } = {}) {
    if (!this.db) return { anomalies: [] };
    const conds = ["is_exception = 1"];
    const params = [];
    if (since) { conds.push("timestamp >= ?"); params.push(since); }
    const rows = this.db
      .prepare(`SELECT data FROM tracking_events WHERE ${conds.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit);
    return { anomalies: rows.map(r => JSON.parse(r.data)), total: rows.length, since: since ?? null };
  }

  // ─── Shipments ────────────────────────────────────────────────────────────

  getShipment(id) {
    const row = this.db?.prepare("SELECT data FROM shipments WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  upsertShipment(shipment) {
    if (!this.db) throw new Error("DB not initialized");
    const d = shipment;
    this.db.prepare(`
      INSERT INTO shipments (id, status, mode, origin_country, destination_country, managed_by_party_id, data, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, mode = excluded.mode,
        origin_country = excluded.origin_country,
        destination_country = excluded.destination_country,
        managed_by_party_id = excluded.managed_by_party_id,
        data = excluded.data, synced_at = datetime('now')
    `).run(
      d.id, d.status ?? null, d.mode ?? null,
      d.origin?.country?.toUpperCase() ?? d.origin_country?.toUpperCase() ?? null,
      d.destination?.country?.toUpperCase() ?? d.destination_country?.toUpperCase() ?? null,
      d.managed_by_party_id ?? null,
      JSON.stringify(d)
    );
    return d;
  }

  listShipments({ status, mode, start_date, end_date, limit = 20 } = {}) {
    if (!this.db) return { shipments: [], total: 0, last_synced_at: null };
    const conds = []; const params = [];
    if (status)     { conds.push("status = ?");           params.push(status); }
    if (mode)       { conds.push("mode = ?");             params.push(mode); }
    if (start_date) { conds.push("synced_at >= ?");       params.push(start_date); }
    if (end_date)   { conds.push("synced_at <= ?");       params.push(end_date); }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    const total = this.db.prepare(`SELECT COUNT(*) as n FROM shipments${where}`).get(...params).n;
    const last  = this.db.prepare("SELECT MAX(synced_at) as s FROM shipments").get().s;
    const rows  = this.db.prepare(`SELECT data FROM shipments${where} ORDER BY synced_at DESC LIMIT ?`).all(...params, limit);
    return { shipments: rows.map(r => JSON.parse(r.data)), total, last_synced_at: last ?? null };
  }

  getCarrierShipments(carrier_id, { limit = 20 } = {}) {
    const rows = this.db.prepare(
      `SELECT data FROM shipments WHERE json_extract(data,'$.carrier_id') = ? ORDER BY synced_at DESC LIMIT ?`
    ).all(carrier_id, limit);
    return { shipments: rows.map(r => JSON.parse(r.data)), total: rows.length, carrier_id };
  }

  // ─── Carriers ─────────────────────────────────────────────────────────────

  getCarrier(id) {
    const row = this.db?.prepare("SELECT data FROM carriers WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  upsertCarrier(carrier) {
    if (!this.db) throw new Error("DB not initialized");
    this.db.prepare(`
      INSERT INTO carriers (id, country, type, rating, data, synced_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        country = excluded.country, type = excluded.type,
        rating = excluded.rating, data = excluded.data,
        synced_at = datetime('now')
    `).run(
      carrier.id,
      carrier.country?.toUpperCase() ?? null,
      carrier.type ?? null,
      carrier.rating ?? null,
      JSON.stringify(carrier)
    );
    return carrier;
  }

  searchCarriers({ query, country, type, min_rating, limit = 20 } = {}) {
    const conds = []; const params = [];
    if (country)    { conds.push("country = ?"); params.push(country.toUpperCase()); }
    if (type)       { conds.push("type = ?");    params.push(type); }
    if (min_rating != null) { conds.push("rating >= ?"); params.push(min_rating); }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    let rows = this.db.prepare(`SELECT data FROM carriers${where} LIMIT ?`).all(...params, limit).map(r => JSON.parse(r.data));
    if (query) {
      const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      rows = rows.filter(c => tokens.some(t => JSON.stringify(c).toLowerCase().includes(t)));
    }
    const last = this.db.prepare("SELECT MAX(synced_at) as s FROM carriers").get().s;
    return { carriers: rows, total: rows.length, last_synced_at: last ?? null };
  }

  getAvailableCarriers() {
    return this.db.prepare(
      "SELECT id, json_extract(data,'$.name') as name, country, type, rating FROM carriers ORDER BY id"
    ).all();
  }

  // ─── Lanes (was Routes) ───────────────────────────────────────────────────

  getAvailableLanes() {
    return this.db.prepare(`
      SELECT DISTINCT origin_country as origin, destination_country as destination,
        mode, COUNT(*) as rate_count
      FROM rates GROUP BY origin_country, destination_country, mode
      ORDER BY origin_country, destination_country
    `).all();
  }

  // ─── Rates ────────────────────────────────────────────────────────────────

  getRateHistory({ carrier_id, origin, destination, mode, start_date, end_date, days = 90, limit = 50 } = {}) {
    const fromDate = start_date ?? (() => {
      const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().split("T")[0];
    })();
    const toDate = end_date ?? new Date().toISOString().split("T")[0];
    const conds = ["(valid_to IS NULL OR valid_to >= ?)"];
    const params = [fromDate];
    if (carrier_id)  { conds.push("carrier_id = ?");          params.push(carrier_id); }
    if (origin)      { conds.push("origin_country = ?");      params.push(origin.toUpperCase()); }
    if (destination) { conds.push("destination_country = ?"); params.push(destination.toUpperCase()); }
    if (mode)        { conds.push("mode = ?");                params.push(mode); }
    if (end_date)    { conds.push("valid_from <= ?");         params.push(toDate); }
    const rows = this.db
      .prepare(`SELECT data FROM rates WHERE ${conds.join(" AND ")} ORDER BY valid_from DESC LIMIT ?`)
      .all(...params, limit).map(r => JSON.parse(r.data));
    return { rates: rows, total: rows.length, period: { from: fromDate, to: toDate } };
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  listDocuments({ shipment_id, type, limit = 50 } = {}) {
    const conds = []; const params = [];
    if (shipment_id) { conds.push("shipment_id = ?"); params.push(shipment_id); }
    if (type)        { conds.push("type = ?");        params.push(type); }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    const total = this.db.prepare(`SELECT COUNT(*) as n FROM documents${where}`).get(...params).n;
    const last  = this.db.prepare("SELECT MAX(created_at) as s FROM documents").get().s;
    const rows  = this.db.prepare(`SELECT data FROM documents${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
    return { documents: rows.map(r => JSON.parse(r.data)), total, last_synced_at: last ?? null };
  }

  getUnsignedDocuments(shipmentId) {
    const rows = this.db.prepare(`
      SELECT data FROM documents
      WHERE shipment_id = ? AND signature_status IN ('draft','sent','partially_signed')
    `).all(shipmentId);
    return { documents: rows.map(r => JSON.parse(r.data)), shipment_id: shipmentId };
  }

  getAvailableDocumentTypes() {
    return this.db.prepare(
      "SELECT type, COUNT(*) as count FROM documents WHERE type IS NOT NULL GROUP BY type ORDER BY count DESC"
    ).all();
  }

  // ─── TrackingEvents (was Events) ─────────────────────────────────────────

  upsertTrackingEvent(event) {
    this.db.prepare(`
      INSERT INTO tracking_events (id, shipment_id, timestamp, type, is_exception, lat, lon, location, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shipment_id = excluded.shipment_id, timestamp = excluded.timestamp,
        type = excluded.type, is_exception = excluded.is_exception,
        lat = excluded.lat, lon = excluded.lon, location = excluded.location,
        data = excluded.data
    `).run(
      event.id, event.shipment_id ?? null, event.timestamp ?? null,
      event.type ?? null, event.is_exception ? 1 : 0,
      event.lat ?? null, event.lon ?? null, event.location ?? null,
      JSON.stringify(event)
    );
  }

  listEvents({ shipment_id, exceptions_only, type, limit = 50 } = {}) {
    const conds = []; const params = [];
    if (shipment_id)    { conds.push("shipment_id = ?"); params.push(shipment_id); }
    if (type)           { conds.push("type = ?");        params.push(type); }
    if (exceptions_only){ conds.push("is_exception = 1"); }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    const total = this.db.prepare(`SELECT COUNT(*) as n FROM tracking_events${where}`).get(...params).n;
    const rows  = this.db.prepare(`SELECT data FROM tracking_events${where} ORDER BY timestamp DESC LIMIT ?`).all(...params, limit);
    return { events: rows.map(r => JSON.parse(r.data)), total };
  }

  // ─── Sync status ─────────────────────────────────────────────────────────

  getSyncStatus() {
    const tables = [
      ['shipments',       'MAX(synced_at)'],
      ['carriers',        'MAX(synced_at)'],
      ['lanes',           'MAX(updated_at)'],
      ['rates',           'MAX(created_at)'],
      ['documents',       'MAX(created_at)'],
      ['tracking_events', 'MAX(timestamp)'],
      ['service_levels',  'NULL'],
      ['parties',         'NULL'],
    ];
    const status = {};
    for (const [t, expr] of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt, ${expr} as last_sync FROM ${t}`).get();
        status[t] = { count: row.cnt, last_synced_at: row.last_sync ?? null };
      } catch { status[t] = { count: 0, last_synced_at: null }; }
    }
    // Extension model counts
    for (const m of this._enabledModels) {
      if (status[m]) continue;
      try {
        status[m] = { count: this.db.prepare(`SELECT COUNT(*) as n FROM ${m}`).get().n, last_synced_at: null };
      } catch {}
    }
    return status;
  }

  // ─── Issues ──────────────────────────────────────────────────────────────

  getActiveIssues({ type, severity, requires_replanning, limit = 50 } = {}) {
    if (!this._enabledModels.has('issues')) return { issues: [], total: 0 };
    const conds = ["status NOT IN ('resolved','cancelled')"];
    const params = [];
    if (type)     { conds.push("type = ?");     params.push(type); }
    if (severity) { conds.push("severity = ?"); params.push(severity); }
    if (requires_replanning) { conds.push("requires_replanning = 1"); }
    const where = ` WHERE ${conds.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT data FROM issues${where} ORDER BY reported_at DESC LIMIT ?`)
      .all(...params, limit);
    return { issues: rows.map(r => JSON.parse(r.data)), total: rows.length };
  }

  // ─── Closure checklist ───────────────────────────────────────────────────

  getClosureChecklist(shipmentId) {
    const shipment = this.getShipment(shipmentId);
    if (!shipment) return { error: `Shipment not found: ${shipmentId}` };

    const checklist = [];
    const docs = this.listDocuments({ shipment_id: shipmentId }).documents;

    // Check POD exists
    const hasPod = docs.some(d => d.type === 'pod');
    checklist.push({ item: 'proof_of_delivery', status: hasPod ? 'done' : 'missing', required: true });

    // Check all docs signed
    const unsignedDocs = docs.filter(d => !['fully_signed','n_a'].includes(d.signature_status ?? 'draft'));
    checklist.push({
      item: 'documents_signed', required: true,
      status: unsignedDocs.length === 0 ? 'done' : 'pending',
      pending_docs: unsignedDocs.map(d => ({ id: d.id, type: d.type, signature_status: d.signature_status })),
    });

    // Check review exists
    if (this._enabledModels.has('reviews')) {
      const review = this.db.prepare(
        "SELECT id FROM reviews WHERE shipment_id = ? LIMIT 1"
      ).get(shipmentId);
      checklist.push({ item: 'review_submitted', status: review ? 'done' : 'missing', required: false });
    }

    // Delivery confirmed
    checklist.push({
      item: 'delivery_confirmed',
      status: shipment.status === 'delivered' ? 'done' : 'pending',
      current_status: shipment.status,
      required: true,
    });

    const allDone = checklist.filter(c => c.required).every(c => c.status === 'done');
    return { shipment_id: shipmentId, ready_to_close: allDone, checklist };
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  query(question, { mode, limit = 10 } = {}) {
    if (!this.db) return { results: [], context: "Database not initialized." };
    const tokens = question.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (!tokens.length) return { results: [], context: "No query terms provided." };
    const results = [];
    for (const [table, label] of [["shipments","shipment"],["carriers","carrier"],["lanes","lane"]]) {
      try {
        const rows = this.db.prepare(`SELECT data FROM ${table} LIMIT 500`).all().map(r => JSON.parse(r.data));
        for (const row of rows) {
          const score = tokens.filter(t => JSON.stringify(row).toLowerCase().includes(t)).length;
          if (score > 0) results.push({ type: label, score, data: row });
        }
      } catch {}
    }
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    return {
      results: top,
      context: top.length
        ? top.map(r => `[${r.type}] ${JSON.stringify(r.data)}`).join("\n\n")
        : "No matching records found.",
    };
  }

  // ─── Data Retention / Pruning (ATLAS-08) ─────────────────────────────────
  // Removes delivered/cancelled shipments + their events older than N days.
  // Called automatically on startup and can be triggered via POST /api/admin/prune.

  pruneOldRecords(retentionDays) {
    const days = retentionDays ?? this.config?.storage?.retention_days ?? 90;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const deleted = {};

    try {
      // Find old closed shipment ids
      const oldIds = this.db
        .prepare(`SELECT id FROM shipments WHERE status IN ('delivered','cancelled') AND synced_at < ?`)
        .all(cutoff).map(r => r.id);

      if (oldIds.length) {
        const placeholders = oldIds.map(() => '?').join(',');
        const evDel = this.db.prepare(`DELETE FROM tracking_events WHERE shipment_id IN (${placeholders})`).run(...oldIds);
        const docDel = this.db.prepare(`DELETE FROM documents WHERE shipment_id IN (${placeholders})`).run(...oldIds);
        const shpDel = this.db.prepare(`DELETE FROM shipments WHERE id IN (${placeholders})`).run(...oldIds);
        deleted.shipments = shpDel.changes;
        deleted.tracking_events = evDel.changes;
        deleted.documents = docDel.changes;
      }

      // Prune old rates (expired > retention cutoff)
      const rateDel = this.db
        .prepare(`DELETE FROM rates WHERE valid_to IS NOT NULL AND valid_to < ?`)
        .run(cutoff);
      deleted.rates = rateDel.changes;

      console.error(`[ATLAS] Pruned: ${JSON.stringify(deleted)} (cutoff: ${cutoff})`);
    } catch (e) {
      console.error(`[ATLAS] Prune error: ${e.message}`);
    }
    return deleted;
  }

  // ─── Config Reload (ATLAS-09) ────────────────────────────────────────────
  // Reload config.yml without restarting the server.
  // Re-initializes extension models if models: section changed.

  reloadConfig(configPath) {
    try {
      this.loadConfig(configPath ?? process.env.ATLAS_CONFIG);
      this._initExtensionModels(); // create any newly enabled tables
      console.error('[ATLAS] Config reloaded');
      return { ok: true, message: 'Config reloaded', timestamp: new Date().toISOString() };
    } catch (e) {
      console.error(`[ATLAS] Config reload error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

}

export default Atlas;
