import { Router }  from './lib/router.js';
import { $, on }   from './lib/utils.js';
import { api }     from './lib/api.js';

import dashboard   from './pages/dashboard.js';
import connectors  from './pages/connectors.js';
import explorer    from './pages/explorer.js';
import playground  from './pages/playground.js';
import chat        from './pages/chat.js';
import importPage  from './pages/import.js';
import knowledge   from './pages/knowledge.js';
import settings    from './pages/settings.js';
import setup       from './pages/setup.js';

const router = new Router($('#page-content'));

router
  .add('dashboard',   dashboard)
  .add('connectors',  connectors)
  .add('explorer',    explorer)
  .add('playground',  playground)
  .add('chat',        chat)
  .add('knowledge',   knowledge)
  .add('import',      importPage)
  .add('settings',    settings)
  .add('setup',       setup);

// Nav clicks — event delegation, no inline handlers
on($('.sidebar'), 'click', '[data-page]', (_e, item) => {
  router.navigate(item.dataset.page);
});

// When import/seed loads data, the next visit to dashboard picks it up automatically
// (dashboard.init() always fetches fresh). No cross-page coupling needed.

(async () => {
  try {
    const { needsSetup } = await api.get('/api/setup/status');
    if (needsSetup) {
      const sidebar = $('.sidebar');
      if (sidebar) sidebar.style.display = 'none';
      router.start('setup');
      return;
    }
  } catch {}
  router.start('dashboard');
})();
