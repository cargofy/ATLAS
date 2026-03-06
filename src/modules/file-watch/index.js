/**
 * ATLAS File Watcher Module
 * Watches a local folder for new files, extracts data via AI pipeline.
 * Tracks processed files by content hash to avoid re-processing.
 */

import { readdirSync, statSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

/** @type {{ atlas: any, config: any, logger: any, state: any }} */
let ctx = null;
let watchPath = '';
let timer = null;
let status = 'stopped';
let lastRun = null;
let filesProcessed = 0;
let lastError = null;

function fileHash(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export default {
  async initialize(moduleCtx) {
    ctx = moduleCtx;
    const rawPath = ctx.config.watch_path ?? './inbox';
    watchPath = resolve(rawPath);

    // Create watch directory if it doesn't exist
    if (!existsSync(watchPath)) {
      try {
        mkdirSync(watchPath, { recursive: true });
        ctx.logger.info(`Created watch directory: ${watchPath}`);
      } catch (e) {
        ctx.logger.error(`Cannot create watch directory: ${e.message}`);
      }
    }
  },

  async start() {
    status = 'running';
    lastError = null;
    ctx.logger.info(`Watching ${watchPath}`);

    // Run once immediately
    try {
      await this.run();
    } catch (e) {
      ctx.logger.error(`Initial run failed: ${e.message}`);
    }
  },

  async run() {
    if (!existsSync(watchPath)) {
      lastError = `Watch path does not exist: ${watchPath}`;
      return { records_processed: 0, error: lastError };
    }

    let entries;
    try {
      entries = readdirSync(watchPath);
    } catch (e) {
      lastError = e.message;
      return { records_processed: 0, error: e.message };
    }

    const files = entries.filter(name => {
      const full = join(watchPath, name);
      try { return statSync(full).isFile(); } catch { return false; }
    });

    // Pre-load pipeline dependencies once
    const { processFile } = await import('../../ai/extract-pipeline.js');
    const { ConnectorRunner } = await import('../../connector-runner.js');
    let ke = null;
    if (ctx.registry) {
      const { KnowledgeEngine } = await import('../../ai/knowledge-engine.js');
      ke = new KnowledgeEngine(ctx.atlas, ctx.registry);
    }

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const name of files) {
      const filePath = join(watchPath, name);

      try {
        const hash = fileHash(filePath);

        // Check if already processed (hash-based dedup)
        const existing = ctx.state.get(`hash:${hash}`);
        if (existing) {
          skipped++;
          continue;
        }

        const tmpRunner = new ConnectorRunner(ctx.atlas, ctx.atlas.config ?? {});

        const result = await processFile(filePath, {
          atlas: ctx.atlas,
          registry: ctx.registry,
          upsert: (entity, record) => tmpRunner._upsert(entity, record),
          knowledgeEngine: ke,
        });

        if (result.ok) {
          // Mark as processed
          ctx.state.set(`hash:${hash}`, JSON.stringify({
            filename: name,
            processed_at: new Date().toISOString(),
            records: result.records,
          }));
          processed++;
          filesProcessed++;

          // Archive if configured
          if (ctx.config.auto_archive) {
            const archiveDir = join(watchPath, 'archive');
            mkdirSync(archiveDir, { recursive: true });
            try {
              renameSync(filePath, join(archiveDir, name));
            } catch (e) {
              ctx.logger.warn(`Could not archive ${name}: ${e.message}`);
            }
          }

          ctx.logger.info(`Processed: ${name} (${result.records} records)`);
        } else {
          errors++;
          ctx.logger.error(`Failed: ${name} — ${result.error}`);
        }
      } catch (e) {
        errors++;
        ctx.logger.error(`Error processing ${name}: ${e.message}`);
      }
    }

    lastRun = new Date().toISOString();
    lastError = errors > 0 ? `${errors} file(s) failed` : null;

    ctx.logger.info(`Scan complete: ${processed} processed, ${skipped} skipped, ${errors} errors`);
    return { records_processed: processed, skipped, errors };
  },

  async stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    status = 'stopped';
    ctx.logger.info('Stopped');
  },

  getStatus() {
    return {
      status,
      last_run: lastRun,
      files_processed: filesProcessed,
      watch_path: watchPath,
      error: lastError,
    };
  },
};
