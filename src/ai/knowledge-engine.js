/**
 * ATLAS Knowledge Engine — AI-powered knowledge base enrichment.
 * Loads relevant KB files, compares new information, appends/creates/marks contradictions.
 * Never overwrites existing knowledge — only adds new facts or flags conflicts.
 */

const ENTITY_TOPIC_MAP = {
  shipments: 'transport',
  carriers: 'transport',
  tracking_events: 'orders',
  rates: 'rates',
  routes: 'routes',
  documents: 'documents',
  events: 'orders',
  suppliers: 'suppliers',
  warehouses: 'warehouses',
  products: 'products',
  orders: 'orders',
  invoices: 'finance',
};

const SYSTEM_PROMPT = `You are ATLAS Knowledge Analyst. Analyze new information against existing knowledge base.

RULES:
1. NEVER delete or overwrite existing information — only ADD or MARK contradictions.
2. Keep content in the SAME LANGUAGE as existing files.
3. Source attribution is MANDATORY.
4. Maintain existing Markdown style (## headers, tables, **bold** key-value).
5. If info already present — skip (no update needed).
6. If info contradicts existing data — mark_contradiction.
7. If new info for existing topic — append_section.
8. If new topic without file — create_file.

OUTPUT: valid JSON only, no markdown fences, no extra text:
{
  "analysis": "Brief summary of what was found",
  "updates": [
    {
      "action": "append_section",
      "path": "relative/path.md",
      "section_header": "## Section Name",
      "content": "New markdown content to append",
      "source": "source description",
      "reason": "why this update is needed"
    },
    {
      "action": "create_file",
      "path": "relative/path.md",
      "content": "Full markdown content for new file",
      "source": "source description",
      "reason": "why a new file is needed"
    },
    {
      "action": "mark_contradiction",
      "path": "relative/path.md",
      "section_header": "## Section where contradiction found",
      "contradiction": {
        "current_value": "what the KB currently says",
        "new_value": "what the new data says"
      },
      "source": "source description",
      "reason": "description of the conflict"
    }
  ]
}

If no updates needed (all info already present), return: {"analysis": "...", "updates": []}`;

export class KnowledgeEngine {
  /**
   * @param {import('../atlas.js').Atlas} atlas
   * @param {import('./model-registry.js').ModelRegistry|object} registryOrConfig
   */
  constructor(atlas, registryOrConfig) {
    this.atlas = atlas;
    this.llm = null;

    // Resolve LLM client with fallback: knowledge → extract → default
    if (registryOrConfig && typeof registryOrConfig.getFor === 'function') {
      this.llm = registryOrConfig.getFor('knowledge')
        ?? registryOrConfig.getFor('extract')
        ?? registryOrConfig.getFor('default');
    }
  }

  /** Check if AI is available for knowledge enrichment. */
  isConfigured() {
    return !!(this.llm && this.llm.isConfigured());
  }

  /**
   * Load relevant knowledge files for a topic/keywords.
   * Scores files by path match + keyword content match.
   *
   * @param {string} topic - General topic (e.g. 'transport', 'suppliers')
   * @param {string[]} keywords - Specific terms to search for
   * @param {{ maxFiles?: number, maxChars?: number }} opts
   * @returns {{ files: Array<{path: string, content: string, relevance: number}>, totalChars: number }}
   */
  loadRelevantKnowledge(topic, keywords = [], opts = {}) {
    const maxFiles = opts.maxFiles ?? 5;
    const maxChars = opts.maxChars ?? 30000;
    const allPaths = this.atlas.getKnowledgeIndex();

    if (!allPaths.length) return { files: [], totalChars: 0 };

    const topicLower = (topic ?? '').toLowerCase();
    const kwLower = keywords.map(k => k.toLowerCase());

    // Score each file
    const scored = [];
    for (const relPath of allPaths) {
      let score = 0;
      const pathLower = relPath.toLowerCase();

      // Path match: topic appears in file path (3 points)
      if (topicLower && pathLower.includes(topicLower)) score += 3;

      // Read content for keyword matching
      let content;
      try {
        content = this.atlas.readKnowledgeFile(relPath).content;
      } catch {
        continue;
      }

      const contentLower = content.toLowerCase();

      // Keyword match in content (1 point each)
      for (const kw of kwLower) {
        if (kw && contentLower.includes(kw)) score += 1;
      }

      if (score > 0) {
        scored.push({ path: relPath, content, relevance: score });
      }
    }

    // Sort by relevance descending
    scored.sort((a, b) => b.relevance - a.relevance);

    // Take top N within char budget
    const result = [];
    let totalChars = 0;
    for (const item of scored) {
      if (result.length >= maxFiles) break;
      if (totalChars + item.content.length > maxChars && result.length > 0) break;
      result.push(item);
      totalChars += item.content.length;
    }

    return { files: result, totalChars };
  }

