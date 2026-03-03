/**
 * ATLAS Connector Runner
 * Reads connectors[] from config.yml, polls data sources on schedule,
 * applies field mapping, and upserts into SQLite via Atlas class.
 *
 * Currently supported connector types:
 *   - rest_api: polls an HTTP endpoint on interval
 *
 * Planned (config accepted, not yet executed):
 *   - filesystem: watches/reads local files (csv, xlsx, json)
 *   - imap: reads emails from IMAP folders
 */

import { applyMapping, validateMapped, resolveEnv } from './mapper.js';

export class ConnectorRunner {
  constructor(atlas, config) {
    this.atlas = atlas;
    this.config = config;
    this.connectors = (config?.connectors ?? []).filter(c => c.enabled !== false);
    this.timers = [];
    this.stats = {}; // id → { runs, errors, last_run, last_error }
  }

  /** Start all enabled connectors */
  start() {
    if (!this.connectors.length) {
      console.error('[ATLAS] No connectors configured — data must be loaded manually');
      return;
    }
    for (const connector of this.connectors) {
      this._startConnector(connector);
    }
    console.error(`[ATLAS] ${this.connectors.length} connector(s) started`);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Get runtime stats for all connectors (used by /api/connectors) */
  getStats() {
    return this.connectors.map(c => ({
      id: c.id,
      name: c.name ?? c.id,
      type: c.type,
      entity: c.entity ?? c.sync?.entity ?? 'shipments',
      interval_minutes: c.sync?.interval_minutes ?? 30,
      enabled: c.enabled !== false,
      ...(this.stats[c.id] ?? { runs: 0, errors: 0, last_run: null, last_error: null }),
    }));
  }

  _startConnector(connector) {
    const intervalMs = (connector.sync?.interval_minutes ?? 30) * 60 * 1000;
    this.stats[connector.id] = { runs: 0, errors: 0, last_run: null, last_error: null };

    // Run once immediately, then on interval
    this._runConnector(connector);
    const timer = setInterval(() => this._runConnector(connector), intervalMs);
    this.timers.push(timer);
  }

  async _runConnector(connector) {
    const start = Date.now();
    console.error(`[ATLAS] Connector "${connector.id}" sync started`);
    try {
      let count = 0;
      if (connector.type === 'rest_api') {
        count = await this._syncRestApi(connector);
      } else if (connector.type === 'filesystem') {
        console.error(`[ATLAS] Connector type "filesystem" — not yet implemented`);
      } else if (connector.type === 'imap') {
        console.error(`[ATLAS] Connector type "imap" — not yet implemented`);
      } else {
        console.error(`[ATLAS] Unknown connector type: ${connector.type}`);
      }
      const ms = Date.now() - start;
      this.stats[connector.id].runs++;
      this.stats[connector.id].last_run = new Date().toISOString();
      console.error(`[ATLAS] Connector "${connector.id}" synced ${count} records in ${ms}ms`);
    } catch (err) {
      this.stats[connector.id].errors++;
      this.stats[connector.id].last_error = err.message;
      console.error(`[ATLAS] Connector "${connector.id}" error: ${err.message}`);
    }
  }

  async _syncRestApi(connector) {
    const endpoint = resolveEnv(connector.endpoint);
    if (!endpoint) throw new Error('Missing endpoint');

    const headers = { 'Content-Type': 'application/json' };
    const auth = connector.auth ?? {};

    if (auth.type === 'bearer') {
      headers['Authorization'] = `Bearer ${resolveEnv(auth.token)}`;
    } else if (auth.type === 'basic') {
      const creds = Buffer.from(`${resolveEnv(auth.username)}:${resolveEnv(auth.password)}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
    } else if (auth.type === 'api_key') {
      const headerName = auth.header ?? 'X-API-Key';
      headers[headerName] = resolveEnv(auth.key);
    }

    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const body = await response.json();

    // Support various envelope shapes: [], {data:[]}, {items:[]}, {results:[]}, {shipments:[]}
    const entity = connector.entity ?? connector.sync?.entity ?? 'shipments';
    let rows = Array.isArray(body) ? body : (
      body.data ?? body.items ?? body.results ?? body[entity] ?? body.records ?? []
    );

    if (!Array.isArray(rows)) throw new Error('Response is not an array and no known envelope found');

    const mapping = connector.mapping ?? null;
    let synced = 0;

    for (const raw of rows) {
      const record = mapping ? applyMapping(raw, mapping) : raw;
      const { valid, errors } = validateMapped(entity, record);

      if (!valid) {
        console.error(`[ATLAS] Connector "${connector.id}" skipped record: ${errors.join(', ')}`);
        continue;
      }

      try {
        if (entity === 'shipments')  this.atlas.upsertShipment(record);
        else if (entity === 'carriers') this.atlas.upsertCarrier(record);
        else if (entity === 'rates')    this._upsertRate(record);
        else if (entity === 'events')   this._upsertEvent(record);
        synced++;
      } catch (e) {
        console.error(`[ATLAS] Upsert error for ${entity} id=${record.id}: ${e.message}`);
      }
    }

    return synced;
  }

  _upsertRate(rate) {
    if (!this.atlas.db) return;
    this.atlas.db.prepare(`
      INSERT INTO rates (id, carrier_id, origin_country, destination_country, mode, valid_from, valid_to, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        carrier_id = excluded.carrier_id,
        origin_country = excluded.origin_country,
        destination_country = excluded.destination_country,
        mode = excluded.mode,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        data = excluded.data
    `).run(
      rate.id,
      rate.carrier_id ?? null,
      rate.origin_country ?? rate.origin?.country?.toUpperCase() ?? null,
      rate.destination_country ?? rate.destination?.country?.toUpperCase() ?? null,
      rate.mode ?? null,
      rate.valid_from ?? null,
      rate.valid_to ?? null,
      JSON.stringify(rate)
    );
  }

  _upsertEvent(event) {
    if (!this.atlas.db) return;
    this.atlas.db.prepare(`
      INSERT INTO events (id, shipment_id, timestamp, type, is_exception, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shipment_id = excluded.shipment_id,
        timestamp = excluded.timestamp,
        type = excluded.type,
        is_exception = excluded.is_exception,
        data = excluded.data
    `).run(
      event.id,
      event.shipment_id ?? null,
      event.timestamp ?? null,
      event.type ?? null,
      event.is_exception ? 1 : 0,
      JSON.stringify(event)
    );
  }
}
