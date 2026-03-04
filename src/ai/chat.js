/**
 * ATLAS AI Chat — orchestrates LLM tool-calling loop over ATLAS data.
 */

import { LlmClient } from './llm-client.js';
import { ModelRegistry } from './model-registry.js';

const MAX_TOOL_ITERATIONS = 5;

// ── Tool definitions (JSON Schema) ──────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_shipments',
    description: 'List shipments with optional filters by status, mode, date range.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending','in_transit','customs','delivered','exception','cancelled'] },
        mode: { type: 'string', enum: ['road','ocean','air','rail','multimodal'] },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'get_shipment',
    description: 'Get full details for a single shipment by ID.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Shipment ID' } },
      required: ['id'],
    },
  },
  {
    name: 'get_shipment_events',
    description: 'Get tracking event timeline for a shipment.',
    input_schema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string' },
        exceptions_only: { type: 'boolean', default: false },
        limit: { type: 'number', default: 50 },
      },
      required: ['shipment_id'],
    },
  },
  {
    name: 'search_carriers',
    description: 'Search carriers by country, type, rating, or free text query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        country: { type: 'string', description: '2-letter ISO country code' },
        type: { type: 'string', enum: ['trucking','shipping_line','airline','rail','broker'] },
        min_rating: { type: 'number' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'get_carrier_shipments',
    description: "Get all shipments for a specific carrier.",
    input_schema: {
      type: 'object',
      properties: {
        carrier_id: { type: 'string' },
        limit: { type: 'number', default: 20 },
      },
      required: ['carrier_id'],
    },
  },
  {
    name: 'get_rate_history',
    description: 'Freight rate history for a lane. Provide origin and/or destination (2-letter country codes), optional carrier and date filters.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '2-letter country code' },
        destination: { type: 'string', description: '2-letter country code' },
        carrier_id: { type: 'string' },
        mode: { type: 'string', enum: ['road','ocean','air','rail','multimodal'] },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'list_documents',
    description: 'List logistics documents, optionally filtered by shipment or document type.',
    input_schema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string' },
        type: { type: 'string', enum: ['bol','cmr','awb','invoice','customs_export','customs_import','pod','packing_list','certificate_of_origin','dangerous_goods','other'] },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'get_available_models',
    description: 'List what data models/entity types exist in ATLAS with record counts.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_records',
    description: 'Generic query: fetch records from any data model by name with optional filters.',
    input_schema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model/entity name (e.g. shipments, carriers, rates)' },
        filters: { type: 'object', description: 'Key-value filters' },
        limit: { type: 'number', default: 50 },
      },
      required: ['model'],
    },
  },
  {
    name: 'query',
    description: 'Natural language search across all indexed logistics data.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        mode: { type: 'string', enum: ['road','ocean','air','rail','multimodal'] },
        limit: { type: 'number', default: 10 },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_sync_status',
    description: 'Data freshness: record counts and last sync timestamps per table.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sla_violations',
    description: 'Get SLA violations, optionally filtered by mode or country.',
    input_schema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date' },
        mode: { type: 'string' },
        origin_country: { type: 'string' },
        destination_country: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'get_anomalies',
    description: 'Get tracking anomalies and exceptions.',
    input_schema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'get_active_issues',
    description: 'Get active operational issues, optionally filtered by type or severity.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        severity: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
];

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(atlas) {
  const sync = atlas.getSyncStatus();
  const counts = Object.entries(sync).map(([k, v]) => `${k}: ${v.count}`).join(', ');
  return `You are ATLAS Assistant — an AI that helps users explore and understand their logistics data.
You have access to tools that query an ATLAS logistics database. Use them to answer questions accurately.

Current data: ${counts || 'no data loaded yet'}.

Guidelines:
- Call tools to get real data before answering. Do not guess or fabricate data.
- If no results are found, say so clearly.
- Present data in a clear, readable format. Use tables or lists when appropriate.
- For comparisons, call the relevant tool multiple times with different parameters.
- Keep answers concise but complete.
- When showing IDs, rates, or dates, be precise.`;
}

// ── Tool executor ───────────────────────────────────────────────────────────

