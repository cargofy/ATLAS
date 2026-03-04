import { api }       from '../lib/api.js';
import { $, $$ }     from '../lib/utils.js';

const STEPS = ['Welcome', 'AI Setup', 'Security', 'Done'];

const DEFAULT_MODELS = {
  openai: 'gpt-4o',
  claude: 'claude-sonnet-4-20250514',
  ollama: 'llama3.2',
};

const html = `
<div class="setup-page">
  <div class="setup-wizard">
    <div class="setup-logo">
      <div class="setup-logo-text">ATLAS <span>Setup</span></div>
      <div class="setup-logo-sub">First-run configuration wizard</div>
    </div>

    <div class="setup-stepper" id="setup-stepper">
      ${STEPS.map((s, i) => `
        <div class="setup-step${i === 0 ? ' active' : ''}" data-step="${i}">
          ${i > 0 ? '<div class="setup-step-line"></div>' : ''}
          <div class="setup-step-circle">${i + 1}</div>
        </div>
      `).join('')}
    </div>

    <!-- Step 0: Welcome -->
    <div class="setup-panel active" data-panel="0">
      <h2>Welcome to ATLAS</h2>
      <p class="setup-desc">Let's configure your instance. You can always change these settings later in <code>config.yml</code>.</p>
      <div class="setup-field">
        <label>Instance name</label>
        <input type="text" id="setup-name" placeholder="My Logistics Hub" value="ATLAS">
      </div>
      <div class="setup-field">
        <label>Port</label>
        <input type="number" id="setup-port" placeholder="3000" value="3000">
      </div>
      <div class="setup-actions">
        <span></span>
        <button class="btn btn-primary" id="setup-next-0">Next</button>
      </div>
    </div>

    <!-- Step 1: AI Setup -->
    <div class="setup-panel" data-panel="1">
      <h2>AI Provider</h2>
      <p class="setup-desc">Connect an LLM for AI-powered extraction and chat. You can skip this and add it later.</p>
      <div class="setup-field">
        <label>Provider</label>
        <select id="setup-provider">
          <option value="skip">Skip (no AI)</option>
          <option value="openai">OpenAI</option>
          <option value="claude">Anthropic Claude</option>
          <option value="ollama">Ollama (local)</option>
        </select>
      </div>
      <div id="ai-fields" style="display:none">
        <div class="setup-field" id="ai-key-field">
          <label>API Key</label>
          <input type="password" id="setup-ai-key" placeholder="sk-...">
        </div>
        <div class="setup-field">
          <label>Model</label>
          <input type="text" id="setup-ai-model" placeholder="gpt-4o">
        </div>
        <div class="setup-field" id="ai-url-field" style="display:none">
          <label>Base URL</label>
          <input type="text" id="setup-ai-url" placeholder="http://localhost:11434/v1">
        </div>
        <button class="btn btn-secondary btn-sm" id="setup-test-ai">Test Connection</button>
        <div class="setup-test-result" id="setup-test-result"></div>
      </div>
      <div class="setup-actions">
        <button class="btn btn-secondary" id="setup-back-1">Back</button>
        <button class="btn btn-primary" id="setup-next-1">Next</button>
      </div>
    </div>

    <!-- Step 2: Security -->
    <div class="setup-panel" data-panel="2">
      <h2>Security</h2>
      <p class="setup-desc">Optionally add a bearer token to protect MCP endpoints. Leave blank for open access (dev mode).</p>
      <div class="setup-field">
        <label>Bearer Token</label>
        <div class="setup-token-row">
          <input type="text" id="setup-token" placeholder="Leave empty for open access">
          <button class="btn btn-secondary btn-sm" id="setup-gen-token">Generate</button>
        </div>
      </div>
      <div class="setup-actions">
        <button class="btn btn-secondary" id="setup-back-2">Back</button>
        <button class="btn btn-primary" id="setup-next-2">Next</button>
      </div>
    </div>

    <!-- Step 3: Done -->
    <div class="setup-panel" data-panel="3">
      <h2>Review &amp; Save</h2>
      <p class="setup-desc">Here's your configuration. Click "Save &amp; Launch" to write <code>config.yml</code> and start ATLAS.</p>
      <dl class="setup-summary" id="setup-summary"></dl>
      <div class="setup-actions">
        <button class="btn btn-secondary" id="setup-back-3">Back</button>
        <button class="btn btn-primary" id="setup-save">Save &amp; Launch</button>
      </div>
    </div>
  </div>
</div>`;

let currentStep = 0;

function goToStep(n) {
  currentStep = n;
  $$('[data-panel]').forEach(p => p.classList.remove('active'));
  const panel = $(`[data-panel="${n}"]`);
  if (panel) panel.classList.add('active');

  $$('.setup-step').forEach((s, i) => {
    s.classList.remove('active', 'completed');
    if (i < n) s.classList.add('completed');
    else if (i === n) s.classList.add('active');
  });

  if (n === 3) renderSummary();
}

