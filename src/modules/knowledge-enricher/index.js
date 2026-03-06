/**
 * ATLAS Knowledge Enricher Module
 * Polls ai_extract_log for recent extractions and enriches knowledge base.
 */

/** @type {{ atlas: any, config: any, registry: any, logger: any, state: any }} */
let ctx = null;
let status = 'stopped';
let lastRun = null;
let runsCompleted = 0;
let lastError = null;

export default {
  async initialize(moduleCtx) {
    ctx = moduleCtx;
  },

  async start() {
    status = 'running';
    lastError = null;
    ctx.logger.info('Knowledge Enricher started');

    try {
      await this.run();
    } catch (e) {
      ctx.logger.error(`Initial run failed: ${e.message}`);
    }
  },

  async run() {
    if (ctx.config.auto_enrich_extractions === false) {
      return { records_processed: 0, skipped: true };
    }

    const maxFiles = ctx.config.max_files_per_run ?? 5;
    const lastProcessedAt = ctx.state.get('last_processed_at') ?? '1970-01-01T00:00:00';

    // Query ai_extract_log for entries since last run
    let entries;
    try {
      entries = ctx.atlas.db.prepare(
        `SELECT file_hash, filename, entity_count, record_count, processed_at
         FROM ai_extract_log
         WHERE processed_at > ? AND last_error IS NULL
         ORDER BY processed_at ASC
         LIMIT ?`
      ).all(lastProcessedAt, maxFiles);
    } catch (e) {
      // Table might not exist
      ctx.logger.warn(`Cannot query ai_extract_log: ${e.message}`);
      return { records_processed: 0, error: e.message };
    }

    if (!entries.length) {
      lastRun = new Date().toISOString();
      return { records_processed: 0 };
    }

    // Create KnowledgeEngine
    const { KnowledgeEngine } = await import('../../ai/knowledge-engine.js');
    const engine = new KnowledgeEngine(ctx.atlas, ctx.registry);

    if (!engine.isConfigured()) {
      ctx.logger.warn('AI not configured — skipping knowledge enrichment');
      return { records_processed: 0, error: 'AI not configured' };
    }

    let enriched = 0;
    let latestProcessedAt = lastProcessedAt;

    for (const entry of entries) {
      try {
        // Build summary from recent DB records related to this extraction
        const summary = buildSummaryForEntry(entry);
        const topic = guessTopicFromFilename(entry.filename);

        const result = await engine.enrichFromText(
          summary,
          `file: ${entry.filename}`,
          topic,
        );

        if (result.ok) {
          enriched++;
          const updateCount = (result.updates ?? []).filter(u => u.applied).length;
          ctx.logger.info(`Enriched from ${entry.filename}: ${updateCount} KB update(s)`);
        } else {
          ctx.logger.warn(`Enrichment failed for ${entry.filename}: ${result.error}`);
        }

        if (entry.processed_at > latestProcessedAt) {
          latestProcessedAt = entry.processed_at;
        }
      } catch (e) {
        ctx.logger.error(`Error enriching from ${entry.filename}: ${e.message}`);
      }
    }

    // Update state
    ctx.state.set('last_processed_at', latestProcessedAt);
    lastRun = new Date().toISOString();
    runsCompleted++;
    lastError = null;

    ctx.logger.info(`Run complete: ${enriched}/${entries.length} extractions enriched`);
    return { records_processed: enriched };
  },

  async stop() {
    status = 'stopped';
    ctx.logger.info('Stopped');
  },

  getStatus() {
    return {
      status,
      last_run: lastRun,
      runs_completed: runsCompleted,
      error: lastError,
    };
  },
};

/**
 * Build a text summary from an ai_extract_log entry.
 * Only includes metadata from the extraction itself — does not query
 * unrelated tables (no way to correlate log entries to specific DB records).
 */
function buildSummaryForEntry(entry) {
  return `Extracted file: ${entry.filename}\nEntity groups: ${entry.entity_count}\nTotal records: ${entry.record_count}\nProcessed at: ${entry.processed_at}`;
}

/**
 * Guess topic from filename for better KB file matching.
 */
function guessTopicFromFilename(filename) {
  const lower = (filename ?? '').toLowerCase();
  if (/ship|transport|deliver|tracking/.test(lower)) return 'transport';
  if (/carrier|перевіз/.test(lower)) return 'transport';
  if (/supplier|постачальн|vendor/.test(lower)) return 'suppliers';
  if (/warehouse|склад/.test(lower)) return 'warehouses';
  if (/product|продукц|товар/.test(lower)) return 'products';
  if (/rate|tarif|тариф/.test(lower)) return 'rates';
  if (/route|маршрут/.test(lower)) return 'routes';
  if (/invoice|рахунок|інвойс/.test(lower)) return 'finance';
  if (/order|замовлен/.test(lower)) return 'orders';
  return '';
}
