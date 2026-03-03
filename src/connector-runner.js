/**
 * ATLAS Connector Runner v1.0
 * Reads connectors[] from config.yml, polls data sources on schedule,
 * applies field mapping, and upserts into SQLite via Atlas class.
 *
 * Supported types: rest_api, filesystem (CSV/JSON)
 * Planned: imap, xlsx
 *
 * Incremental sync: each connector stores last_synced_at in connector_state table.
 * On next run, passes it as query param (since_param in config) to fetch only new records.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { applyMapping, validateMapped, resolveEnv } from './mapper.js';

export class ConnectorRunner {
  constructor(atlas, config) {
    this.atlas  = atlas;
    this.config = config;
    this.connectors = (config?.connectors ?? []).filter(c => c.enabled !== false);
    this.timers = [];
  }

  start() {
    if (!this.connectors.length) {
      console.error('[ATLAS] No connectors configured — load data manually via seed or API');
      return;
    }
    for (const c of this.connectors) this._startConnector(c);
    console.error(`[ATLAS] ${this.connectors.length} connector(s) started`);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  getStats() {
    return this.connectors.map(c => {
      const state = this.atlas.getConnectorState(c.id);
      return {
        id: c.id, name: c.name ?? c.id, type: c.type,
        entity: c.entity ?? 'shipments',
        interval_minutes: c.sync?.interval_minutes ?? 30,
        enabled: true,
        last_run: state.last_synced_at,
        runs: state.runs,
      };
    });
  }

  _startConnector(connector) {
    const intervalMs = (connector.sync?.interval_minutes ?? 30) * 60_000;
    this._runConnector(connector);
    this.timers.push(setInterval(() => this._runConnector(connector), intervalMs));
  }

  async _runConnector(connector, attempt = 1) {
    const maxAttempts = connector.sync?.max_retries ?? 3;
    const start = Date.now();
    console.error(`[ATLAS] Connector "${connector.id}" sync started (attempt ${attempt}/${maxAttempts})`);
    let count = 0;
    let error = null;
    try {
      if (connector.type === 'rest_api') {
        count = await this._syncRestApi(connector);
      } else if (connector.type === 'filesystem') {
        count = await this._syncFilesystem(connector);
      } else {
        console.error(`[ATLAS] Connector type "${connector.type}" not yet implemented`);
      }
      const ms = Date.now() - start;
      console.error(`[ATLAS] Connector "${connector.id}": synced ${count} records in ${ms}ms`);
    } catch (e) {
      error = e.message;
      console.error(`[ATLAS] Connector "${connector.id}" error (attempt ${attempt}): ${e.message}`);

      // Retry with exponential backoff
      if (attempt < maxAttempts) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 30_000); // 2s, 4s, 8s... max 30s
        console.error(`[ATLAS] Connector "${connector.id}" retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
        return this._runConnector(connector, attempt + 1);
      }
    }
    // Write state after final attempt
    this.atlas.setConnectorState(connector.id, {
      last_synced_at: new Date().toISOString(),
      last_count: count,
      last_error: error,
    });

    // Alert if connector has been failing for max_gap_minutes
    const maxGap = connector.sync?.max_gap_minutes;
    if (maxGap && error) {
      const state = this.atlas.getConnectorState(connector.id);
      // Future: emit webhook/notification here
      console.error(`[ATLAS] ⚠️  Connector "${connector.id}" DEGRADED after ${attempt} attempts`);
    }
  }

  async _syncRestApi(connector) {
    const entity    = connector.entity ?? 'shipments';
    const sinceParam = connector.sync?.since_param ?? null;

    // Build URL — inject since_param for incremental sync
    let endpoint = resolveEnv(connector.endpoint);
    if (!endpoint) throw new Error('Missing endpoint');

    if (sinceParam) {
      const state = this.atlas.getConnectorState(connector.id);
      if (state.last_synced_at) {
        const sep = endpoint.includes('?') ? '&' : '?';
        endpoint += `${sep}${sinceParam}=${encodeURIComponent(state.last_synced_at)}`;
        console.error(`[ATLAS] Connector "${connector.id}": incremental since ${state.last_synced_at}`);
      }
    }

    const headers = { 'Content-Type': 'application/json' };
    const auth = connector.auth ?? {};

    if (auth.type === 'bearer') {
      headers['Authorization'] = `Bearer ${resolveEnv(auth.token)}`;
    } else if (auth.type === 'basic') {
      const creds = Buffer.from(`${resolveEnv(auth.username)}:${resolveEnv(auth.password)}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
    } else if (auth.type === 'api_key') {
      headers[auth.header ?? 'X-API-Key'] = resolveEnv(auth.key);
    }

    const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const body = await res.json();

    // Normalize response to array
    let rows = Array.isArray(body) ? body :
      (body.data ?? body.items ?? body.results ?? body[entity] ?? body.records ?? []);
    if (!Array.isArray(rows)) throw new Error('Response is not an array and no known envelope found');

    return this._upsertRows(connector, entity, rows);
  }

  async _syncFilesystem(connector) {
    const dir    = resolveEnv(connector.path ?? connector.workspace ?? './workspace');
    const entity = connector.entity ?? 'documents';
    if (!existsSync(dir)) {
      console.error(`[ATLAS] Filesystem connector "${connector.id}": path not found: ${dir}`);
      return 0;
    }

    const formats  = connector.formats ?? ['csv', 'json'];
    const files    = readdirSync(dir).filter(f => formats.includes(extname(f).slice(1).toLowerCase()));
    let total      = 0;

    for (const file of files) {
      const filepath = join(dir, file);
      try {
        const rows = this._parseFile(filepath);
        if (rows.length) total += this._upsertRows(connector, entity, rows);
      } catch (e) {
        console.error(`[ATLAS] Filesystem connector "${connector.id}" failed to parse ${file}: ${e.message}`);
      }
    }
    return total;
  }

  _parseFile(filepath) {
    const ext = extname(filepath).slice(1).toLowerCase();

    if (ext === 'json') {
      const data = JSON.parse(readFileSync(filepath, 'utf8'));
      return Array.isArray(data) ? data : [data];
    }

    if (ext === 'csv') {
      const lines   = readFileSync(filepath, 'utf8').trim().split('\n');
      if (lines.length < 2) return [];
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      return lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
      });
    }

    if (ext === 'xlsx' || ext === 'xls') {
      try {
        const XLSX = (await import('xlsx')).default;
        const wb   = XLSX.readFile(filepath);
        const ws   = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(ws, { defval: '' });
      } catch (e) {
        console.error(`[ATLAS] XLSX parse error for ${filepath}: ${e.message}`);
        return [];
      }
    }

    return [];
  }

  _upsertRows(connector, entity, rows) {
    const mapping   = connector.mapping ?? null;
    const composite = connector.composite ?? null; // {entity: mapping} for multiple entities
    let synced      = 0;

    for (const raw of rows) {
      try {
        // Composite mapping: one raw row → multiple entities
        // config: composite: { shipments: {...mapping}, tracking_events: {array_field: "$.scans", mapping: {...}} }
        if (composite) {
          for (const [targetEntity, spec] of Object.entries(composite)) {
            if (spec.array_field) {
              // Extract nested array (e.g. scans from shipment response)
              const getPath = (obj, path) => path.replace(/^\$\./, '').split('.').reduce((o, k) => o?.[k], obj);
              const nested = getPath(raw, spec.array_field);
              if (Array.isArray(nested)) {
                for (const item of nested) {
                  const record = spec.mapping ? applyMapping(item, spec.mapping) : item;
                  const { valid } = validateMapped(targetEntity, record);
                  if (valid) { this._upsert(targetEntity, record); synced++; }
                }
              }
            } else {
              const record = spec.mapping ? applyMapping(raw, spec.mapping) : raw;
              const { valid } = validateMapped(targetEntity, record);
              if (valid) { this._upsert(targetEntity, record); synced++; }
            }
          }
          continue; // skip single-entity path below
        }

        // Single entity mapping (original behavior)
        const record = mapping ? applyMapping(raw, mapping) : raw;
        const { valid, errors } = validateMapped(entity, record);
        if (!valid) {
          console.error(`[ATLAS] Connector "${connector.id}" skip: ${errors.join(', ')}`);
          continue;
        }
        this._upsert(entity, record);
        synced++;
      } catch (e) {
        console.error(`[ATLAS] Connector "${connector.id}" upsert error: ${e.message}`);
      }
    }
    return synced;
  }

  _upsert(entity, record) {
    const a = this.atlas;
    if      (entity === 'shipments')       a.upsertShipment(record);
    else if (entity === 'carriers')        a.upsertCarrier(record);
    else if (entity === 'tracking_events' || entity === 'events') a.upsertTrackingEvent(record);
    else                                   a.upsertRecord(entity, record);
  }
}
