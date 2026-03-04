import { api }                  from '../lib/api.js';
import { $, on, esc, renderMarkdown } from '../lib/utils.js';

const html = `
<div class="page active" style="height:100vh;padding-bottom:1.5rem;">
  <div class="page-header" style="margin-bottom:1rem;">
    <div class="page-label">AI</div>
    <div class="page-title">AI Chat</div>
    <div class="page-sub">Ask questions about your logistics data</div>
  </div>
  <div class="chat-container">
    <div class="chat-messages" id="chatMessages">
      <div class="chat-empty" id="chatEmpty">
        <div>
          <div style="font-size:1.5rem;margin-bottom:0.5rem;">&#x25C9;</div>
          <div style="font-weight:600;color:var(--text);margin-bottom:0.3rem;">Ask anything about your data</div>
          <div>Try: "How many shipments do I have?" or "Find carriers in Germany"</div>
        </div>
      </div>
    </div>
    <div class="chat-input-area">
      <select class="chat-model-select" id="chatModelSelect" title="Choose AI model">
        <option value="">Default model</option>
      </select>
      <input type="text" class="chat-input" id="chatInput" placeholder="Ask about your logistics data..." />
      <button class="btn btn-primary" id="chatSendBtn">Send</button>
    </div>
  </div>
</div>`;

// --- state (persists across navigation — ES module singleton) ---
const messages = [];
const cleanups = [];

function render() {
  const container = $('#chatMessages');
  if (!container) return;
  const empty = $('#chatEmpty');

  if (!messages.length) {
    if (empty) empty.style.display = '';
    container.innerHTML = '';
    if (empty) container.appendChild(empty);
    return;
  }
  if (empty) empty.style.display = 'none';

  let out = '';
  for (const msg of messages) {
    if (msg.role === 'user') {
      out += `<div class="chat-msg user">${esc(msg.content).replace(/\n/g, '<br>')}</div>`;
      continue;
    }
    out += `<div class="chat-msg assistant"><div class="chat-md">${renderMarkdown(msg.content)}</div>`;
    if (msg.tool_calls?.length) {
      out += '<div class="chat-tools">';
      msg.tool_calls.forEach((tc, i) => {
        out += `<span class="chat-tool-badge" data-detail="tc-${msg._idx}-${i}">&#x2699; ${esc(tc.name)}</span>`;
      });
      out += '</div>';
      msg.tool_calls.forEach((tc, i) => {
        const argsStr = esc(JSON.stringify(tc.args, null, 2));
        let preview = tc.result;
        if (preview.length > 500) preview = preview.slice(0, 500) + '\n...';
        out += `<div class="chat-tool-detail" id="tc-${msg._idx}-${i}"><strong>Args:</strong>\n${argsStr}\n\n<strong>Result:</strong>\n${esc(preview)}</div>`;
      });
    }
    if (msg.usage) {
      out += `<div class="chat-usage">${msg.usage.input_tokens + msg.usage.output_tokens} tokens</div>`;
    }
    out += '</div>';
  }
  container.innerHTML = out;
  container.scrollTop = container.scrollHeight;
}

async function send() {
  const input = $('#chatInput');
  const btn   = $('#chatSendBtn');
  const text  = input.value.trim();
  if (!text) return;

  messages.push({ role: 'user', content: text });
  input.value = '';
  render();

  const container = $('#chatMessages');
  const typing = document.createElement('div');
  typing.className = 'chat-typing';
  typing.textContent = 'Thinking';
  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;

  btn.disabled = true;
  input.disabled = true;

  try {
    const apiMsgs = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    const modelSelect = $('#chatModelSelect');
    const selectedModel = modelSelect?.value || undefined;
    const data = await api.post('/api/chat', { messages: apiMsgs, model: selectedModel });
    typing.remove();

    messages.push({
      role: 'assistant',
      content: data.ok ? data.reply : `Error: ${data.error}`,
      tool_calls: data.ok ? data.tool_calls : undefined,
      usage: data.ok ? data.usage : undefined,
      _idx: messages.length,
    });
    render();
  } catch (e) {
    typing.remove();
    messages.push({ role: 'assistant', content: `Connection error: ${e.message}`, _idx: messages.length });
    render();
  } finally {
    btn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

async function loadModels() {
  try {
    const data = await api.get('/api/ai/models');
    const select = $('#chatModelSelect');
    if (!select || !data.models?.length) return;
    select.innerHTML = '<option value="">Default model</option>';
    const chatDefault = data.models.find(m => m.roles?.includes('chat'))
      ?? data.models.find(m => m.roles?.includes('default'));
    for (const m of data.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.id} (${m.model})`;
      select.appendChild(opt);
    }
    if (chatDefault) select.value = chatDefault.id;
  } catch { /* models endpoint not available — keep default option */ }
}

function init() {
  render();
  loadModels();

  // Send on Enter
  const input = $('#chatInput');
  const onKey = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  input.addEventListener('keydown', onKey);
  cleanups.push(() => input.removeEventListener('keydown', onKey));

  // Send button
  const btn = $('#chatSendBtn');
  btn.addEventListener('click', send);
  cleanups.push(() => btn.removeEventListener('click', send));

  // Tool badge toggle (event delegation)
  const container = $('#chatMessages');
  cleanups.push(on(container, 'click', '.chat-tool-badge', (_e, badge) => {
    const detail = $(`#${badge.dataset.detail}`);
    if (detail) detail.classList.toggle('open');
  }));

  input.focus();
}

function destroy() {
  cleanups.splice(0).forEach(fn => fn());
}

export default { html, init, destroy };
