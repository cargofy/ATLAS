import { api } from '../lib/api.js';
import { $, $$ } from '../lib/utils.js';

const html = `
<div class="page active" style="max-width:960px">
  <div class="page-header">
    <div class="page-label">Administration</div>
    <div class="page-title">Settings</div>
    <div class="page-sub">Edit the ATLAS configuration (config.yml). Changes are applied immediately on save.</div>
  </div>

  <div class="settings-tabs" id="settingsTabs">
    <button class="settings-tab active" data-tab="visual">Visual</button>
    <button class="settings-tab" data-tab="yaml">YAML</button>
  </div>

  <!-- Visual editor -->
  <div class="settings-panel active" id="panelVisual" data-panel="visual">

    <!-- General -->
    <div class="settings-section">
      <div class="settings-section-title">General</div>
      <div class="settings-row">
        <label>Instance name</label>
        <input type="text" id="cfg-name" class="settings-input" placeholder="ATLAS">
      </div>
      <div class="settings-row">
        <label>Port</label>
        <input type="number" id="cfg-port" class="settings-input settings-input-sm" placeholder="3000">
      </div>
      <div class="settings-row">
        <label>Database path</label>
        <input type="text" id="cfg-db" class="settings-input" placeholder="./atlas.db">
      </div>
    </div>

    <!-- AI -->
    <div class="settings-section">
      <div class="settings-section-title">AI Models</div>
      <div id="cfg-ai-models"></div>
      <button class="btn btn-sm btn-secondary" id="cfg-add-model" style="margin-top:0.5rem">+ Add model</button>
      <div class="settings-row" style="margin-top:1rem">
        <label>Role routing</label>
        <div style="display:flex;gap:0.75rem;flex-wrap:wrap">
          <div class="settings-mini-field"><span>default</span><input type="text" id="cfg-role-default" class="settings-input settings-input-sm" placeholder="model id"></div>
          <div class="settings-mini-field"><span>chat</span><input type="text" id="cfg-role-chat" class="settings-input settings-input-sm" placeholder="model id"></div>
          <div class="settings-mini-field"><span>extract</span><input type="text" id="cfg-role-extract" class="settings-input settings-input-sm" placeholder="model id"></div>
        </div>
      </div>
    </div>

    <!-- Auth -->
    <div class="settings-section">
      <div class="settings-section-title">Auth Tokens</div>
      <div id="cfg-tokens"></div>
      <button class="btn btn-sm btn-secondary" id="cfg-add-token" style="margin-top:0.5rem">+ Add token</button>
    </div>

    <!-- Connectors -->
    <div class="settings-section">
      <div class="settings-section-title">Connectors</div>
      <div id="cfg-connectors"></div>
      <button class="btn btn-sm btn-secondary" id="cfg-add-connector" style="margin-top:0.5rem">+ Add connector</button>
    </div>

    <div class="settings-actions">
      <button class="btn btn-primary" id="cfg-save-visual">Save &amp; Apply</button>
      <span class="settings-status" id="cfg-status-visual"></span>
    </div>
  </div>

  <!-- YAML editor -->
  <div class="settings-panel" id="panelYaml" data-panel="yaml">
    <textarea class="settings-yaml" id="cfg-yaml" spellcheck="false"></textarea>
    <div class="settings-actions">
      <button class="btn btn-primary" id="cfg-save-yaml">Save &amp; Apply</button>
      <span class="settings-status" id="cfg-status-yaml"></span>
    </div>
  </div>
</div>`;

let config = {};
let rawYaml = '';

// ── AI model row ──────────────────────────────────────────────────────────────