function executeTool(name, args, atlas) {
  switch (name) {
    case 'get_shipments':
      return atlas.listShipments(args);
    case 'get_shipment':
      return { shipment: atlas.getShipment(args.id) };
    case 'get_shipment_events':
      return atlas.listEvents(args);
    case 'search_carriers':
      return atlas.searchCarriers(args);
    case 'get_carrier_shipments':
      return atlas.getCarrierShipments(args.carrier_id, { limit: args.limit });
    case 'get_rate_history':
      return atlas.getRateHistory(args);
    case 'list_documents':
      return atlas.listDocuments(args);
    case 'get_available_models':
      return atlas.getAvailableModels();
    case 'get_records':
      return atlas.getRecords(args.model, args.filters, args.limit);
    case 'query':
      return atlas.query(args.question, { mode: args.mode, limit: args.limit });
    case 'get_sync_status':
      return atlas.getSyncStatus();
    case 'get_sla_violations':
      return atlas.getSlaViolations(args);
    case 'get_anomalies':
      return atlas.getAnomalies(args);
    case 'get_active_issues':
      return atlas.getActiveIssues(args);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Chat handler ────────────────────────────────────────────────────────────

/**
 * @param {Array<{role:string,content:string}>} messages - Conversation history
 * @param {import('../atlas.js').Atlas} atlas - Atlas instance
 * @param {object|ModelRegistry} registryOrConfig - ModelRegistry or legacy AI config
 * @param {string} [modelId] - Optional model ID to use (overrides role routing)
 * @returns {Promise<{reply:string, tool_calls:Array, usage:{input_tokens:number,output_tokens:number}}>}
 */
export async function handleChat(messages, atlas, registryOrConfig = {}, modelId) {
  let llm;
  if (registryOrConfig instanceof ModelRegistry) {
    llm = modelId ? registryOrConfig.get(modelId) : registryOrConfig.getFor('chat');
    if (!llm) llm = registryOrConfig.getFor('default');
  } else {
    llm = new LlmClient(registryOrConfig);
  }
  if (!llm) {
    return { reply: 'No AI model configured.', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 } };
  }
  const systemPrompt = buildSystemPrompt(atlas);
  const toolCallLog = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  // Build LLM-ready messages (only user/assistant roles)
  let llmMessages = messages.map(m => ({ role: m.role, content: m.content }));

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const res = await llm.chatWithTools(llmMessages, TOOLS, systemPrompt);
    totalUsage.input_tokens += res.usage.input_tokens;
    totalUsage.output_tokens += res.usage.output_tokens;

    // If LLM returned text with no tool calls, we're done
    if (!res.tool_calls) {
      return { reply: res.text || '(No response)', tool_calls: toolCallLog, usage: totalUsage };
    }

    // Execute tool calls
    if (llm.provider === 'claude') {
      // Claude: append assistant message with full content blocks, then tool results
      const assistantContent = [];
      if (res.text) assistantContent.push({ type: 'text', text: res.text });
      for (const tc of res.tool_calls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      llmMessages.push({ role: 'assistant', content: assistantContent });

      const toolResults = [];
      for (const tc of res.tool_calls) {
        let result;
        try {
          result = executeTool(tc.name, tc.input, atlas);
        } catch (e) {
          result = { error: e.message };
        }
        const resultStr = JSON.stringify(result, null, 2);
        toolCallLog.push({ name: tc.name, args: tc.input, result: resultStr });
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: resultStr });
      }
      llmMessages.push({ role: 'user', content: toolResults });
    } else {
      // OpenAI: append assistant message with tool_calls, then tool role messages
      llmMessages.push({
        role: 'assistant',
        content: res.text || '',
        tool_calls: res.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
      for (const tc of res.tool_calls) {
        let result;
        try {
          result = executeTool(tc.name, tc.input, atlas);
        } catch (e) {
          result = { error: e.message };
        }
        const resultStr = JSON.stringify(result, null, 2);
        toolCallLog.push({ name: tc.name, args: tc.input, result: resultStr });
        llmMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
      }
    }
  }

  // If we exhausted iterations, do one final call without tools
  const finalRes = await llm.chatWithTools(llmMessages, [], systemPrompt);
  totalUsage.input_tokens += finalRes.usage.input_tokens;
  totalUsage.output_tokens += finalRes.usage.output_tokens;
  return { reply: finalRes.text || '(No response)', tool_calls: toolCallLog, usage: totalUsage };
}
