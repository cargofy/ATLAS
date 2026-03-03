/**
 * ATLAS Core
 * Central class managing config, SQLite storage, and query logic
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class Atlas {
  constructor() {
    this.config = null;
    this.db = null;
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  loadConfig(configPath) {
    const resolved = configPath ?? join(__dirname, "..", "config.yml");
    const fallback = join(__dirname, "..", "config.example.yml");
    const target = existsSync(resolved) ? resolved : fallback;
    if (!existsSync(target)) throw new Error(`Config not found: ${resolved}`);
    this.config = YAML.parse(readFileSync(target, "utf8"));
    return this.config;
  }

  // ─── SQLite ───────────────────────────────────────────────────────────────

  initDb(dbPath) {
    const path = dbPath ?? (this.config?.storage?.path ?? "/data/atlas/atlas.db");
    this.db = new Database(path);
    this._initSchema();
    return this.db;
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shipments (
        id TEXT PRIMARY KEY,
        status TEXT,
        mode TEXT,
        data JSON NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        synced_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS carriers (
        id TEXT PRIMARY KEY,
        country TEXT,
        type TEXT,
        data JSON NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        synced_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        data JSON NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS rates (
        id TEXT PRIMARY KEY,
        carrier_id TEXT,
        origin_country TEXT,
        destination_country TEXT,
        mode TEXT,
        valid_from TEXT,
        valid_to TEXT,
        data JSON NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        shipment_id TEXT,
        type TEXT,
        data JSON NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        shipment_id TEXT,
        timestamp TEXT,
        type TEXT,
        is_exception INTEGER DEFAULT 0,
        data JSON NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
      CREATE INDEX IF NOT EXISTS idx_shipments_mode ON shipments(mode);
      CREATE INDEX IF NOT EXISTS idx_carriers_country ON carriers(country);
      CREATE INDEX IF NOT EXISTS idx_carriers_type ON carriers(type);
      CREATE INDEX IF NOT EXISTS idx_rates_carrier ON rates(carrier_id);
      CREATE INDEX IF NOT EXISTS idx_rates_lane ON rates(origin_country, destination_country);
      CREATE INDEX IF NOT EXISTS idx_rates_valid_from ON rates(valid_from);
      CREATE INDEX IF NOT EXISTS idx_documents_shipment ON documents(shipment_id);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
      CREATE INDEX IF NOT EXISTS idx_events_shipment ON events(shipment_id);
    `);
  }

  // ─── Sync metadata ────────────────────────────────────────────────────────

  getSyncStatus() {
    if (!this.db) return {};
    // Each table has different timestamp columns
    const tsMap = {
      shipments: "MAX(COALESCE(synced_at, created_at))",
      carriers:  "MAX(COALESCE(synced_at, updated_at))",
      routes:    "MAX(updated_at)",
      rates:     "MAX(created_at)",
      documents: "MAX(created_at)",
      events:    "MAX(timestamp)",
    };
    const status = {};
    for (const [t, expr] of Object.entries(tsMap)) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as cnt, ${expr} as last_sync FROM ${t}`).get();
        status[t] = { count: row.cnt, last_synced_at: row.last_sync ?? null };
      } catch {
        try {
          status[t] = { count: this.db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get().cnt, last_synced_at: null };
        } catch { status[t] = { count: 0, last_synced_at: null }; }
      }
    }
    return status;
  }

  // ─── Shipments ────────────────────────────────────────────────────────────

  getShipment(id) {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT data FROM shipments WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  upsertShipment(shipment) {
    if (!this.db) throw new Error("DB not initialized");
    this.db.prepare(`
      INSERT INTO shipments (id, status, mode, data, synced_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        mode = excluded.mode,
        data = excluded.data,
        synced_at = datetime('now')
    `).run(
      shipment.id,
      shipment.status ?? null,
      shipment.mode ?? null,
      JSON.stringify(shipment)
    );
    return shipment;
  }

  listShipments({ status, mode, start_date, end_date, limit = 20 } = {}) {
    if (!this.db) return { shipments: [], total: 0, last_synced_at: null };
    const conditions = [];
    const params = [];

    if (status) { conditions.push("status = ?"); params.push(status); }
    if (mode)   { conditions.push("mode = ?");   params.push(mode); }
    if (start_date) { conditions.push("created_at >= ?"); params.push(start_date); }
    if (end_date)   { conditions.push("created_at <= ?"); params.push(end_date); }

    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const total = this.db.prepare(`SELECT COUNT(*) as n FROM shipments${where}`).get(...params).n;
    const last = this.db.prepare(`SELECT MAX(COALESCE(synced_at, created_at)) as s FROM shipments`).get().s;

    params.push(limit);
    const rows = this.db.prepare(`SELECT data FROM shipments${where} ORDER BY created_at DESC LIMIT ?`).all(...params);

    return {
      shipments: rows.map(r => JSON.parse(r.data)),
      total,
      last_synced_at: last ?? null,
    };
  }

  // ─── Carriers ─────────────────────────────────────────────────────────────

  getCarrier(id) {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT data FROM carriers WHERE id = ?").get(id);
    return row ? JSON.parse(row.data) : null;
  }

  upsertCarrier(carrier) {
    if (!this.db) throw new Error("DB not initialized");
    this.db.prepare(`
      INSERT INTO carriers (id, country, type, data, synced_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        country = excluded.country,
        type = excluded.type,
        data = excluded.data,
        synced_at = datetime('now')
    `).run(
      carrier.id,
      carrier.country ? carrier.country.toUpperCase() : null,
      carrier.type ?? null,
      JSON.stringify(carrier)
    );
    return carrier;
  }

  searchCarriers({ query, country, type, min_rating, limit = 20 } = {}) {
    if (!this.db) return { carriers: [], total: 0, last_synced_at: null };
    const conditions = [];
    const params = [];

    if (country) { conditions.push("country = ?"); params.push(country.toUpperCase()); }
    if (type)    { conditions.push("type = ?");    params.push(type); }
    if (min_rating != null) {
      conditions.push("json_extract(data,'$.rating') >= ?");
      params.push(min_rating);
    }

    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    let rows = this.db.prepare(`SELECT data FROM carriers${where} LIMIT ?`).all(...params, limit).map(r => JSON.parse(r.data));

    // Optional free-text post-filter
    if (query) {
      const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      rows = rows.filter(c => {
        const text = JSON.stringify(c).toLowerCase();
        return tokens.some(t => text.includes(t));
      });
    }

    const last = this.db.prepare("SELECT MAX(COALESCE(synced_at, updated_at)) as s FROM carriers").get().s;
    return { carriers: rows, total: rows.length, last_synced_at: last ?? null };
  }

  getAvailableCarriers() {
    if (!this.db) return [];
    return this.db
      .prepare("SELECT id, json_extract(data,'$.name') as name, country, type FROM carriers ORDER BY id")
      .all();
  }

  // ─── Routes ───────────────────────────────────────────────────────────────

  getRoute(origin, destination, mode) {
    if (!this.db) return null;
    let sql = `
      SELECT data FROM routes
      WHERE json_extract(data,'$.origin.country') = ?
        AND json_extract(data,'$.destination.country') = ?
    `;
    const params = [origin.toUpperCase(), destination.toUpperCase()];
    if (mode) { sql += " AND json_extract(data,'$.mode') = ?"; params.push(mode); }
    sql += " LIMIT 1";
    const row = this.db.prepare(sql).get(...params);
    return row ? JSON.parse(row.data) : null;
  }

  getAvailableLanes() {
    if (!this.db) return [];
    return this.db
      .prepare(`
        SELECT DISTINCT origin_country as origin, destination_country as destination, mode,
          COUNT(*) as rate_count
        FROM rates
        GROUP BY origin_country, destination_country, mode
        ORDER BY origin_country, destination_country
      `)
      .all();
  }

  // ─── Rates ────────────────────────────────────────────────────────────────

  getRateHistory({ carrier_id, origin, destination, mode, start_date, end_date, days = 90, limit = 50 } = {}) {
    if (!this.db) return { rates: [], total: 0, lane: null };

    // Determine date range
    let fromDate = start_date;
    if (!fromDate) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      fromDate = cutoff.toISOString().split("T")[0];
    }
    const toDate = end_date ?? new Date().toISOString().split("T")[0];

    const conditions = ["(valid_to IS NULL OR valid_to >= ?)"];
    const params = [fromDate];

    if (carrier_id)   { conditions.push("carrier_id = ?");           params.push(carrier_id); }
    if (origin)       { conditions.push("origin_country = ?");       params.push(origin.toUpperCase()); }
    if (destination)  { conditions.push("destination_country = ?");  params.push(destination.toUpperCase()); }
    if (mode)         { conditions.push("mode = ?");                  params.push(mode); }
    if (end_date)     { conditions.push("valid_from <= ?");           params.push(toDate); }

    const where = " WHERE " + conditions.join(" AND ");
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT data FROM rates${where} ORDER BY valid_from DESC LIMIT ?`)
      .all(...params)
      .map(r => JSON.parse(r.data));

    return {
      rates: rows,
      total: rows.length,
      lane: origin && destination ? { origin: origin.toUpperCase(), destination: destination.toUpperCase(), mode: mode ?? null } : null,
      period: { from: fromDate, to: toDate },
    };
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  listDocuments({ shipment_id, type, limit = 50 } = {}) {
    if (!this.db) return { documents: [], total: 0, last_synced_at: null };
    const conditions = [];
    const params = [];

    if (shipment_id) { conditions.push("shipment_id = ?"); params.push(shipment_id); }
    if (type)        { conditions.push("type = ?");        params.push(type); }

    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const total = this.db.prepare(`SELECT COUNT(*) as n FROM documents${where}`).get(...params).n;
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT data FROM documents${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params);

    const last = this.db.prepare("SELECT MAX(created_at) as s FROM documents").get().s;
    return { documents: rows.map(r => JSON.parse(r.data)), total, last_synced_at: last ?? null };
  }

  getAvailableDocumentTypes() {
    if (!this.db) return [];
    return this.db
      .prepare("SELECT DISTINCT type, COUNT(*) as count FROM documents WHERE type IS NOT NULL GROUP BY type ORDER BY count DESC")
      .all();
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  listEvents({ shipment_id, type, exceptions_only, limit = 50 } = {}) {
    if (!this.db) return { events: [], total: 0 };
    const conditions = [];
    const params = [];

    if (shipment_id)     { conditions.push("shipment_id = ?");  params.push(shipment_id); }
    if (type)            { conditions.push("type = ?");          params.push(type); }
    if (exceptions_only) { conditions.push("is_exception = 1"); }

    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const total = this.db.prepare(`SELECT COUNT(*) as n FROM events${where}`).get(...params).n;
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT data FROM events${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params);

    return { events: rows.map(r => JSON.parse(r.data)), total };
  }

  // ─── Relationship: carrier shipments ─────────────────────────────────────

  getCarrierShipments(carrier_id, { limit = 20 } = {}) {
    if (!this.db) return { shipments: [], total: 0, carrier_id };
    const rows = this.db
      .prepare(`SELECT data FROM shipments WHERE json_extract(data,'$.carrier_id') = ? ORDER BY created_at DESC LIMIT ?`)
      .all(carrier_id, limit);
    return { shipments: rows.map(r => JSON.parse(r.data)), total: rows.length, carrier_id };
  }

  // ─── Query (keyword search) ───────────────────────────────────────────────

  query(question, { mode, limit = 10 } = {}) {
    if (!this.db) return { results: [], context: "Database not initialized." };

    const tokens = question.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (!tokens.length) return { results: [], context: "No query terms provided." };

    const results = [];

    for (const [tableName, label] of [["shipments","shipment"],["carriers","carrier"]]) {
      const rows = this.db.prepare(`SELECT data FROM ${tableName} LIMIT 500`).all().map(r => JSON.parse(r.data));
      for (const row of rows) {
        const text = JSON.stringify(row).toLowerCase();
        const score = tokens.filter(t => text.includes(t)).length;
        if (score > 0) results.push({ type: label, score, data: row });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    const context = top.length
      ? top.map(r => `[${r.type}] ${JSON.stringify(r.data)}`).join("\n\n")
      : "No matching records found.";

    return { results: top, context };
  }
}

export default Atlas;
