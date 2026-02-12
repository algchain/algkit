/**
 * @platokit-cap
 * name: skin-manager
 * kind: skin
 * type: module
 * version: 1.0.0
 * author: panamantis
 * description: Skin system — layout manager, viewport routing, cap catalog
 */
const HubSkinService = (function() {
  // O: Skin iframe reference
  let skinFrame = null;
  let skinReady = false;
  let skinEnabled = false;

  // O: Viewport → slotId mapping (for routing messages from skin-hosted caps)
  const viewportSlotMap = new Map();  // viewport id → slotId
  const slotViewportMap = new Map();  // slotId → viewport id

  // O: Track which tool IDs are currently loaded (for status tracking)
  const loadedTools = new Map();  // toolId → { slotId, viewport, status }

  // O: Internal bus subscriptions for tool status bridge
  const busStatusHandlers = [];

  // O: Cap catalog v2 - rich metadata per tool
  const CAP_CATALOG = {
    'help':    { url: 'caps/help/help_hotline_kit.html',           label: 'Help',   emoji: '\u{1F4CB}', role: 'primary', desc: 'Help request form' },
    'llm':     { url: 'caps/chats/chat_gateway-allenai_kit.html', label: 'LLM',    emoji: '\u{1F916}', role: 'service', desc: 'AI chat gateway' },
    'search':  { url: 'caps/base_pages/search_main_kit.html',         label: 'Search', emoji: '\u{1F50D}', role: 'primary', desc: 'Cap discovery' },
    'mesh':    { url: 'caps/chat_video/chat_video_kit.html',        label: 'Mesh',   emoji: '\u{1F310}', role: 'service', desc: 'Video/text mesh chat' },
    'export':  { url: 'platokit_export_ui.html',                   label: 'Export', emoji: '\u{1F4E6}', role: 'primary', desc: 'Workspace export' },
    'msg':     { url: 'caps/base_pages/msg_send_kit.html',         label: 'Msg',    emoji: '\u{1F4AC}', role: 'primary', desc: 'Message broadcaster' },
    'storage': { url: 'caps/base_pages/store_local_kit.html',     label: 'Store',  emoji: '\u{1F4BE}', role: 'service', desc: 'Storage viewer' }
  };

  // O: Skin load sets - per-set viewport mapping
  const SKIN_LOAD_SETS = {
    'help_full': {
      viewports: { vp1: 'help' },
      hidden: ['llm', 'mesh'],
      desc: 'Help form with LLM + mesh support'
    },
    'llm_demo': {
      viewports: { vp1: 'llm', vp2: 'msg' },
      hidden: [],
      desc: 'LLM chat with message broadcaster'
    },
    'search': {
      viewports: { vp1: 'search' },
      hidden: [],
      desc: 'Cap discovery search'
    },
    'video_llm': {
      viewports: { vp1: 'mesh', vp2: 'llm' },
      hidden: [],
      desc: 'Video mesh with LLM'
    },
    'video_chat': {
      viewports: { vp1: 'mesh' },
      hidden: [],
      desc: 'Video/text mesh chat'
    },
    'help': {
      viewports: { vp1: 'help' },
      hidden: [],
      desc: 'Help request form'
    },
    'help_chat': {
      viewports: { vp1: 'help', vp2: 'mesh' },
      hidden: [],
      desc: 'Help with video chat'
    },
    'llm_chat': {
      viewports: { vp1: 'llm' },
      hidden: [],
      desc: 'LLM chat gateway'
    },
    'skin_demo': {
      viewports: { vp1: 'llm', vp2: 'msg' },
      hidden: [],
      desc: 'Demo caps for skin mode'
    },
    'export': {
      viewports: { vp1: 'export' },
      hidden: [],
      desc: 'Workspace export UI'
    }
  };

  // Resolve relative URL against hub's base (skin iframe has different base path)
  const hubBase = location.href.replace(/[^/\\]*$/, '');
  function resolveCapUrl(url) {
    if (!url || url.startsWith('http') || url.startsWith('file:') || url.startsWith('/')) return url;
    return hubBase + url;
  }

  // Find a slot that already has this URL loaded
  function findSlotByUrl(url) {
    for (const [id, s] of slots) {
      if (s.status === 'empty') continue;
      if (s.inputValue === url || s.source === url.split('/').pop()) {
        return id;
      }
    }
    return null;
  }

  // Find the CAP_CATALOG key for a given URL
  function findToolIdByUrl(url) {
    for (const [id, entry] of Object.entries(CAP_CATALOG)) {
      if (entry.url === url) return id;
    }
    return null;
  }

  // Spawn skin as full-screen overlay
  function spawn(skinUrl) {
    if (skinFrame) return; // Already spawned

    skinFrame = document.createElement('iframe');
    skinFrame.id = 'skin-frame';
    skinFrame.src = skinUrl || PlatoKitParams.getSkinUrl();
    skinFrame.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;border:none;z-index:1000;background:#fff;';
    const skinSandbox = [
      'allow-scripts',
      'allow-same-origin',
      'allow-modals',
      'allow-downloads',
      'allow-popups',
      'allow-popups-to-escape-sandbox'
    ].join(' ');
    skinFrame.sandbox = skinSandbox;
    document.body.appendChild(skinFrame);

    // Hide legacy UI
    const legacyElements = ['debug', 'dev-toolbar', 'drop-zone', 'caps', 'slots', 'log'];
    legacyElements.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    document.querySelectorAll('h3, h4').forEach(el => el.style.display = 'none');

    skinEnabled = true;
    log('platokit: skin spawned');

    setupEscapeHandler();

    skinFrame.onload = () => {
      log('platokit: skin iframe loaded');
    };

    return skinFrame;
  }

  // Hide skin, show legacy UI
  function hide() {
    if (skinFrame) {
      skinFrame.style.display = 'none';
    }
    const legacyElements = ['debug', 'dev-toolbar', 'drop-zone', 'caps', 'slots', 'log'];
    legacyElements.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = '';
    });
    document.querySelectorAll('h3, h4').forEach(el => el.style.display = '');
    showBackToSkinButton();
    log('platokit: skin hidden');
  }

  function showBackToSkinButton() {
    let btn = document.getElementById('back-to-skin-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'back-to-skin-btn';
      btn.textContent = '\u2190 Back to Skin (Esc)';
      btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9999;padding:8px 16px;background:#111;color:#0f0;border:1px solid #0f0;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;';
      btn.onclick = () => show();
      document.body.appendChild(btn);
    }
    btn.style.display = '';
  }

  function hideBackToSkinButton() {
    const btn = document.getElementById('back-to-skin-btn');
    if (btn) btn.style.display = 'none';
  }

  function show() {
    if (skinFrame) {
      skinFrame.style.display = '';
    }
    const legacyElements = ['debug', 'dev-toolbar', 'drop-zone', 'caps', 'slots', 'log'];
    legacyElements.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    document.querySelectorAll('h3, h4').forEach(el => el.style.display = 'none');
    hideBackToSkinButton();
    log('platokit: skin shown');
  }

  function setupEscapeHandler() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && skinEnabled && skinFrame?.style.display === 'none') {
        show();
      }
    });
  }

  function toggle() {
    if (!skinFrame) return;
    if (skinFrame.style.display === 'none') {
      show();
    } else {
      hide();
    }
  }

  function sendToSkin(component, data) {
    if (!skinFrame?.contentWindow) {
      log('platokit: skin not ready, cannot send');
      return false;
    }
    skinFrame.contentWindow.postMessage({
      kind: 'skin_render',
      v: 1,
      payload: { component, ...data }
    }, '*');
    return true;
  }

  function handleAction(payload, source) {
    const action = payload.action;
    log(`platokit: <- skin_action(${action})`);

    switch (action) {
      case 'ready':
        skinReady = true;
        sendInitialState();
        break;

      case 'load_cap':
        loadCapForViewport(payload.viewport, payload.capType, payload.capUrl, payload.fileContent, payload.fileName);
        break;

      case 'close_cap':
        closeCapInViewport(payload.viewport);
        break;

      case 'toggle_debug':
        toggle();
        break;

      case 'tile_action':
        handleTileAction(payload.slotId, payload.tileAction);
        break;

      case 'nav_click':
        handleNavClick(payload.item);
        break;

      case 'run_click':
        log('platokit: Run clicked (not implemented)');
        break;

      case 'request_state':
        sendCurrentState();
        break;

      case 'relay_cap_message':
        handleCapRelay(payload.viewport, payload.innerMessage);
        break;

      case 'tool_click':
        handleToolClick(payload.toolId);
        break;

      default:
        log(`platokit: unknown skin action: ${action}`);
    }
  }

  function sendInitialState() {
    // Send tools with rich v2 metadata
    sendToSkin('tools', {
      items: Object.entries(CAP_CATALOG).map(([id, entry]) => ({
        id,
        label: entry.label,
        emoji: entry.emoji,
        url: entry.url,
        role: entry.role,
        desc: entry.desc,
        status: loadedTools.has(id) ? loadedTools.get(id).status : 'idle',
        // Backward compat
        name: entry.label,
        available: true
      }))
    });
    sendCurrentState();
    setupBusStatusBridge();
    log('platokit: sent initial state to skin');
  }

  function sendCurrentState() {
    const tileData = [];
    for (const [id, s] of slots) {
      if (s.status === 'empty') continue;
      tileData.push({
        slotId: id,
        name: s.capName || s.source || `Tile ${id + 1}`,
        status: s.status,
        type: s.type,
        methods: s.methods || []
      });
    }
    sendToSkin('tiles', { items: tileData });
  }

  // Track tool loading status
  function trackToolLoad(toolId, slotId, viewport, status) {
    loadedTools.set(toolId, { slotId, viewport, status });
    sendToSkin('tool_status', { toolId, status, detail: '' });
  }

  // Update tool status (called from cap relay on register/ready/error)
  function updateToolStatusFromSlot(slotId, status, detail) {
    for (const [toolId, info] of loadedTools) {
      if (info.slotId === slotId) {
        info.status = status;
        sendToSkin('tool_status', { toolId, status, detail: detail || '' });
        return;
      }
    }
  }

  // Handle tool circle click (load to first empty viewport, keep one empty)
  function handleToolClick(toolId) {
    const entry = CAP_CATALOG[toolId];
    if (!entry) {
      log(`platokit: tool_click unknown: ${toolId}`);
      return;
    }

    // Find empty viewports - always keep at least one empty at bottom
    const viewports = ['vp1', 'vp2', 'vp3'];
    const emptyVps = viewports.filter(vp => !viewportSlotMap.has(vp));
    if (emptyVps.length <= 1) {
      sendToSkin('toast', { message: 'Keep at least one viewport open', type: 'info' });
      return;
    }

    loadCapForViewport(emptyVps[0], toolId, entry.url);
  }

  function loadCapForViewport(viewport, capType, capUrl, fileContent, fileName) {
    // Resolve URL from catalog if capType is a catalog key
    const catalogEntry = CAP_CATALOG[capType];
    const url = capUrl || (catalogEntry ? catalogEntry.url : null);

    if (!fileContent && !url) {
      log(`platokit: unknown cap type: ${capType}`);
      sendToSkin('toast', { message: `Unknown cap type: ${capType}`, type: 'error' });
      return;
    }

    // Attach-existing: check if this URL is already loaded in a slot
    if (!fileContent && url) {
      const existingSlotId = findSlotByUrl(url);
      if (existingSlotId !== null && !slotViewportMap.has(existingSlotId)) {
        // Reuse existing slot - just create viewport mapping
        viewportSlotMap.set(viewport, existingSlotId);
        slotViewportMap.set(existingSlotId, viewport);
        const s = slots.get(existingSlotId);
        const toolId = capType || findToolIdByUrl(url);

        sendToSkin('viewport_iframe', {
          viewport,
          slotId: existingSlotId,
          src: resolveCapUrl(url),
          capName: s.capName || url.split('/').pop(),
          capType: toolId
        });

        if (toolId) trackToolLoad(toolId, existingSlotId, viewport, s.status || 'loading');

        log(`platokit: attached existing slot ${existingSlotId} to ${viewport} (${url})`);
        sendToSkin('viewport_update', { viewport, slotId: existingSlotId, status: s.status, capName: s.capName });
        setTimeout(() => sendCurrentState(), 200);
        return;
      }
    }

    // Create fresh slot
    let targetId = null;
    for (const [id, s] of slots) {
      if (s.status === 'empty') { targetId = id; break; }
    }
    if (targetId === null) targetId = addSlot();

    viewportSlotMap.set(viewport, targetId);
    slotViewportMap.set(targetId, viewport);

    const toolId = capType || findToolIdByUrl(url);
    if (toolId) trackToolLoad(toolId, targetId, viewport, 'loading');

    if (fileContent) {
      if (skinEnabled && skinFrame) {
        sendToSkin('viewport_iframe', {
          viewport,
          slotId: targetId,
          srcdoc: fileContent,
          capName: fileName || 'dropped.html'
        });
        const s = slots.get(targetId);
        s.type = 'file';
        s.source = fileName;
        s.status = 'loading';
        s.capturedSource = fileContent;
      } else {
        loadContent(targetId, fileContent, 'file', fileName || 'dropped.html');
      }
      log(`platokit: loaded file ${fileName} for ${viewport}`);
      setTimeout(() => sendCurrentState(), 500);
      return;
    }

    if (skinEnabled && skinFrame) {
      sendToSkin('viewport_iframe', {
        viewport,
        slotId: targetId,
        src: resolveCapUrl(url),
        capName: (catalogEntry ? catalogEntry.label : url.split('/').pop()),
        capType: toolId
      });
      const s = slots.get(targetId);
      s.type = 'url';
      s.source = url.split('/').pop();
      s.inputValue = url;
      s.status = 'loading';
      if (url.startsWith('http')) {
        fetch(url).then(r => r.ok ? r.text() : null).then(html => {
          if (html) s.capturedSource = html;
        }).catch(() => {});
      }
    } else {
      const input = document.querySelector(`[data-id="${targetId}"]`);
      if (input) {
        input.value = url;
        loadSlot(targetId);
      }
    }

    log(`platokit: loaded cap ${capType} (${url}) for ${viewport}`);
    setTimeout(() => sendCurrentState(), 500);
  }

  // Load a skin load set: viewport caps + hidden caps
  function loadSetForSkin(setName) {
    const skinSet = SKIN_LOAD_SETS[setName];
    if (!skinSet) {
      log(`platokit: unknown skin load set: ${setName}`);
      return false;
    }

    log(`platokit: loading skin set "${setName}"`);

    // Load viewport caps
    for (const [vpId, toolId] of Object.entries(skinSet.viewports)) {
      const entry = CAP_CATALOG[toolId];
      if (!entry) {
        log(`platokit: skin set "${setName}" references unknown tool: ${toolId}`);
        continue;
      }
      loadCapForViewport(vpId, toolId, entry.url);
    }

    // Load hidden caps (into hub slots, no viewport)
    skinSet.hidden.forEach((toolId, i) => {
      const entry = CAP_CATALOG[toolId];
      if (!entry) {
        log(`platokit: skin set "${setName}" hidden references unknown tool: ${toolId}`);
        return;
      }

      setTimeout(() => {
        let targetId = null;
        for (const [id, s] of slots) {
          if (s.status === 'empty') { targetId = id; break; }
        }
        if (targetId === null) targetId = addSlot();

        const input = document.querySelector(`[data-id="${targetId}"]`);
        if (input) {
          input.value = entry.url;
          loadSlot(targetId);
        }

        trackToolLoad(toolId, targetId, null, 'loading');
        log(`platokit: loaded hidden cap ${toolId} (${entry.url}) in slot ${targetId}`);
      }, (i + 1) * 100);  // Stagger hidden loads after viewport loads
    });

    return true;
  }

  // Bus-driven tool status bridge
  // Subscribe internally to known status topics and forward to skin
  function setupBusStatusBridge() {
    // We hook into the bus by watching publish events.
    // Since HubEventBusService.subscribe expects a window-like source with postMessage,
    // we create a proxy source that calls our handler instead.
    const statusTopics = {
      'llm_status': 'llm',
      'chat_status': 'mesh',
      'help_status': 'help',
      'search_status': 'search'
    };

    for (const [topic, toolId] of Object.entries(statusTopics)) {
      const proxySource = {
        postMessage: function(msg) {
          if (msg.kind === 'bus_event' && msg.payload) {
            const data = msg.payload.data || {};
            const status = data.status || 'loading';
            const detail = data.detail || data.message || '';
            sendToSkin('tool_status', { toolId, status, detail });
            // Update loadedTools tracking
            if (loadedTools.has(toolId)) {
              loadedTools.get(toolId).status = status;
            }
            log(`platokit: bus bridge ${topic} -> tool_status(${toolId}, ${status})`);
          }
        }
      };
      // Use a dedicated internal slotId (-100 - index) to avoid collision
      const internalSlotId = -100 - busStatusHandlers.length;
      HubEventBusService.subscribe(proxySource, internalSlotId, topic);
      busStatusHandlers.push({ topic, slotId: internalSlotId });
    }

    log('platokit: bus status bridge active');
  }

  function getSlotForViewport(viewport) {
    return viewportSlotMap.get(viewport);
  }

  function getViewportForSlot(slotId) {
    return slotViewportMap.get(slotId);
  }

  function handleCapRelay(viewport, inner) {
    const slotId = viewportSlotMap.get(viewport);
    if (slotId === undefined) {
      log(`platokit: cap relay from unknown viewport ${viewport}`);
      return;
    }

    const s = slots.get(slotId);
    if (!s) {
      log(`platokit: cap relay - no slot ${slotId}`);
      return;
    }

    log(`platokit: <- cap[${viewport}] ${inner.kind || '?'}`);

    switch (inner.kind) {
      case 'register':
        s.methods = inner.payload?.methods || inner.methods || [];
        s.capName = inner.payload?.name || inner.name || null;
        s.capVersion = inner.payload?.version || inner.version || null;
        s.status = 'ready';
        log(`cap[${viewport}]: registered ${s.capName || '?'}@${s.capVersion || '?'} [${s.methods.join(',')}]`);
        sendToSkin('cap_message', {
          viewport,
          message: {
            kind: 'registered',
            v: 1,
            payload: { success: true, name: s.capName || `vp-${viewport}`, hubId: hubState.workspaceId }
          }
        });
        updateTileTitle(slotId);
        updateCapsUI();
        sendCurrentState();
        sendToSkin('viewport_update', { viewport, slotId, status: 'ready', capName: s.capName });
        // Update tool status to ready
        updateToolStatusFromSlot(slotId, 'ready', s.capName);
        break;

      case 'pong':
        log(`cap[${viewport}]: pong`);
        break;

      case 'ready':
      case 'iframe_ready':
        s.status = 'ready';
        log(`cap[${viewport}]: ready`);
        updateTileTitle(slotId);
        updateCapsUI();
        sendToSkin('viewport_update', { viewport, slotId, status: 'ready' });
        updateToolStatusFromSlot(slotId, 'ready', '');
        break;

      case 'state_response':
        if (inner.id && HubStateService.handleStateResponse(inner.id, inner.payload || {})) {
          log(`cap[${viewport}]: state_response`);
        }
        break;

      case 'store':
        const storePayload = inner.payload || {};
        const storeResult = HubStoreService.handle(storePayload.op, storePayload.key, storePayload.value);
        log(`cap[${viewport}]: store.${storePayload.op}(${storePayload.key})`);
        sendToSkin('cap_message', {
          viewport,
          message: { kind: 'store_response', v: 1, id: inner.id, payload: storeResult }
        });
        break;

      case 'http':
        const httpPayload = inner.payload || {};
        log(`cap[${viewport}]: http.${httpPayload.method || 'GET'} ${httpPayload.url || '?'}`);
        HubHttpService.handle(httpPayload).then(httpResult => {
          sendToSkin('cap_message', {
            viewport,
            message: { kind: 'http_response', v: 1, id: inner.id, payload: httpResult }
          });
        });
        break;

      case 'capabilities':
        const capsResult = HubCapabilitiesService.getCapabilities();
        log(`cap[${viewport}]: capabilities`);
        sendToSkin('cap_message', {
          viewport,
          message: { kind: 'capabilities_response', v: 1, id: inner.id, payload: capsResult }
        });
        break;

      case 'bus_subscribe':
        const subTopic = inner.payload?.topic;
        if (subTopic) {
          const proxySource = { viewport, postMessage: (msg) => sendToSkin('cap_message', { viewport, message: msg }) };
          const subResult = HubEventBusService.subscribe(proxySource, slotId, subTopic);
          log(`cap[${viewport}]: bus_subscribe(${subTopic})`);
          sendToSkin('cap_message', {
            viewport,
            message: { kind: 'bus_subscribe_response', v: 1, id: inner.id, payload: subResult }
          });
        }
        break;

      case 'bus_unsubscribe':
        const unsubTopic = inner.payload?.topic;
        if (unsubTopic) {
          const proxySource = { viewport };
          const unsubResult = HubEventBusService.unsubscribe(proxySource, slotId, unsubTopic);
          log(`cap[${viewport}]: bus_unsubscribe(${unsubTopic})`);
          sendToSkin('cap_message', {
            viewport,
            message: { kind: 'bus_unsubscribe_response', v: 1, id: inner.id, payload: unsubResult }
          });
        }
        break;

      case 'bus_publish':
        const pubTopic = inner.payload?.topic;
        const pubData = inner.payload?.data;
        if (pubTopic) {
          const pubResult = HubEventBusService.publish(slotId, pubTopic, pubData);
          log(`cap[${viewport}]: bus_publish(${pubTopic}) -> ${pubResult.delivered} delivered`);
        }
        break;

      case 'bus_broadcast':
        const bcastData = inner.payload?.data;
        const bcastResult = HubEventBusService.broadcast(slotId, bcastData);
        log(`cap[${viewport}]: bus_broadcast -> ${bcastResult.delivered} delivered`);
        break;

      case 'bus_list_topics':
        const topicsList = HubEventBusService.listTopics();
        log(`cap[${viewport}]: bus_list_topics (${topicsList.length} topics)`);
        sendToSkin('cap_message', {
          viewport,
          message: { kind: 'bus_list_topics_response', v: 1, id: inner.id, payload: { topics: topicsList } }
        });
        break;

      case 'open_tab':
        const tabUrl = inner.payload?.url;
        const tabRequestId = inner.id || ('tab_' + Date.now());
        if (tabUrl) {
          const proxySource = { viewport, postMessage: (msg) => sendToSkin('cap_message', { viewport, message: msg }) };
          const tabResult = HubTabRelayService.openTab(proxySource, slotId, tabRequestId, tabUrl, inner.payload);
          log(`cap[${viewport}]: open_tab(${tabUrl}) -> ${tabResult.success ? 'opened' : tabResult.error}`);
          sendToSkin('cap_message', {
            viewport,
            message: { kind: 'open_tab_response', v: 1, id: tabRequestId, payload: tabResult }
          });
        }
        break;

      case 'response':
        log(`cap[${viewport}]: response`);
        break;

      case 'error':
        log(`cap[${viewport}]: error - ${inner.payload?.message || inner.error?.message || '?'}`);
        updateToolStatusFromSlot(slotId, 'error', inner.payload?.message || 'Error');
        break;

      case 'workspace_state_request':
        log(`cap[${viewport}]: workspace_state_request`);
        const wsOptions = inner.options || {};
        HubStateService.getWorkspaceState({
          includeStorage: wsOptions.includeStorage !== false,
          includeSources: wsOptions.includeSources !== false,
          includeCapStates: wsOptions.includeCapStates !== false,
          fetchMissingSources: wsOptions.fetchMissingSources !== false
        }).then(state => {
          log(`cap[${viewport}]: -> workspace_state_response (${state.slots.length} slots)`);
          sendToSkin('cap_message', {
            viewport,
            message: { kind: 'workspace_state_response', v: 1, id: inner.id, payload: state }
          });
        }).catch(err => {
          log(`cap[${viewport}]: -> workspace_state_response error: ${err.message}`);
          sendToSkin('cap_message', {
            viewport,
            message: { kind: 'workspace_state_response', v: 1, id: inner.id, payload: null, error: err.message }
          });
        });
        break;

      case 'hub_source_request':
        log(`cap[${viewport}]: hub_source_request`);
        if (location.protocol === 'file:' || location.origin === 'null') {
          const doctype = document.doctype ?
            `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''}>` :
            '<!DOCTYPE html>';
          const html = doctype + '\n' + document.documentElement.outerHTML;
          log(`cap[${viewport}]: -> hub_source_response (${html.length} bytes, DOM)`);
          sendToSkin('cap_message', {
            viewport,
            message: { kind: 'hub_source_response', v: 1, id: inner.id, payload: { html, fromDOM: true } }
          });
        } else {
          fetch('platokit.html')
            .then(r => r.ok ? r.text() : Promise.reject('HTTP ' + r.status))
            .then(html => {
              log(`cap[${viewport}]: -> hub_source_response (${html.length} bytes)`);
              sendToSkin('cap_message', {
                viewport,
                message: { kind: 'hub_source_response', v: 1, id: inner.id, payload: { html } }
              });
            })
            .catch(err => {
              const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
              const html = doctype + '\n' + document.documentElement.outerHTML;
              sendToSkin('cap_message', {
                viewport,
                message: { kind: 'hub_source_response', v: 1, id: inner.id, payload: { html, fromDOM: true } }
              });
            });
        }
        break;

      default:
        log(`cap[${viewport}]: ${inner.kind} (unhandled)`);
    }
  }

  function closeCapInViewport(viewport) {
    const slotId = viewportSlotMap.get(viewport);
    if (slotId !== undefined) {
      // Clean up tool tracking
      for (const [toolId, info] of loadedTools) {
        if (info.slotId === slotId) {
          info.status = 'idle';
          info.viewport = null;
          sendToSkin('tool_status', { toolId, status: 'idle', detail: '' });
          break;
        }
      }
      viewportSlotMap.delete(viewport);
      slotViewportMap.delete(slotId);
    }
    sendToSkin('viewport_update', { viewport, status: 'empty', capName: null });
    log(`platokit: closed cap in ${viewport}`);
  }

  function handleTileAction(slotId, tileAction) {
    switch (tileAction) {
      case 'ping':
        pingSlot(slotId);
        break;
      case 'close':
        removeSlot(slotId);
        sendCurrentState();
        break;
      default:
        log(`platokit: unknown tile action: ${tileAction}`);
    }
  }

  function handleNavClick(item) {
    switch (item) {
      case 'new_prompt':
        addSlot();
        sendCurrentState();
        break;
      case 'my_library':
        log('platokit: My Library clicked (not implemented)');
        break;
      case 'load_set':
        break;
      default:
        log(`platokit: nav click: ${item}`);
    }
  }

  function isEnabled() { return skinEnabled; }
  function isReady() { return skinReady; }
  function getFrame() { return skinFrame; }

  return {
    spawn,
    hide,
    show,
    toggle,
    sendToSkin,
    handleAction,
    handleCapRelay,
    sendCurrentState,
    loadSetForSkin,
    loadCapForViewport,
    isEnabled,
    isReady,
    getFrame,
    getSlotForViewport,
    getViewportForSlot,
    CAP_CATALOG,
    SKIN_LOAD_SETS
  };
})();