function renderModelRow(m, idx) {
  return `<div class="settings-card" data-model-idx="${idx}">
    <div class="settings-card-header">
      <span class="settings-card-title">Model: ${esc(m.id || 'new')}</span>
      <button class="btn btn-sm btn-secondary settings-remove-btn" data-remove-model="${idx}" style="color:var(--red)">Remove</button>
    </div>
    <div class="settings-card-body">
      <div class="settings-row-inline">
        <div class="settings-mini-field"><span>ID</span><input type="text" class="settings-input settings-input-sm" data-mf="${idx}" data-mk="id" value="${esc(m.id ?? '')}"></div>
        <div class="settings-mini-field"><span>Provider</span>
          <select class="settings-input settings-input-sm" data-mf="${idx}" data-mk="provider">
            <option value="claude"${m.provider === 'claude' ? ' selected' : ''}>claude</option>
            <option value="openai"${m.provider === 'openai' ? ' selected' : ''}>openai</option>
          </select>
        </div>
        <div class="settings-mini-field"><span>Model</span><input type="text" class="settings-input settings-input-sm" data-mf="${idx}" data-mk="model" value="${esc(m.model ?? '')}"></div>
      </div>
      <div class="settings-row-inline">
        <div class="settings-mini-field" style="flex:2"><span>API Key</span><input type="password" class="settings-input settings-input-sm" data-mf="${idx}" data-mk="api_key" value="${esc(m.api_key ?? '')}"></div>
        <div class="settings-mini-field"><span>Max tokens</span><input type="number" class="settings-input settings-input-sm" data-mf="${idx}" data-mk="max_tokens" value="${m.max_tokens ?? 4096}"></div>
      </div>
      <div class="settings-row-inline">
        <div class="settings-mini-field" style="flex:2"><span>Base URL (optional)</span><input type="text" class="settings-input settings-input-sm" data-mf="${idx}" data-mk="base_url" value="${esc(m.base_url ?? '')}" placeholder="https://..."></div>
      </div>
    </div>
  </div>`;
}

function renderTokenRow(t, idx) {
  return `<div class="settings-card" data-token-idx="${idx}">
    <div class="settings-card-header">
      <span class="settings-card-title">Token: ${esc(t.id || 'new')}</span>
      <button class="btn btn-sm btn-secondary settings-remove-btn" data-remove-token="${idx}" style="color:var(--red)">Remove</button>
    </div>
    <div class="settings-card-body">
      <div class="settings-row-inline">
        <div class="settings-mini-field"><span>ID</span><input type="text" class="settings-input settings-input-sm" data-tf="${idx}" data-tk="id" value="${esc(t.id ?? '')}"></div>
        <div class="settings-mini-field" style="flex:2"><span>Token</span><input type="text" class="settings-input settings-input-sm" data-tf="${idx}" data-tk="token" value="${esc(t.token ?? '')}"></div>
      </div>
      <div class="settings-row-inline">
        <div class="settings-mini-field" style="flex:2"><span>Permissions (comma-separated)</span><input type="text" class="settings-input settings-input-sm" data-tf="${idx}" data-tk="permissions" value="${esc((t.permissions ?? []).join(', '))}"></div>
      </div>
    </div>
  </div>`;
}

