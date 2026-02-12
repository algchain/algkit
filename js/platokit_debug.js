/**
 * @platokit-cap
 * name: debug
 * kind: debug
 * type: module
 * version: 1.0.0
 * author: panamantis
 * description: WebSocket debug bridge for PlatoKit hub/cap/skin system
 */
const PlatoKitebug = {
  ws: null,
  wsUrl: 'ws://localhost:8765',
  connected: false,
  eventLog: [],
  messageLog: [],
  maxLog: 500,
  breakpoints: new Set(),
  panel: null,
  panelVisible: false,

  // ─────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────
  init() {
    this.hookEvents();
    this.hookMessages();
    this.createPanel();
    this.initHashAPI();
    this.connectWS();
    console.log('[PlatoKitebug] Ready. Press D to toggle panel.');
    // Run diagnostics after a short delay so hub has time to init
    setTimeout(() => {
      const diag = this.diagnose();
      console.log('[PlatoKitebug] Diagnostics:');
      diag.forEach(d => console.log('  ' + d));
    }, 1500);
  },

  // ─────────────────────────────────────────────
  // WEBSOCKET
  // ─────────────────────────────────────────────
  connectWS() {
    const hashMatch = location.hash.match(/ws=([^&]+)/);
    if (hashMatch) this.wsUrl = `ws://${hashMatch[1]}`;

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        this.send({ type: 'hello', url: location.href, ua: navigator.userAgent });
        this.updatePanel();
        console.log('[PlatoKitebug] Connected to debugger at', this.wsUrl);
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.updatePanel();
        console.log('[PlatoKitebug] Disconnected. To start server: python dev/platokit_debugger.py');
        setTimeout(() => this.connectWS(), 3000);
      };
      this.ws.onmessage = (e) => this.handleCommand(JSON.parse(e.data));
      this.ws.onerror = () => {};
    } catch (e) {}
  },

  send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  },

  // ─────────────────────────────────────────────
  // COMMAND HANDLER
  // ─────────────────────────────────────────────
  handleCommand(cmd) {
    console.log('[PlatoKitebug] Cmd:', cmd.cmd);
    const handlers = {
      get_state: () => this.send({ type: 'state', ...this.getFullState() }),
      inject_message: () => this.injectMessage(cmd.kind, cmd.payload, cmd.target),
      simulate_drop: () => this.simulateDrop(cmd.tile, cmd.content, cmd.filename),
      highlight: () => this.highlight(cmd.selector),
      run_script: () => this.runScript(cmd.script),
      set_breakpoint: () => { this.breakpoints.add(cmd.kind); console.log('[PlatoKitebug] Breakpoint:', cmd.kind); },
      clear_breakpoints: () => { this.breakpoints.clear(); console.log('[PlatoKitebug] Breakpoints cleared'); },
      set_url: () => this.setUrl(cmd.params),
      get_logs: () => this.send({ type: 'logs', events: this.eventLog.slice(-50), messages: this.messageLog.slice(-50) }),
      pong: () => console.log('[PlatoKitebug] Pong received')
    };
    (handlers[cmd.cmd] || (() => console.warn('[PlatoKitebug] Unknown:', cmd.cmd)))();
  },

  // ─────────────────────────────────────────────
  // EVENT HOOKS
  // ─────────────────────────────────────────────
  hookEvents() {
    ['dragenter', 'dragover', 'dragleave', 'drop', 'click'].forEach(name => {
      window.addEventListener(name, (e) => {
        const entry = {
          name, ts: Date.now(),
          target: this.describeEl(e.target),
          x: e.clientX, y: e.clientY
        };
        this.eventLog.push(entry);
        if (this.eventLog.length > this.maxLog) this.eventLog.shift();
        if (name === 'drop' || name === 'click') {
          this.send({ type: 'event', ...entry });
        }
        this.updatePanel();
      }, true);
    });
  },

  hookMessages() {
    const origPost = window.postMessage.bind(window);
    window.postMessage = (msg, origin) => {
      this.logMessage('out', msg);
      return origPost(msg, origin);
    };
    window.addEventListener('message', (e) => this.logMessage('in', e.data, e.origin));
  },

  logMessage(direction, data, origin) {
    const entry = {
      direction, ts: Date.now(),
      kind: data?.kind || '(none)',
      data, origin
    };
    this.messageLog.push(entry);
    if (this.messageLog.length > this.maxLog) this.messageLog.shift();
    this.send({ type: 'message', direction, kind: entry.kind });
    if (this.breakpoints.has(entry.kind)) debugger;
    this.updatePanel();
  },

  describeEl(el) {
    if (!el || !el.tagName) return '(none)';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') s += '.' + el.className.split(' ')[0];
    return s;
  },

  // ─────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────
  getFullState() {
    const H = typeof PlatoKit !== 'undefined' ? PlatoKit : null;
    const hub = H ? { registry: H.registry, state: H.state } : null;
    const tiles = [...document.querySelectorAll('.tile')].map(t => ({
      id: t.id,
      iframe: !!t.querySelector('iframe'),
      src: t.querySelector('iframe')?.src || null
    }));
    const skin = H?.Skin ? {
      enabled: H.Skin.isEnabled(),
      ready: H.Skin.isReady(),
      frame: !!H.Skin.getFrame(),
      frameVisible: H.Skin.getFrame()?.style.display !== 'none'
    } : null;
    const eventBus = H?.EventBus ? {
      topics: H.EventBus.listTopics()
    } : null;
    const services = H?.Capabilities ? H.Capabilities.getServiceList() : [];
    return {
      hub, tiles, skin, eventBus, services,
      url: location.href,
      protocol: location.protocol,
      params: Object.fromEntries(new URLSearchParams(location.search))
    };
  },

  // ─────────────────────────────────────────────
  // DIAGNOSTICS (auto-check common issues)
  // ─────────────────────────────────────────────
  diagnose() {
    const issues = [];
    const H = typeof PlatoKit !== 'undefined' ? PlatoKit : null;
    if (!H) { issues.push('PlatoKit not found - hub may not have loaded'); return issues; }

    // Skin checks
    const params = Object.fromEntries(new URLSearchParams(location.search));
    if (params.skin && params.skin.toLowerCase() === 'true') {
      if (!H.Skin.isEnabled()) issues.push('SKIN: param set but skin not enabled - spawn may have failed');
      else if (!H.Skin.getFrame()) issues.push('SKIN: enabled but no iframe found');
      else if (H.Skin.getFrame().style.display === 'none') issues.push('SKIN: iframe hidden (toggled off?)');
      else if (!H.Skin.isReady()) issues.push('SKIN: iframe exists but not ready (skin_action "ready" not received)');
      else issues.push('SKIN: OK - enabled, frame present, ready');
    }

    // Tile checks
    const tileCount = document.querySelectorAll('.tile').length;
    const loadedCount = document.querySelectorAll('.tile iframe').length;
    issues.push(`TILES: ${loadedCount} loaded / ${tileCount} total`);

    // Protocol
    if (location.protocol === 'file:') issues.push('PROTO: file:// - fetch/CORS limited, use cors_server.py for full features');

    // Storage
    try { localStorage.setItem('_dbg_test', '1'); localStorage.removeItem('_dbg_test'); }
    catch (e) { issues.push('STORAGE: localStorage blocked'); }

    // Event bus
    if (H.EventBus) {
      const topics = H.EventBus.listTopics();
      issues.push(`BUS: ${topics.length} active topic(s)${topics.length ? ': ' + topics.map(t => t.topic || t).join(', ') : ''}`);
    }

    return issues;
  },

  // ─────────────────────────────────────────────
  // ACTIONS
  // ─────────────────────────────────────────────
  injectMessage(kind, payload = {}, target) {
    const msg = { kind, ...payload };
    if (target) {
      const iframe = document.querySelector(`#${target} iframe, iframe[name="${target}"]`);
      iframe?.contentWindow?.postMessage(msg, '*');
    } else {
      window.postMessage(msg, '*');
    }
    console.log('[PlatoKitebug] Injected:', kind);
  },

  simulateDrop(tileId, content, filename = 'test.html') {
    const file = new File([content || '<html><body>Test Cap</body></html>'], filename, { type: 'text/html' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const tile = tileId ? document.getElementById(tileId) : document.querySelector('.tile');
    if (!tile) { console.warn('[PlatoKitebug] No tile found'); return; }
    const rect = tile.getBoundingClientRect();
    const dropEvent = new DragEvent('drop', {
      dataTransfer: dt, bubbles: true,
      clientX: rect.x + 50, clientY: rect.y + 50
    });
    document.dispatchEvent(dropEvent);
    console.log('[PlatoKitebug] Simulated drop on', tile.id || 'first tile');
  },

  highlight(selector) {
    document.querySelectorAll('._dbg-hl').forEach(el => { el.classList.remove('_dbg-hl'); el.style.outline = ''; });
    document.querySelectorAll(selector).forEach(el => { el.classList.add('_dbg-hl'); el.style.outline = '3px solid magenta'; });
  },

  runScript(script) {
    try {
      const result = eval(script);
      this.send({ type: 'script_result', script, result: String(result), success: true });
      console.log('[PlatoKitebug] Script result:', result);
    } catch (e) {
      this.send({ type: 'script_result', script, error: e.message, success: false });
      console.error('[PlatoKitebug] Script error:', e.message);
    }
  },

  setUrl(params) {
    // Rebuild URL with new params, preserving debug
    const base = location.pathname;
    let newParams = params || '';
    if (newParams && !newParams.includes('debug')) {
      newParams += '&debug=1';
    } else if (!newParams) {
      newParams = 'debug=1';
    }
    const newUrl = base + '?' + newParams;
    console.log('[PlatoKitebug] Navigating to:', newUrl);
    location.href = newUrl;
  },

  // ─────────────────────────────────────────────
  // HASH API (file:// fallback)
  // ─────────────────────────────────────────────
  initHashAPI() {
    window.addEventListener('hashchange', () => this.handleHash());
    this.handleHash();
  },

  handleHash() {
    const hash = location.hash;
    if (!hash.startsWith('#/api/')) return;
    const path = hash.slice(6);
    const routes = {
      state: () => this.getFullState(),
      events: () => this.eventLog.slice(-20),
      messages: () => this.messageLog.slice(-20),
      tiles: () => [...document.querySelectorAll('.tile')].map(t => t.id),
      caps: () => typeof PlatoKit !== 'undefined' ? Object.keys(PlatoKit.registry || {}) : []
    };
    const result = routes[path]?.() || { error: 'Unknown: ' + path };
    console.log(`[PlatoKitebug API] ${path}:`, result);
  },

  // ─────────────────────────────────────────────
  // DEBUG PANEL
  // ─────────────────────────────────────────────
  createPanel() {
    const css = `
      #_dbg{position:fixed;bottom:10px;right:10px;width:380px;max-height:45vh;background:#1a1a2e;color:#eee;
        font:11px monospace;border:1px solid #444;border-radius:4px;z-index:999999;display:none;overflow:hidden}
      #_dbg.vis{display:block}
      #_dbg-hdr{background:#16213e;padding:5px 8px;display:flex;justify-content:space-between}
      #_dbg-hdr .on{color:#0f0}#_dbg-hdr .off{color:#f66}
      #_dbg-tabs{display:flex;background:#0f3460}
      #_dbg-tabs button{flex:1;padding:4px;border:none;background:transparent;color:#888;cursor:pointer;font-size:10px}
      #_dbg-tabs button.act{background:#1a1a2e;color:#fff}
      #_dbg-body{padding:6px;overflow-y:auto;max-height:32vh}
      ._row{padding:2px 0;border-bottom:1px solid #333}
      ._in{color:#4f4}._out{color:#f66}
      #_dbg button{margin:2px;padding:3px 6px;background:#0f3460;border:none;color:#fff;cursor:pointer;border-radius:2px}
    `;
    this.panel = document.createElement('div');
    this.panel.id = '_dbg';
    // Small toggle button always visible
    const toggle = document.createElement('div');
    toggle.id = '_dbg-toggle';
    toggle.innerHTML = '🔧';
    toggle.title = 'Toggle Debug Panel (D)';
    toggle.style.cssText = 'position:fixed;bottom:10px;right:10px;width:28px;height:28px;background:#0f3460;color:#fff;border-radius:50%;cursor:pointer;z-index:9999999;display:flex;align-items:center;justify-content:center;font-size:14px;opacity:0.7;';
    toggle.onclick = () => this.togglePanel();
    toggle.onmouseenter = () => toggle.style.opacity = '1';
    toggle.onmouseleave = () => toggle.style.opacity = '0.7';
    document.body.appendChild(toggle);
    this.toggle = toggle;

    this.panel.innerHTML = `<style>${css}</style>
      <div id="_dbg-hdr"><span>PlatoKitebug</span><span id="_dbg-ws" class="off">disconnected</span></div>
      <div id="_dbg-tabs">
        <button class="act" data-t="diag">Diag</button>
        <button data-t="events">Events</button>
        <button data-t="messages">Msgs</button>
        <button data-t="state">State</button>
        <button data-t="actions">Actions</button>
      </div>
      <div id="_dbg-body"></div>`;
    document.body.appendChild(this.panel);

    this.panel.querySelectorAll('[data-t]').forEach(btn => {
      btn.onclick = () => {
        this.panel.querySelectorAll('[data-t]').forEach(b => b.classList.remove('act'));
        btn.classList.add('act');
        this.updatePanel();
      };
    });

    // D key to toggle - use capture phase to catch before iframes
    document.addEventListener('keydown', (e) => {
      if (e.key === 'D' && !e.target.matches('input,textarea')) this.togglePanel();
    }, true);
    // Also listen on window for when iframes have focus
    window.addEventListener('keydown', (e) => {
      if (e.key === 'D' && !e.target.matches('input,textarea')) this.togglePanel();
    }, true);
    // Click on status bar to toggle (works even if keys don't)
    this.panel.querySelector('#_dbg-hdr').onclick = () => this.togglePanel();
  },

  togglePanel() {
    this.panelVisible = !this.panelVisible;
    this.panel.classList.toggle('vis', this.panelVisible);
    if (this.toggle) this.toggle.style.display = this.panelVisible ? 'none' : 'flex';
    if (this.panelVisible) this.updatePanel();
  },

  updatePanel() {
    if (!this.panelVisible) return;
    const ws = this.panel.querySelector('#_dbg-ws');
    ws.textContent = this.connected ? 'connected' : 'python dev/platokit_debugger.py';
    ws.className = this.connected ? 'on' : 'off';
    ws.title = this.connected ? 'Connected to debugger' : 'Run: python dev/platokit_debugger.py';

    const body = this.panel.querySelector('#_dbg-body');
    const tab = this.panel.querySelector('[data-t].act')?.dataset.t;

    if (tab === 'diag') {
      const issues = this.diagnose();
      body.innerHTML = issues.map(i => {
        const c = i.startsWith('SKIN: OK') || i.includes('loaded') ? '_in' : (i.includes('not') || i.includes('blocked') || i.includes('failed') ? '_out' : '');
        return `<div class="_row ${c}">${i}</div>`;
      }).join('') + '<br><button onclick="PlatoKitebug.updatePanel()">Refresh</button>';
    } else if (tab === 'events') {
      body.innerHTML = this.eventLog.slice(-12).reverse()
        .map(e => `<div class="_row">${e.name} → ${e.target}</div>`).join('') || '<i>No events</i>';
    } else if (tab === 'messages') {
      body.innerHTML = this.messageLog.slice(-12).reverse()
        .map(m => `<div class="_row _${m.direction}">${m.direction === 'in' ? '←' : '→'} ${m.kind}</div>`).join('') || '<i>No messages</i>';
    } else if (tab === 'state') {
      body.innerHTML = `<pre style="margin:0;white-space:pre-wrap;font-size:10px">${JSON.stringify(this.getFullState(), null, 2)}</pre>`;
    } else if (tab === 'actions') {
      const H = typeof PlatoKit !== 'undefined' ? PlatoKit : null;
      const skinBtns = H?.Skin ? `
        <div style="margin-top:6px;border-top:1px solid #333;padding-top:4px"><b>Skin</b><br>
        <button onclick="PlatoKit.Skin.spawn()">Spawn skin</button>
        <button onclick="PlatoKit.Skin.toggle()">Toggle skin</button>
        <button onclick="PlatoKit.Skin.show()">Show</button>
        <button onclick="PlatoKit.Skin.hide()">Hide</button>
        <button onclick="console.log('Skin state:', {enabled:PlatoKit.Skin.isEnabled(),ready:PlatoKit.Skin.isReady(),frame:!!PlatoKit.Skin.getFrame()})">Log skin</button>
        </div>` : '';
      const busBtns = H?.EventBus ? `
        <div style="margin-top:6px;border-top:1px solid #333;padding-top:4px"><b>Bus</b><br>
        <button onclick="console.log('Topics:', PlatoKit.EventBus.listTopics())">Log topics</button>
        <button onclick="console.log('Bus log:', PlatoKit.EventBus.getLog())">Bus log</button>
        </div>` : '';
      body.innerHTML = `
        <b>Core</b><br>
        <button onclick="PlatoKitebug.injectMessage('state_query')">state_query</button>
        <button onclick="PlatoKitebug.highlight('.tile')">Highlight tiles</button>
        <button onclick="PlatoKitebug.simulateDrop()">Sim drop</button>
        <button onclick="console.log(PlatoKitebug.getFullState())">Log state</button>
        <button onclick="PlatoKitebug.send({type:'ping'})">Ping WS</button>
        <button onclick="PlatoKitebug.eventLog=[];PlatoKitebug.messageLog=[];PlatoKitebug.updatePanel()">Clear logs</button>
        <button onclick="console.log('Services:', PlatoKit?.Capabilities?.getServiceList())">Services</button>
        <button onclick="console.log('HTTP log:', PlatoKit?.HttpService?.getLog())">HTTP log</button>
        ${skinBtns}${busBtns}`;
    }
  }
};

// Auto-init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => PlatoKitebug.init());
} else {
  PlatoKitebug.init();
}
window.PlatoKitebug = PlatoKitebug;
