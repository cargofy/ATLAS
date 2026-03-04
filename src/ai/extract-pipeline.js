/**
 * ATLAS AI Extract Pipeline
 * End-to-end orchestration: file → text extraction → LLM → validation → DB upsert.
 * Used by both the ai_extract connector type and the POST /api/import/ai endpoint.
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { FilesystemConnector } from '../connectors/filesystem.js';
import { extract } from './extract.js';

// Reusable FilesystemConnector instance for text extraction
let _fsConnector = null;

function getFsConnector() {
  if (!_fsConnector) _fsConnector = new FilesystemConnector();
  return _fsConnector;
}

/**
 * Compute SHA-256 hash of file contents for deduplication.
 */
function fileHash(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Walk a directory recursively, returning all file paths.
 */
function walkDir(dir) {
  const results = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...walkDir(full));
      } else {
        results.push(full);
      }
    } catch { /* skip unreadable */ }
  }
  return results;
}

/**
 * Process a single file through the AI extraction pipeline.
 *
 * @param {string} filePath - Path to the file
 * @param {object} opts
 * @param {object} opts.atlas - Atlas instance (for DB operations)
 * @param {object} opts.aiConfig - AI configuration from config.yml (legacy)
 * @param {import('./model-registry.js').ModelRegistry} opts.registry - Model registry (new multi-model)
 * @param {Function} opts.upsert - Upsert function: (entity, record) => void
 * @param {boolean} opts.force - Skip dedup check
 * @returns {Promise<{ok, filename, hash, entities, records, usage, error?}>}
 */
export async function processFile(filePath, opts = {}) {
  const { atlas, aiConfig, registry, upsert, force } = opts;
  const filename = filePath.split('/').pop();

  // Compute hash for dedup
  let hash;
  try {
    hash = fileHash(filePath);
  } catch (e) {
    return { ok: false, filename, hash: null, entities: 0, records: 0, usage: null, error: `Cannot read file: ${e.message}` };
  }

  // Dedup check
  if (!force && atlas?.db) {
    try {
      const existing = atlas.db.prepare('SELECT file_hash FROM ai_extract_log WHERE file_hash = ?').get(hash);
      if (existing) {
        return { ok: true, filename, hash, entities: 0, records: 0, usage: null, skipped: true, reason: 'Already processed (duplicate)' };
      }
    } catch { /* table might not exist yet — continue */ }
  }

  // Extract text from file
  const fsConn = getFsConnector();
  const extracted = await fsConn._extractFile(filePath);
  if (!extracted || !extracted.text) {
    const error = 'Could not extract text from file';
    logExtraction(atlas, hash, filename, 0, 0, null, error);
    return { ok: false, filename, hash, entities: 0, records: 0, usage: null, error };
  }

  // Run AI extraction — prefer registry, fall back to legacy aiConfig
  const result = await extract(extracted.text, { filename }, { registry, config: aiConfig });

  if (result.error) {
    logExtraction(atlas, hash, filename, 0, 0, result.usage, result.error);
    return { ok: false, filename, hash, entities: 0, records: 0, usage: result.usage, error: result.error };
  }

  // Upsert extracted records into DB
  let totalRecords = 0;
  for (const group of result.entities) {
    for (const record of group.records) {
      try {
        if (upsert) {
          upsert(group.entity_type, record);
        }
        totalRecords++;
      } catch (e) {
        console.error(`[ATLAS AI] Upsert error for ${group.entity_type}: ${e.message}`);
      }
    }
  }

  // Log extraction result
  logExtraction(atlas, hash, filename, result.entities.length, totalRecords, result.usage, null);

  return {
    ok: true,
    filename,
    hash,
    entities: result.entities.length,
    records: totalRecords,
    usage: result.usage,
    extracted: result.entities.map(e => ({ entity_type: e.entity_type, count: e.records.length })),
  };
}

/**
 * Process all files in a directory through the AI extraction pipeline.
 */
export async function processDirectory(dirPath, opts = {}) {
  if (!existsSync(dirPath)) {
    return { ok: false, error: `Directory not found: ${dirPath}`, results: [] };
  }

  const files = walkDir(dirPath);
  const results = [];
  let totalRecords = 0;

  for (const filePath of files) {
    try {
      const result = await processFile(filePath, opts);
      results.push(result);
      if (result.ok) totalRecords += result.records;
    } catch (e) {
      results.push({
        ok: false,
        filename: filePath.split('/').pop(),
        error: e.message,
      });
    }
  }

  return {
    ok: true,
    files_total: files.length,
    files_processed: results.filter(r => r.ok && !r.skipped).length,
    files_skipped: results.filter(r => r.skipped).length,
    files_failed: results.filter(r => !r.ok).length,
    total_records: totalRecords,
    results,
  };
}

/**
 * Log extraction result to ai_extract_log table.
 */
function logExtraction(atlas, hash, filename, entityCount, recordCount, usage, error) {
  if (!atlas?.db || !hash) return;
  try {
    atlas.db.prepare(`
      INSERT INTO ai_extract_log (file_hash, filename, entity_count, record_count, input_tokens, output_tokens, last_error, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(file_hash) DO UPDATE SET
        filename = excluded.filename,
        entity_count = excluded.entity_count,
        record_count = excluded.record_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        last_error = excluded.last_error,
        processed_at = datetime('now')
    `).run(
      hash,
      filename,
      entityCount,
      recordCount,
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      error ?? null,
    );
  } catch (e) {
    console.error(`[ATLAS AI] Failed to log extraction: ${e.message}`);
  }
}
