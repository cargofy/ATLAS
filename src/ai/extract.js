/**
 * ATLAS AI Entity Extraction
 * Builds an LLM prompt from model schemas, sends file content, parses structured entities.
 * Validates results via existing mapper.js validateMapped().
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateMapped } from '../mapper.js';
import { MODEL_REGISTRY, MODEL_ALIASES, REQUIRED_FIELDS } from '../models.js';
import { LlmClient } from './llm-client.js';
import { ModelRegistry } from './model-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', '..', 'models');

// Cache schema descriptions so we only build them once
let _schemaPrompt = null;

/**
 * Build a compact schema description for the LLM system prompt
 * from MODEL_REGISTRY, REQUIRED_FIELDS, and JSON schema files.
 */
function buildSchemaPrompt() {
  if (_schemaPrompt) return _schemaPrompt;

  const lines = [];
  const coreModels = Object.entries(MODEL_REGISTRY).filter(([, v]) => v.core);

  for (const [name, { table }] of coreModels) {
    const required = REQUIRED_FIELDS[table] ?? ['id'];
    let fields = `required: [${required.join(', ')}]`;

    // Try loading JSON schema for richer field descriptions
    const schemaFiles = {
      shipment: 'shipment.json',
      carrier: 'carrier.json',
      tracking_event: 'event.json',
      rate: 'rate.json',
      document: 'document.json',
      lane: 'route.json',
    };
    const schemaFile = schemaFiles[name];
    if (schemaFile) {
      try {
        const schema = JSON.parse(readFileSync(join(MODELS_DIR, schemaFile), 'utf8'));
        const props = Object.keys(schema.properties ?? {}).slice(0, 15);
        fields += `; fields: [${props.join(', ')}]`;
        // Add enums for key fields
        for (const key of ['status', 'mode', 'type']) {
          const enm = schema.properties?.[key]?.enum;
          if (enm) fields += `; ${key}: ${enm.join('|')}`;
        }
      } catch { /* schema file not found — use minimal description */ }
    }

    lines.push(`- ${table} (model: ${name}): ${fields}`);
  }

  _schemaPrompt = lines.join('\n');
  return _schemaPrompt;
}

/**
 * Build the full system prompt for AI entity extraction.
 */
function buildSystemPrompt() {
  const schemas = buildSchemaPrompt();
  return `You are an AI logistics data extractor for the ATLAS system.

TASK: Extract structured logistics entities from the provided document text.

OUTPUT FORMAT — respond with ONLY valid JSON, no markdown, no explanation:
{"entities": [{"entity_type": "<table_name>", "records": [{...}, ...]}]}

AVAILABLE ENTITY TYPES AND SCHEMAS:
${schemas}

RULES:
1. entity_type MUST be one of the table names listed above (e.g. "shipments", "carriers", "tracking_events", "rates", "documents", "lanes")
2. Every record MUST have an "id" field. Derive it from document numbers, reference codes, or identifiers found in the text. If none found, generate: "ai-<entity>-<short_hash>" where short_hash is first 8 chars of a hash of key fields.
3. Use ISO standards: country codes (2-letter ISO 3166-1), dates (ISO 8601), currencies (ISO 4217).
4. For shipments: always set "status" field. Infer from context (e.g. "delivered", "in_transit", "pending").
5. For tracking_events: always include "shipment_id" and "timestamp".
6. For carriers: always include "name".
7. Extract ALL entities you can identify. A single document may contain shipments, carriers, events, rates, and documents.
8. Preserve original values where possible. Only normalize country codes and dates.
9. If the document contains no extractable logistics entities, return: {"entities": []}
10. Do NOT wrap the JSON in code fences or markdown.`;
}

/**
 * Parse LLM response text into structured JSON.
 * Handles code fences, trailing text, and common malformation.
 */
function parseLlmResponse(text) {
  let cleaned = text.trim();

  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();

  // Find the JSON object boundaries
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in LLM response');
  }
  cleaned = cleaned.slice(start, end + 1);

  return JSON.parse(cleaned);
}

/**
 * Resolve entity type aliases to canonical table names.
 */
function resolveEntityType(entityType) {
  // Direct table name match
  const tables = new Set(Object.values(MODEL_REGISTRY).map(v => v.table));
  if (tables.has(entityType)) return entityType;

  // Check aliases
  const aliased = MODEL_ALIASES[entityType];
  if (aliased) return aliased;

  // Check model name → table
  const entry = MODEL_REGISTRY[entityType];
  if (entry) return entry.table;

  return null;
}

/**
 * Extract structured logistics entities from text using an LLM.
 *
 * @param {string} text - Document text content
 * @param {object} meta - File metadata (filename, etc.)
 * @param {object} opts - Options: { config, registry, maxChars }
 * @returns {Promise<{entities: Array<{entity_type, records}>, usage, error?}>}
 */
export async function extract(text, meta = {}, opts = {}) {
  const maxChars = opts.maxChars ?? 40_000;
  // Prefer registry (new multi-model), fall back to legacy config
  const client = opts.registry instanceof ModelRegistry
    ? opts.registry.getFor('extract')
    : new LlmClient(opts.config ?? {});

  if (!client.isConfigured()) {
    return { entities: [], usage: { input_tokens: 0, output_tokens: 0 }, error: 'AI not configured' };
  }

  const systemPrompt = buildSystemPrompt();
  const userContent = `FILENAME: ${meta.filename ?? 'unknown'}\n\nDOCUMENT TEXT:\n${text.slice(0, maxChars)}`;

  let response;
  let parsed;
  let retries = 0;
  const maxRetries = 1;

  while (retries <= maxRetries) {
    try {
      response = await client.complete(systemPrompt, userContent);
      parsed = parseLlmResponse(response.text);
      break;
    } catch (e) {
      if (retries >= maxRetries) {
        return {
          entities: [],
          usage: response?.usage ?? { input_tokens: 0, output_tokens: 0 },
          error: `LLM response parse error: ${e.message}`,
        };
      }
      retries++;
      // Retry with a hint
      try {
        response = await client.complete(
          systemPrompt,
          userContent + '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY a raw JSON object, no markdown.'
        );
        parsed = parseLlmResponse(response.text);
        break;
      } catch (e2) {
        return {
          entities: [],
          usage: response?.usage ?? { input_tokens: 0, output_tokens: 0 },
          error: `LLM response parse error after retry: ${e2.message}`,
        };
      }
    }
  }

  // Validate and filter entities
  const entities = [];
  for (const group of (parsed.entities ?? [])) {
    const resolvedType = resolveEntityType(group.entity_type);
    if (!resolvedType) {
      console.error(`[ATLAS AI] Unknown entity type "${group.entity_type}" — skipping`);
      continue;
    }

    const validRecords = [];
    for (const record of (group.records ?? [])) {
      const { valid, errors } = validateMapped(resolvedType, record);
      if (valid) {
        validRecords.push(record);
      } else {
        console.error(`[ATLAS AI] Validation failed for ${resolvedType}: ${errors.join(', ')}`);
      }
    }

    if (validRecords.length > 0) {
      entities.push({ entity_type: resolvedType, records: validRecords });
    }
  }

  return {
    entities,
    usage: response?.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}