function renderConnectorRow(c, idx) {
  return `<div class="settings-card" data-conn-idx="${idx}">
    <div class="settings-card-header">
      <span class="settings-card-title">${esc(c.name || c.id || 'new')}</span>
      <div style="display:flex;gap:0.5rem;align-items:center">
        <label style="font-size:0.78rem;color:var(--muted);display:flex;align-items:center;gap:0.3rem">
          <input type="checkbox" data-cf="${idx}" data-ck="enabled" ${c.enabled !== false ? 'checked' : ''}> Enabled
        </label>
        <button class="btn btn-sm btn-secondary settings-remove-btn" data-remove-conn="${idx}" style="color:var(--red)">Remove</button>
      </div>
    </div>
    <div class="settings-card-body">
      <div class="settings-row-inline">
        <div class="settings-mini-field"><span>ID</span><input type="text" class="settings-input settings-input-sm" data-cf="${idx}" data-ck="id" value="${esc(c.id ?? '')}"></div>
        <div class="settings-mini-field"><span>Type</span>
          <select class="settings-input settings-input-sm" data-cf="${idx}" data-ck="type">
            <option value="rest_api"${c.type === 'rest_api' ? ' selected' : ''}>rest_api</option>
            <option value="ai_extract"${c.type === 'ai_extract' ? ' selected' : ''}>ai_extract</option>
          </select>
        </div>
        <div class="settings-mini-field"><span>Entity</span><input type="text" class="settings-input settings-input-sm" data-cf="${idx}" data-ck="entity" value="${esc(c.entity ?? '')}"></div>
      </div>
      <div class="settings-row-inline">
        <div class="settings-mini-field" style="flex:1"><span>Name</span><input type="text" class="settings-input settings-input-sm" data-cf="${idx}" data-ck="name" value="${esc(c.name ?? '')}"></div>
        <div class="settings-mini-field" style="flex:2"><span>Endpoint</span><input type="text" class="settings-input settings-input-sm" data-cf="${idx}" data-ck="endpoint" value="${esc(c.endpoint ?? '')}" placeholder="https://..."></div>
      </div>
      <div class="settings-row-inline">
        <div class="settings-mini-field"><span>Sync interval (min)</span><input type="number" class="settings-input settings-input-sm" data-cf="${idx}" data-ck="interval" value="${c.sync?.interval_minutes ?? 15}"></div>
      </div>
    </div>
  </div>`;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Populate visual form from config ──────────────────────────────────────────

function populateVisual() {
  $('#cfg-name').value = config.atlas?.name ?? '';
  $('#cfg-port').value = config.atlas?.port ?? 3000;
  $('#cfg-db').value = config.storage?.path ?? './atlas.db';

  // AI models
  const models = config.ai?.models ?? [];
  $('#cfg-ai-models').innerHTML = models.map((m, i) => renderModelRow(m, i)).join('');
  $('#cfg-role-default').value = config.ai?.default ?? '';
  $('#cfg-role-chat').value = config.ai?.chat ?? '';
  $('#cfg-role-extract').value = config.ai?.extract ?? '';

  // Tokens
  const tokens = config.auth?.tokens ?? [];
  $('#cfg-tokens').innerHTML = tokens.map((t, i) => renderTokenRow(t, i)).join('');

  // Connectors
  const conns = config.connectors ?? [];
  $('#cfg-connectors').innerHTML = conns.map((c, i) => renderConnectorRow(c, i)).join('');

  bindRemoveButtons();
}

function bindRemoveButtons() {
  for (const btn of $$('[data-remove-model]')) {
    btn.addEventListener('click', () => {
      const models = config.ai?.models ?? [];
      models.splice(parseInt(btn.dataset.removeModel), 1);
      populateVisual();
    });
  }
  for (const btn of $$('[data-remove-token]')) {
    btn.addEventListener('click', () => {
      const tokens = config.auth?.tokens ?? [];
      tokens.splice(parseInt(btn.dataset.removeToken), 1);
      populateVisual();
    });
  }
  for (const btn of $$('[data-remove-conn]')) {
    btn.addEventListener('click', () => {
      const conns = config.connectors ?? [];
      conns.splice(parseInt(btn.dataset.removeConn), 1);
      populateVisual();
    });
  }
}

// ── Read visual form back into config ─────────────────────────────────────────

function readVisualToConfig() {
  const c = JSON.parse(JSON.stringify(config)); // deep clone — preserves fields not in form

  c.atlas = { ...(c.atlas ?? {}), name: $('#cfg-name').value || 'ATLAS', port: parseInt($('#cfg-port').value) || 3000 };
  c.storage = { ...(c.storage ?? {}), path: $('#cfg-db').value || './atlas.db' };

  // AI models — merge form values into existing model objects (preserves extra keys)
  const origModels = c.ai?.models ?? [];
  const modelEls = $$('[data-model-idx]');
  const models = [];
  for (const card of modelEls) {
    const idx = parseInt(card.dataset.modelIdx);
    const base = origModels[idx] ? { ...origModels[idx] } : {};
    for (const inp of card.querySelectorAll('[data-mk]')) {
      const key = inp.dataset.mk;
      let val = inp.value;
      if (key === 'max_tokens') val = parseInt(val) || 4096;
      if (val === '' && key === 'base_url') { delete base[key]; continue; }
      if (val !== '' && val !== 0) base[key] = val;
    }
    if (base.id) models.push(base);
  }
  c.ai = {
    ...(c.ai ?? {}),
    models,
    default: $('#cfg-role-default').value || undefined,
    chat: $('#cfg-role-chat').value || undefined,
    extract: $('#cfg-role-extract').value || undefined,
  };

  // Tokens — merge
  const origTokens = c.auth?.tokens ?? [];
  const tokenEls = $$('[data-token-idx]');
  const tokens = [];
  for (const card of tokenEls) {
    const idx = parseInt(card.dataset.tokenIdx);
    const base = origTokens[idx] ? { ...origTokens[idx] } : {};
    for (const inp of card.querySelectorAll('[data-tk]')) {
      const key = inp.dataset.tk;
      if (key === 'permissions') {
        base.permissions = inp.value.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        base[key] = inp.value;
      }
    }
    if (base.id && base.token) tokens.push(base);
  }
  if (tokens.length) c.auth = { ...(c.auth ?? {}), tokens };
  else delete c.auth;

  // Connectors — merge
  const origConns = c.connectors ?? [];
  const connEls = $$('[data-conn-idx]');
  const conns = [];
  for (const card of connEls) {
    const idx = parseInt(card.dataset.connIdx);
    const base = origConns[idx] ? { ...origConns[idx] } : {};
    for (const inp of card.querySelectorAll('[data-ck]')) {
      const key = inp.dataset.ck;
      if (key === 'enabled') { base.enabled = inp.checked; continue; }
      if (key === 'interval') { base.sync = { ...(base.sync ?? {}), interval_minutes: parseInt(inp.value) || 15 }; continue; }
      if (inp.value !== '') base[key] = inp.value;
    }
    if (base.id) conns.push(base);
  }
  if (conns.length) c.connectors = conns;
  else delete c.connectors;

  return c;
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function saveVisual() {
  const btn = $('#cfg-save-visual');
  const status = $('#cfg-status-visual');
  btn.disabled = true; btn.textContent = 'Saving\u2026';
  status.textContent = ''; status.className = 'settings-status';
  try {
    // Convert config object to YAML string via a round-trip
    const c = readVisualToConfig();
    // We need YAML lib on the server side, so send as object and let server serialize
    // Actually we have a YAML endpoint that expects raw yaml. Let's build YAML client-side minimally,
    // or use the setup/save endpoint which accepts JSON and writes YAML.
    await api.post('/api/setup/save', c);
    // Re-read to get server-serialized YAML and canonical config
    try {
      const fresh = await api.get('/api/config');
      rawYaml = fresh.yaml;
      config = fresh.config ?? c;
      const yamlEl = $('#cfg-yaml');
      if (yamlEl) yamlEl.value = rawYaml;
    } catch {
      config = c;
    }
    status.textContent = 'Saved!';
    status.className = 'settings-status success';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'settings-status error';
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Apply';
  }
}

async function saveYaml() {
  const btn = $('#cfg-save-yaml');
  const status = $('#cfg-status-yaml');
  btn.disabled = true; btn.textContent = 'Saving\u2026';
  status.textContent = ''; status.className = 'settings-status';
  try {
    const yaml = $('#cfg-yaml').value;
    await api.post('/api/config', { yaml });
    // Refresh state
    const fresh = await api.get('/api/config');
    rawYaml = fresh.yaml;
    config = fresh.config;
    populateVisual();
    status.textContent = 'Saved!';
    status.className = 'settings-status success';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'settings-status error';
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Apply';
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tab) {
  for (const t of $$('.settings-tab')) t.classList.toggle('active', t.dataset.tab === tab);
  for (const p of $$('.settings-panel')) p.classList.toggle('active', p.dataset.panel === tab);
  if (tab === 'yaml') {
    // Sync visual → yaml before showing
    $('#cfg-yaml').value = rawYaml;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const data = await api.get('/api/config');
    config = data.config ?? {};
    rawYaml = data.yaml ?? '';
  } catch {
    config = {};
    rawYaml = '';
  }
  populateVisual();
  $('#cfg-yaml').value = rawYaml;
}

export default {
  html,
  init() {
    // Tab switching
    for (const t of $$('.settings-tab')) {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    }

    // Save buttons
    $('#cfg-save-visual')?.addEventListener('click', saveVisual);
    $('#cfg-save-yaml')?.addEventListener('click', saveYaml);

    // Add buttons
    $('#cfg-add-model')?.addEventListener('click', () => {
      if (!config.ai) config.ai = { models: [] };
      if (!config.ai.models) config.ai.models = [];
      config.ai.models.push({ id: '', provider: 'openai', model: '', api_key: '', max_tokens: 4096 });
      populateVisual();
    });
    $('#cfg-add-token')?.addEventListener('click', () => {
      if (!config.auth) config.auth = { tokens: [] };
      if (!config.auth.tokens) config.auth.tokens = [];
      config.auth.tokens.push({ id: '', token: '', permissions: ['read'] });
      populateVisual();
    });
    $('#cfg-add-connector')?.addEventListener('click', () => {
      if (!config.connectors) config.connectors = [];
      config.connectors.push({ id: '', type: 'rest_api', name: '', entity: '', endpoint: '', enabled: false, sync: { interval_minutes: 15 } });
      populateVisual();
    });

    loadConfig();
  },
  destroy() {},
};