  /**
   * Enrich knowledge base from structured AI extraction result.
   *
   * @param {{ entities: Array<{entity_type: string, records: any[]}>, filename?: string }} extractionResult
   * @param {{ source: string, date?: string }} sourceInfo
   * @returns {Promise<{ok: boolean, analysis?: string, updates?: any[], usage?: any, error?: string}>}
   */
  async enrichFromExtraction(extractionResult, sourceInfo = {}) {
    if (!this.isConfigured()) return { ok: false, error: 'AI not configured for knowledge enrichment' };

    try {
      const entities = extractionResult.entities ?? [];
      if (!entities.length) return { ok: true, analysis: 'No entities to process', updates: [] };

      // Derive topic from entity types
      const entityTypes = entities.map(e => e.entity_type);
      const topic = this._deriveTopic(entityTypes);

      // Extract keywords from records
      const keywords = this._extractKeywords(entities);

      // Load relevant KB context
      const kb = this.loadRelevantKnowledge(topic, keywords);

      // Build summary of extracted data
      const summaryParts = [];
      for (const group of entities) {
        summaryParts.push(`Entity type: ${group.entity_type} (${group.records.length} records)`);
        for (const rec of group.records.slice(0, 10)) {
          summaryParts.push(`  - ${JSON.stringify(rec)}`);
        }
      }

      const source = sourceInfo.source ?? extractionResult.filename ?? 'unknown';
      const date = sourceInfo.date ?? new Date().toISOString().slice(0, 10);

      return await this._analyze(summaryParts.join('\n'), kb, source, date);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Enrich knowledge base from raw text.
   *
   * @param {string} text - Raw text content
   * @param {string} source - Source identifier
   * @param {string} topic - Topic hint (optional)
   * @returns {Promise<{ok: boolean, analysis?: string, updates?: any[], usage?: any, error?: string}>}
   */
  async enrichFromText(text, source = 'manual', topic = '') {
    if (!this.isConfigured()) return { ok: false, error: 'AI not configured for knowledge enrichment' };

    try {
      // Extract keywords from text
      const keywords = this._extractKeywordsFromText(text);
      const kb = this.loadRelevantKnowledge(topic, keywords);
      const date = new Date().toISOString().slice(0, 10);

      return await this._analyze(text, kb, source, date);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Core analysis: send text + KB context to LLM, parse response, apply updates.
   * @private
   */
  async _analyze(newInfo, kb, source, date) {
    // Build user prompt
    const kbContext = kb.files.length
      ? kb.files.map(f => `--- FILE: ${f.path} ---\n${f.content}`).join('\n\n')
      : '(No relevant knowledge base files found — consider creating new files if needed)';

    const userPrompt = `EXISTING KNOWLEDGE BASE FILES:
${kbContext}

NEW INFORMATION (source: ${source}, date: ${date}):
${newInfo}

Analyze the new information against existing knowledge. Return JSON with updates needed.`;

    // Call LLM
    let response;
    try {
      response = await this.llm.complete(SYSTEM_PROMPT, userPrompt);
    } catch (e) {
      return { ok: false, error: `LLM call failed: ${e.message}` };
    }

    // Parse JSON response
    const parsed = this._parseJson(response.text);
    if (!parsed.ok) {
      // Retry once with hint
      try {
        const retryResponse = await this.llm.complete(
          SYSTEM_PROMPT,
          `Your previous response was not valid JSON. Here it was:\n${response.text}\n\nPlease return ONLY valid JSON, no markdown fences or extra text.`
        );
        const retryParsed = this._parseJson(retryResponse.text);
        if (!retryParsed.ok) {
          return { ok: false, error: 'Failed to parse LLM response as JSON after retry', usage: response.usage };
        }
        const retryUpdates = Array.isArray(retryParsed.data.updates) ? retryParsed.data.updates : [];
        const validRetryUpdates = retryUpdates.filter(u => u && typeof u === 'object' && u.action && u.path);
        const applied = this.applyUpdates(validRetryUpdates, source, date);
        return { ok: true, analysis: retryParsed.data.analysis ?? '', updates: applied, usage: retryResponse.usage };
      } catch (e) {
        return { ok: false, error: `Retry failed: ${e.message}`, usage: response.usage };
      }
    }

    // Validate structure
    const updates = Array.isArray(parsed.data.updates) ? parsed.data.updates : [];
    const validUpdates = updates.filter(u => u && typeof u === 'object' && u.action && u.path);

    // Apply updates
    const applied = this.applyUpdates(validUpdates, source, date);
    return { ok: true, analysis: parsed.data.analysis ?? '', updates: applied, usage: response.usage };
  }

  /**
   * Apply updates to KB files.
   *
   * @param {Array} updates - Array of update objects from LLM
   * @param {string} source - Source identifier for attribution
   * @param {string} date - Date string for attribution
   * @returns {Array} Applied updates with status
   */
  applyUpdates(updates, source, date) {
    const results = [];

    for (const update of updates) {
      try {
        switch (update.action) {
          case 'append_section':
            this._applyAppendSection(update, source, date);
            results.push({ ...update, applied: true });
            break;

          case 'create_file':
            this._applyCreateFile(update, source, date);
            results.push({ ...update, applied: true });
            break;

          case 'mark_contradiction':
            this._applyMarkContradiction(update, source, date);
            results.push({ ...update, applied: true });
            break;

          default:
            results.push({ ...update, applied: false, error: `Unknown action: ${update.action}` });
        }
      } catch (e) {
        console.error(`[ATLAS:KE] Failed to apply update (${update.action} → ${update.path}): ${e.message}`);
        results.push({ ...update, applied: false, error: e.message });
      }
    }

    return results;
  }

  /** @private */
  _applyAppendSection(update, source, date) {
    const { path: relPath, section_header, content } = update;
    const src = update.source ?? source;

    let existing;
    try {
      existing = this.atlas.readKnowledgeFile(relPath).content;
    } catch {
      // File doesn't exist — create it with the section
      const newContent = `${section_header}\n\n${content}\n\n> Джерело: ${src} (${date})\n`;
      this.atlas.writeKnowledgeFile(relPath, newContent);
      return;
    }

    // Find section header and insert before next section
    const headerIdx = existing.indexOf(section_header);
    let insertPos;

    if (headerIdx >= 0) {
      // Find next header of same or higher level
      const headerLevel = (section_header.match(/^#+/) ?? ['##'])[0];
      const nextHeaderRegex = new RegExp(`^#{1,${headerLevel.length}}\\s`, 'm');
      const afterHeader = existing.slice(headerIdx + section_header.length);
      const nextMatch = afterHeader.search(nextHeaderRegex);

      if (nextMatch >= 0) {
        insertPos = headerIdx + section_header.length + nextMatch;
      } else {
        // No next section — append at end
        insertPos = existing.length;
      }
    } else {
      // Section not found — append at end of file
      insertPos = existing.length;
    }

    const attribution = `\n> Джерело: ${src} (${date})\n`;
    const newBlock = `\n${content}${attribution}`;
    const updated = existing.slice(0, insertPos) + newBlock + existing.slice(insertPos);
    this.atlas.writeKnowledgeFile(relPath, updated);
  }

  /** @private */
  _applyCreateFile(update, source, date) {
    const { path: relPath, content } = update;
    const src = update.source ?? source;
    const attribution = `\n\n> Джерело: ${src} (${date})\n`;
    this.atlas.writeKnowledgeFile(relPath, content + attribution);
  }

  /** @private */
  _applyMarkContradiction(update, source, date) {
    const { path: relPath, section_header, contradiction } = update;
    if (!contradiction || !contradiction.current_value || !contradiction.new_value) {
      throw new Error('mark_contradiction requires contradiction.current_value and contradiction.new_value');
    }
    const src = update.source ?? source;

    let existing;
    try {
      existing = this.atlas.readKnowledgeFile(relPath).content;
    } catch {
      return; // Can't mark contradiction in non-existent file
    }

    const block = `\n\n> **Суперечність** (джерело: ${src}, ${date}):\n> Поточне значення: ${contradiction.current_value}\n> Нове значення: ${contradiction.new_value}\n> Потребує перевірки.\n`;

    // Insert after the relevant section header, or at end of file
    if (section_header) {
      const headerIdx = existing.indexOf(section_header);
      if (headerIdx >= 0) {
        const insertPos = headerIdx + section_header.length;
        const updated = existing.slice(0, insertPos) + block + existing.slice(insertPos);
        this.atlas.writeKnowledgeFile(relPath, updated);
        return;
      }
    }

    // Fallback: append at end
    this.atlas.writeKnowledgeFile(relPath, existing + block);
  }

  /**
   * Parse JSON from LLM response, handling common issues.
   * @private
   */
  _parseJson(text) {
    if (!text) return { ok: false };

    // Strip markdown fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    try {
      const data = JSON.parse(cleaned);
      return { ok: true, data };
    } catch {
      // Try to extract JSON from surrounding text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          return { ok: true, data };
        } catch {
          return { ok: false };
        }
      }
      return { ok: false };
    }
  }

  /**
   * Derive topic from entity types.
   * @private
   */
  _deriveTopic(entityTypes) {
    for (const et of entityTypes) {
      const mapped = ENTITY_TOPIC_MAP[et];
      if (mapped) return mapped;
    }
    return entityTypes[0] ?? '';
  }

  /**
   * Extract keywords from structured entity records.
   * @private
   */
  _extractKeywords(entities) {
    const kw = new Set();
    for (const group of entities) {
      kw.add(group.entity_type);
      for (const rec of group.records.slice(0, 20)) {
        for (const [key, val] of Object.entries(rec)) {
          if (typeof val === 'string' && val.length > 1 && val.length < 100) {
            // Extract identifiers, names, codes
            if (/^(id|name|code|carrier|origin|destination|supplier|product|warehouse)/.test(key) ||
                /id$|_name$|_code$/i.test(key)) {
              kw.add(val);
            }
          }
        }
      }
    }
    return [...kw].slice(0, 20);
  }

  /**
   * Extract keywords from raw text.
   * @private
   */
  _extractKeywordsFromText(text) {
    // Extract capitalized words, codes, numbers that look like identifiers
    const words = text.match(/[A-ZА-ЯІЇЄҐ][a-zа-яіїєґ']+(?:\s+[A-ZА-ЯІЇЄҐ][a-zа-яіїєґ']+)*/g) ?? [];
    const codes = text.match(/[A-Z]{2,}[-\d]+/g) ?? [];
    const unique = new Set([...words, ...codes]);
    return [...unique].slice(0, 20);
  }
}