function onProviderChange() {
  const val = $('#setup-provider').value;
  const show = val !== 'skip';
  $('#ai-fields').style.display = show ? 'block' : 'none';
  if (show) {
    $('#setup-ai-model').value = DEFAULT_MODELS[val] ?? '';
    $('#ai-url-field').style.display = val === 'ollama' ? 'block' : 'none';
    $('#ai-key-field').style.display = val === 'ollama' ? 'none' : 'block';
    if (val === 'ollama') {
      $('#setup-ai-url').value = 'http://localhost:11434/v1';
      $('#setup-ai-key').value = 'ollama';
    } else {
      $('#setup-ai-url').value = '';
      if ($('#setup-ai-key').value === 'ollama') $('#setup-ai-key').value = '';
    }
  }
  // Reset test result
  const r = $('#setup-test-result');
  r.className = 'setup-test-result';
  r.textContent = '';
}

async function testAi() {
  const btn = $('#setup-test-ai');
  const res = $('#setup-test-result');
  const provider = $('#setup-provider').value;
  btn.disabled = true;
  btn.textContent = 'Testing\u2026';
  res.className = 'setup-test-result';
  res.textContent = '';

  try {
    const payload = {
      provider,
      api_key: $('#setup-ai-key').value,
      model: $('#setup-ai-model').value,
      base_url: $('#setup-ai-url').value || undefined,
    };
    const data = await api.post('/api/setup/test-ai', payload);
    if (data.ok) {
      res.className = 'setup-test-result success';
      res.textContent = 'Connection successful!';
    } else {
      res.className = 'setup-test-result error';
      res.textContent = data.error || 'Connection failed';
    }
  } catch (e) {
    res.className = 'setup-test-result error';
    res.textContent = e.message || 'Connection failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

function generateToken() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  $('#setup-token').value = hex;
}

function renderSummary() {
  const name = $('#setup-name').value || 'ATLAS';
  const port = $('#setup-port').value || '3000';
  const provider = $('#setup-provider').value;
  const model = $('#setup-ai-model')?.value || '';
  const token = $('#setup-token').value;

  let aiText = 'Skipped';
  if (provider !== 'skip') {
    aiText = `${provider} / ${model}`;
  }

  $('#setup-summary').innerHTML = `
    <dt>Instance Name</dt><dd>${esc(name)}</dd>
    <dt>Port</dt><dd>${esc(port)}</dd>
    <dt>AI Provider</dt><dd>${esc(aiText)}</dd>
    <dt>Auth Token</dt><dd>${token ? esc(token.slice(0, 8)) + '\u2026' : 'None (open access)'}</dd>
  `;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildConfig() {
  const name = $('#setup-name').value || 'ATLAS';
  const port = parseInt($('#setup-port').value) || 3000;
  const provider = $('#setup-provider').value;
  const token = $('#setup-token').value;

  const config = {
    atlas: { name, port },
    storage: { path: './atlas.db' },
  };

  if (provider !== 'skip') {
    const model = $('#setup-ai-model').value || DEFAULT_MODELS[provider];
    const entry = {
      id: provider,
      provider: provider === 'claude' ? 'claude' : 'openai',
      model,
      api_key: $('#setup-ai-key').value,
    };
    const baseUrl = $('#setup-ai-url').value;
    if (baseUrl) entry.base_url = baseUrl;

    config.ai = {
      models: [entry],
      default: provider,
      chat: provider,
      extract: provider,
    };
  }

  if (token) {
    config.auth = {
      tokens: [{ id: 'default', token, permissions: ['*'] }],
    };
  }

  return config;
}

async function saveAndLaunch() {
  const btn = $('#setup-save');
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';
  try {
    const config = buildConfig();
    await api.post('/api/setup/save', config);
    location.reload();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Save & Launch';
    alert('Save failed: ' + e.message);
  }
}

function init() {
  currentStep = 0;

  // Navigation
  $('#setup-next-0')?.addEventListener('click', () => goToStep(1));
  $('#setup-next-1')?.addEventListener('click', () => goToStep(2));
  $('#setup-next-2')?.addEventListener('click', () => goToStep(3));
  $('#setup-back-1')?.addEventListener('click', () => goToStep(0));
  $('#setup-back-2')?.addEventListener('click', () => goToStep(1));
  $('#setup-back-3')?.addEventListener('click', () => goToStep(2));

  // AI provider
  $('#setup-provider')?.addEventListener('change', onProviderChange);
  $('#setup-test-ai')?.addEventListener('click', testAi);

  // Security
  $('#setup-gen-token')?.addEventListener('click', generateToken);

  // Save
  $('#setup-save')?.addEventListener('click', saveAndLaunch);
}

function destroy() {}

export default { html, init, destroy };
