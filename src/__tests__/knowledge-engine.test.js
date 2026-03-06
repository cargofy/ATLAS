/**
 * ATLAS Knowledge Engine — unit tests.
 * Uses mocked Atlas + LLM to test all engine logic without real AI calls.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeEngine } from '../ai/knowledge-engine.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a mock Atlas with in-memory KB files. */
function mockAtlas(files = {}) {
  const store = { ...files }; // relPath → content
  return {
    getKnowledgeIndex() {
      return Object.keys(store).sort();
    },
    readKnowledgeFile(relPath) {
      if (!(relPath in store)) throw new Error(`File not found: ${relPath}`);
      return { path: relPath, content: store[relPath], modified: '2026-01-01' };
    },
    writeKnowledgeFile(relPath, content) {
      let p = relPath;
      if (!p.endsWith('.md')) p += '.md';
      store[p] = content;
      return { path: p, ok: true };
    },
    _store: store, // exposed for assertions
  };
}

/** Build a mock registry that returns a fake LLM client. */
function mockRegistry(responseText = '{"analysis":"ok","updates":[]}') {
  const calls = [];
  const llm = {
    isConfigured: () => true,
    async complete(system, user) {
      calls.push({ system, user });
      return { text: responseText, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
  return {
    registry: {
      getFor(role) { return llm; },
    },
    llm,
    calls,
  };
}

// ─── Constructor & isConfigured ──────────────────────────────────────────────

describe('KnowledgeEngine — constructor', () => {
  it('isConfigured() returns false when no registry', () => {
    const ke = new KnowledgeEngine(mockAtlas(), null);
    assert.equal(ke.isConfigured(), false);
  });

  it('isConfigured() returns false when registry has no configured client', () => {
    const registry = {
      getFor() { return { isConfigured: () => false }; },
    };
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    assert.equal(ke.isConfigured(), false);
  });

  it('isConfigured() returns true with valid registry', () => {
    const { registry } = mockRegistry();
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    assert.equal(ke.isConfigured(), true);
  });

  it('falls back through knowledge → extract → default roles', () => {
    const clients = {
      knowledge: null,
      extract: null,
      default: { isConfigured: () => true },
    };
    const registry = { getFor(role) { return clients[role]; } };
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    assert.equal(ke.isConfigured(), true);
    assert.equal(ke.llm, clients.default);
  });
});

// ─── loadRelevantKnowledge ───────────────────────────────────────────────────

describe('KnowledgeEngine — loadRelevantKnowledge', () => {
  it('returns empty when no KB files exist', () => {
    const ke = new KnowledgeEngine(mockAtlas({}), null);
    const result = ke.loadRelevantKnowledge('transport', ['DHL']);
    assert.equal(result.files.length, 0);
    assert.equal(result.totalChars, 0);
  });

  it('scores path match higher than keyword match', () => {
    const atlas = mockAtlas({
      'transport/carriers.md': 'Перевізники список',
      'suppliers/main.md': 'Постачальник DHL доставка',
    });
    const ke = new KnowledgeEngine(atlas, null);
    const result = ke.loadRelevantKnowledge('transport', ['DHL']);

    assert.equal(result.files.length, 2);
    // transport/carriers.md has path match (3) but no keyword match
    // suppliers/main.md has keyword match (1) for "DHL"
    assert.equal(result.files[0].path, 'transport/carriers.md');
    assert.ok(result.files[0].relevance > result.files[1].relevance);
  });

  it('respects maxFiles limit', () => {
    const atlas = mockAtlas({
      'a.md': 'keyword',
      'b.md': 'keyword',
      'c.md': 'keyword',
    });
    const ke = new KnowledgeEngine(atlas, null);
    const result = ke.loadRelevantKnowledge('', ['keyword'], { maxFiles: 2 });
    assert.equal(result.files.length, 2);
  });

  it('respects maxChars budget', () => {
    const longContent = 'x'.repeat(20000);
    const atlas = mockAtlas({
      'a.md': longContent + ' keyword',
      'b.md': longContent + ' keyword',
    });
    const ke = new KnowledgeEngine(atlas, null);
    // maxChars = 25000 — first file fits (~20007 chars), second would exceed
    const result = ke.loadRelevantKnowledge('', ['keyword'], { maxChars: 25000 });
    assert.equal(result.files.length, 1);
  });

  it('skips files with score 0', () => {
    const atlas = mockAtlas({
      'unrelated.md': 'nothing relevant here',
      'transport/info.md': 'DHL carrier info',
    });
    const ke = new KnowledgeEngine(atlas, null);
    const result = ke.loadRelevantKnowledge('transport', ['DHL']);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'transport/info.md');
  });

  it('accumulates keyword matches', () => {
    const atlas = mockAtlas({
      'a.md': 'DHL UPS FedEx',
      'b.md': 'DHL only',
    });
    const ke = new KnowledgeEngine(atlas, null);
    const result = ke.loadRelevantKnowledge('', ['DHL', 'UPS', 'FedEx']);
    assert.equal(result.files[0].path, 'a.md');
    assert.equal(result.files[0].relevance, 3); // 3 keyword matches
    assert.equal(result.files[1].relevance, 1);
  });
});

// ─── _parseJson ──────────────────────────────────────────────────────────────

describe('KnowledgeEngine — _parseJson', () => {
  let ke;
  beforeEach(() => { ke = new KnowledgeEngine(mockAtlas(), null); });

  it('parses clean JSON', () => {
    const r = ke._parseJson('{"analysis":"ok","updates":[]}');
    assert.equal(r.ok, true);
    assert.equal(r.data.analysis, 'ok');
  });

  it('strips markdown fences', () => {
    const r = ke._parseJson('```json\n{"analysis":"ok","updates":[]}\n```');
    assert.equal(r.ok, true);
    assert.equal(r.data.analysis, 'ok');
  });

  it('extracts JSON from surrounding text', () => {
    const r = ke._parseJson('Here is the result:\n{"analysis":"ok","updates":[]}\nDone.');
    assert.equal(r.ok, true);
    assert.equal(r.data.analysis, 'ok');
  });

  it('returns ok:false for empty input', () => {
    assert.equal(ke._parseJson('').ok, false);
    assert.equal(ke._parseJson(null).ok, false);
    assert.equal(ke._parseJson(undefined).ok, false);
  });

  it('returns ok:false for completely invalid input', () => {
    assert.equal(ke._parseJson('not json at all').ok, false);
  });
});

// ─── _deriveTopic ────────────────────────────────────────────────────────────

describe('KnowledgeEngine — _deriveTopic', () => {
  let ke;
  beforeEach(() => { ke = new KnowledgeEngine(mockAtlas(), null); });

  it('maps shipments → transport', () => {
    assert.equal(ke._deriveTopic(['shipments']), 'transport');
  });

  it('maps carriers → transport', () => {
    assert.equal(ke._deriveTopic(['carriers']), 'transport');
  });

  it('maps invoices → finance', () => {
    assert.equal(ke._deriveTopic(['invoices']), 'finance');
  });

  it('returns first entity type if not in map', () => {
    assert.equal(ke._deriveTopic(['unknown_type']), 'unknown_type');
  });

  it('returns empty string for empty array', () => {
    assert.equal(ke._deriveTopic([]), '');
  });

  it('uses first mapped type when multiple provided', () => {
    assert.equal(ke._deriveTopic(['events', 'shipments']), 'orders');
  });
});

// ─── _extractKeywords ────────────────────────────────────────────────────────

describe('KnowledgeEngine — _extractKeywords', () => {
  let ke;
  beforeEach(() => { ke = new KnowledgeEngine(mockAtlas(), null); });

  it('includes entity_type', () => {
    const kw = ke._extractKeywords([{ entity_type: 'shipments', records: [] }]);
    assert.ok(kw.includes('shipments'));
  });

  it('extracts id/name/code fields from records', () => {
    const kw = ke._extractKeywords([{
      entity_type: 'carriers',
      records: [{ id: 'C-001', name: 'DHL Express', country: 'DE' }],
    }]);
    assert.ok(kw.includes('C-001'));
    assert.ok(kw.includes('DHL Express'));
  });

  it('extracts fields ending with _id, _name, _code', () => {
    const kw = ke._extractKeywords([{
      entity_type: 'shipments',
      records: [{ carrier_id: 'UPS-42', destination_name: 'Kyiv' }],
    }]);
    assert.ok(kw.includes('UPS-42'));
    assert.ok(kw.includes('Kyiv'));
  });

  it('skips very long or very short strings', () => {
    const kw = ke._extractKeywords([{
      entity_type: 'x',
      records: [{ name: 'A', code: 'x'.repeat(101) }],
    }]);
    assert.ok(!kw.includes('A')); // length 1 — too short
    assert.ok(!kw.includes('x'.repeat(101))); // > 100 — too long
  });

  it('limits to 20 keywords', () => {
    const records = [];
    for (let i = 0; i < 30; i++) records.push({ name: `Item-${i}` });
    const kw = ke._extractKeywords([{ entity_type: 'products', records }]);
    assert.ok(kw.length <= 20);
  });
});

// ─── _extractKeywordsFromText ────────────────────────────────────────────────

describe('KnowledgeEngine — _extractKeywordsFromText', () => {
  let ke;
  beforeEach(() => { ke = new KnowledgeEngine(mockAtlas(), null); });

  it('extracts capitalized words', () => {
    const kw = ke._extractKeywordsFromText('Новий постачальник MedSupply з Польщі');
    assert.ok(kw.some(k => k.includes('Новий')));
    assert.ok(kw.some(k => k.includes('Польщі')));
  });

  it('extracts code-like identifiers', () => {
    const kw = ke._extractKeywordsFromText('Shipment INV-2026-001 arrived');
    assert.ok(kw.some(k => k.includes('INV-2026')));
  });

  it('limits to 20 keywords', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Word${i}`).join(' ');
    const kw = ke._extractKeywordsFromText(text);
    assert.ok(kw.length <= 20);
  });

  it('returns empty array for empty text', () => {
    const kw = ke._extractKeywordsFromText('');
    assert.equal(kw.length, 0);
  });
});

// ─── applyUpdates — append_section ───────────────────────────────────────────

describe('KnowledgeEngine — applyUpdates: append_section', () => {
  it('appends content before next section of same/higher level', () => {
    const atlas = mockAtlas({
      'transport/carriers.md': '# Перевізники\n\n## DHL\n\nОпис DHL.\n\n## UPS\n\nОпис UPS.\n',
    });
    const ke = new KnowledgeEngine(atlas, null);
    const results = ke.applyUpdates([{
      action: 'append_section',
      path: 'transport/carriers.md',
      section_header: '## DHL',
      content: '**Новий контракт**: до 2027 року.',
    }], 'test.pdf', '2026-03-05');

    assert.equal(results[0].applied, true);
    const content = atlas._store['transport/carriers.md'];
    assert.ok(content.includes('**Новий контракт**: до 2027 року.'));
    assert.ok(content.includes('> Джерело: test.pdf (2026-03-05)'));
    // Verify UPS section still exists after the append
    assert.ok(content.includes('## UPS'));
    // Verify new content appears between DHL and UPS sections
    const dhlIdx = content.indexOf('## DHL');
    const newContentIdx = content.indexOf('**Новий контракт**');
    const upsIdx = content.indexOf('## UPS');
    assert.ok(dhlIdx < newContentIdx);
    assert.ok(newContentIdx < upsIdx);
  });

  it('appends at end of file if section header not found', () => {
    const atlas = mockAtlas({
      'info.md': '# Info\n\nSome content.',
    });
    const ke = new KnowledgeEngine(atlas, null);
    ke.applyUpdates([{
      action: 'append_section',
      path: 'info.md',
      section_header: '## Nonexistent',
      content: 'New data.',
    }], 'src', '2026-01-01');

    const content = atlas._store['info.md'];
    assert.ok(content.endsWith('New data.\n> Джерело: src (2026-01-01)\n'));
  });

  it('creates file if it does not exist', () => {
    const atlas = mockAtlas({});
    const ke = new KnowledgeEngine(atlas, null);
    ke.applyUpdates([{
      action: 'append_section',
      path: 'new/file.md',
      section_header: '## Section',
      content: 'Content here.',
    }], 'src', '2026-01-01');

    assert.ok('new/file.md' in atlas._store);
    assert.ok(atlas._store['new/file.md'].includes('## Section'));
    assert.ok(atlas._store['new/file.md'].includes('Content here.'));
  });

  it('uses update.source over fallback source', () => {
    const atlas = mockAtlas({ 'a.md': '# A' });
    const ke = new KnowledgeEngine(atlas, null);
    ke.applyUpdates([{
      action: 'append_section',
      path: 'a.md',
      section_header: '# A',
      content: 'data',
      source: 'custom-source.pdf',
    }], 'fallback', '2026-01-01');

    assert.ok(atlas._store['a.md'].includes('custom-source.pdf'));
    assert.ok(!atlas._store['a.md'].includes('fallback'));
  });
});

// ─── applyUpdates — create_file ──────────────────────────────────────────────

describe('KnowledgeEngine — applyUpdates: create_file', () => {
  it('creates a new KB file with attribution', () => {
    const atlas = mockAtlas({});
    const ke = new KnowledgeEngine(atlas, null);
    const results = ke.applyUpdates([{
      action: 'create_file',
      path: 'finance/invoices.md',
      content: '# Інвойси\n\nНовий інвойс INV-001.',
    }], 'invoice.pdf', '2026-03-05');

    assert.equal(results[0].applied, true);
    const content = atlas._store['finance/invoices.md'];
    assert.ok(content.startsWith('# Інвойси'));
    assert.ok(content.includes('> Джерело: invoice.pdf (2026-03-05)'));
  });
});

// ─── applyUpdates — mark_contradiction ───────────────────────────────────────

describe('KnowledgeEngine — applyUpdates: mark_contradiction', () => {
  it('inserts contradiction block after section header', () => {
    const atlas = mockAtlas({
      'transport/delivery.md': '# Доставка\n\n## Час поставки\n\n5-7 робочих днів.\n',
    });
    const ke = new KnowledgeEngine(atlas, null);
    const results = ke.applyUpdates([{
      action: 'mark_contradiction',
      path: 'transport/delivery.md',
      section_header: '## Час поставки',
      contradiction: {
        current_value: 'Час поставки: 5-7 робочих днів',
        new_value: 'Час поставки: 3-5 робочих днів',
      },
    }], 'new-contract.pdf', '2026-03-05');

    assert.equal(results[0].applied, true);
    const content = atlas._store['transport/delivery.md'];
    assert.ok(content.includes('> **Суперечність**'));
    assert.ok(content.includes('5-7 робочих днів'));
    assert.ok(content.includes('3-5 робочих днів'));
    assert.ok(content.includes('Потребує перевірки'));
  });

  it('appends at end if section header not found', () => {
    const atlas = mockAtlas({ 'a.md': '# File\n\nContent.' });
    const ke = new KnowledgeEngine(atlas, null);
    ke.applyUpdates([{
      action: 'mark_contradiction',
      path: 'a.md',
      section_header: '## Missing',
      contradiction: { current_value: 'A', new_value: 'B' },
    }], 'src', '2026-01-01');

    const content = atlas._store['a.md'];
    assert.ok(content.includes('> **Суперечність**'));
  });

  it('throws on missing contradiction field', () => {
    const atlas = mockAtlas({ 'a.md': '# A' });
    const ke = new KnowledgeEngine(atlas, null);
    const results = ke.applyUpdates([{
      action: 'mark_contradiction',
      path: 'a.md',
      section_header: '# A',
      // no contradiction field
    }], 'src', '2026-01-01');

    assert.equal(results[0].applied, false);
    assert.ok(results[0].error.includes('contradiction'));
  });

  it('throws on incomplete contradiction', () => {
    const atlas = mockAtlas({ 'a.md': '# A' });
    const ke = new KnowledgeEngine(atlas, null);
    const results = ke.applyUpdates([{
      action: 'mark_contradiction',
      path: 'a.md',
      section_header: '# A',
      contradiction: { current_value: 'A' }, // missing new_value
    }], 'src', '2026-01-01');

    assert.equal(results[0].applied, false);
  });

  it('silently skips non-existent file', () => {
    const atlas = mockAtlas({});
    const ke = new KnowledgeEngine(atlas, null);
    const results = ke.applyUpdates([{
      action: 'mark_contradiction',
      path: 'nonexistent.md',
      contradiction: { current_value: 'A', new_value: 'B' },
    }], 'src', '2026-01-01');
    // Should not throw, just mark as applied (no-op for missing file)
    assert.equal(results[0].applied, true);
  });
});

// ─── applyUpdates — unknown action ───────────────────────────────────────────

describe('KnowledgeEngine — applyUpdates: unknown action', () => {
  it('marks unknown action as not applied', () => {
    const ke = new KnowledgeEngine(mockAtlas(), null);
    const results = ke.applyUpdates([{
      action: 'delete_everything',
      path: 'a.md',
    }], 'src', '2026-01-01');

    assert.equal(results[0].applied, false);
    assert.ok(results[0].error.includes('Unknown action'));
  });
});

// ─── applyUpdates — mixed batch ──────────────────────────────────────────────

describe('KnowledgeEngine — applyUpdates: mixed batch', () => {
  it('continues after individual failure', () => {
    const atlas = mockAtlas({ 'exists.md': '# Content' });
    const ke = new KnowledgeEngine(atlas, null);
    const results = ke.applyUpdates([
      { action: 'mark_contradiction', path: 'exists.md' }, // fails: no contradiction
      { action: 'create_file', path: 'new.md', content: '# New' }, // succeeds
    ], 'src', '2026-01-01');

    assert.equal(results[0].applied, false);
    assert.equal(results[1].applied, true);
    assert.ok('new.md' in atlas._store);
  });
});

// ─── enrichFromExtraction ────────────────────────────────────────────────────

describe('KnowledgeEngine — enrichFromExtraction', () => {
  it('returns error when not configured', async () => {
    const ke = new KnowledgeEngine(mockAtlas(), null);
    const result = await ke.enrichFromExtraction({ entities: [] });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not configured'));
  });

  it('returns ok with empty entities', async () => {
    const { registry } = mockRegistry();
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    const result = await ke.enrichFromExtraction({ entities: [] });
    assert.equal(result.ok, true);
    assert.equal(result.updates.length, 0);
  });

  it('calls LLM and applies returned updates', async () => {
    const llmResponse = JSON.stringify({
      analysis: 'New carrier found',
      updates: [{
        action: 'create_file',
        path: 'transport/new-carrier.md',
        content: '# New Carrier\n\nInfo about carrier.',
        source: 'invoice.pdf',
        reason: 'New carrier not in KB',
      }],
    });
    const { registry, calls } = mockRegistry(llmResponse);
    const atlas = mockAtlas({ 'transport/carriers.md': '# Existing carriers' });
    const ke = new KnowledgeEngine(atlas, registry);

    const result = await ke.enrichFromExtraction(
      { entities: [{ entity_type: 'carriers', records: [{ id: 'NEW-1', name: 'NewCorp' }] }] },
      { source: 'invoice.pdf', date: '2026-03-05' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.analysis, 'New carrier found');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].user.includes('NewCorp'));
    assert.ok('transport/new-carrier.md' in atlas._store);
  });

  it('handles LLM returning no updates', async () => {
    const { registry } = mockRegistry('{"analysis":"All info present","updates":[]}');
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    const result = await ke.enrichFromExtraction(
      { entities: [{ entity_type: 'shipments', records: [{ id: 'S1' }] }] },
    );
    assert.equal(result.ok, true);
    assert.equal(result.updates.length, 0);
  });
});

// ─── enrichFromText ──────────────────────────────────────────────────────────

describe('KnowledgeEngine — enrichFromText', () => {
  it('returns error when not configured', async () => {
    const ke = new KnowledgeEngine(mockAtlas(), null);
    const result = await ke.enrichFromText('some text');
    assert.equal(result.ok, false);
  });

  it('sends text to LLM and returns result', async () => {
    const { registry, calls } = mockRegistry('{"analysis":"Noted","updates":[]}');
    const ke = new KnowledgeEngine(mockAtlas({ 'suppliers/main.md': '# Постачальники' }), registry);
    const result = await ke.enrichFromText(
      'Новий постачальник MedSupply, Польща',
      'manual test',
      'suppliers',
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].user.includes('MedSupply'));
    assert.ok(calls[0].user.includes('Постачальники'));
  });
});

// ─── _analyze — LLM error handling ──────────────────────────────────────────

describe('KnowledgeEngine — LLM error handling', () => {
  it('returns error on LLM call failure', async () => {
    const registry = {
      getFor() {
        return {
          isConfigured: () => true,
          async complete() { throw new Error('API timeout'); },
        };
      },
    };
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    const result = await ke.enrichFromText('test');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('LLM call failed'));
  });

  it('retries on invalid JSON and succeeds', async () => {
    let callCount = 0;
    const registry = {
      getFor() {
        return {
          isConfigured: () => true,
          async complete() {
            callCount++;
            if (callCount === 1) return { text: 'not json', usage: { input_tokens: 1, output_tokens: 1 } };
            return { text: '{"analysis":"retry ok","updates":[]}', usage: { input_tokens: 2, output_tokens: 2 } };
          },
        };
      },
    };
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    const result = await ke.enrichFromText('test');
    assert.equal(result.ok, true);
    assert.equal(result.analysis, 'retry ok');
    assert.equal(callCount, 2);
  });

  it('returns error after retry also fails', async () => {
    const registry = {
      getFor() {
        return {
          isConfigured: () => true,
          async complete() { return { text: 'still not json!!!', usage: { input_tokens: 1, output_tokens: 1 } }; },
        };
      },
    };
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    const result = await ke.enrichFromText('test');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('after retry'));
  });

  it('filters out invalid updates from LLM response', async () => {
    const llmResponse = JSON.stringify({
      analysis: 'test',
      updates: [
        { action: 'create_file', path: 'valid.md', content: '# Valid' },
        'not an object',
        { action: 'append_section' }, // missing path
        null,
        { path: 'missing-action.md' }, // missing action
      ],
    });
    const { registry } = mockRegistry(llmResponse);
    const atlas = mockAtlas({});
    const ke = new KnowledgeEngine(atlas, registry);
    const result = await ke.enrichFromText('test');

    assert.equal(result.ok, true);
    // Only the first valid update should be applied
    assert.equal(result.updates.length, 1);
    assert.equal(result.updates[0].applied, true);
  });

  it('handles LLM returning updates as non-array', async () => {
    const { registry } = mockRegistry('{"analysis":"ok","updates":"none"}');
    const ke = new KnowledgeEngine(mockAtlas(), registry);
    const result = await ke.enrichFromText('test');
    assert.equal(result.ok, true);
    assert.equal(result.updates.length, 0);
  });
});
