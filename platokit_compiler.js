/**
 * @platokit-cap
 * name: compiler
 * kind: export
 * type: module
 * version: 1.0.0
 * author: panamantis
 * description: Workspace compiler — exports state to HTML, bookmarklet, JSON
 */
// ==========================================================================
// ESCAPE UTILITIES
// ==========================================================================

/**
 * Escape HTML content for embedding in <script type="text/html">
 * Main concern: </script> appearing in embedded content
 */
export function escapeForScriptTag(html) {
  // Replace </script> with a safe placeholder that we can unescape on load
  return html
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<\/style>/gi, '<\\/style>');
}

/**
 * Unescape content that was escaped for script tag embedding
 */
export function unescapeFromScriptTag(escaped) {
  return escaped
    .replace(/<\\\/script>/gi, '</script>')
    .replace(/<\\\/style>/gi, '</style>');
}

// ==========================================================================
// COMPILATION
// ==========================================================================

/**
 * Compile workspace state to self-contained HTML
 *
 * @param {Object} state - Workspace state from PlatoKit.exportState()
 * @param {Object} options - Compilation options
 * @param {string} options.hubSource - Hub HTML source (if not fetching)
 * @param {string} options.name - Workspace name for title
 * @param {boolean} options.includeStorage - Include hub storage snapshot
 * @returns {string} Self-contained HTML file
 */
export async function compileToHtml(state, options = {}) {
  const {
    hubSource = null,
    name = 'Compiled Workspace',
    includeStorage = true
  } = options;

  // Get hub source if not provided
  let hubHtml = hubSource;
  if (!hubHtml) {
    try {
      // Try to fetch platokit.html
      const response = await fetch('platokit.html');
      if (response.ok) {
        hubHtml = await response.text();
      }
    } catch (e) {
      console.warn('Could not fetch hub source:', e);
    }
  }

  if (!hubHtml) {
    throw new Error('Hub source not available. Provide hubSource option or ensure platokit.html is fetchable.');
  }

  // Build embedded sources
  const embeddedCaps = [];
  for (let i = 0; i < state.slots.length; i++) {
    const slot = state.slots[i];
    if (slot.sourceHtml) {
      embeddedCaps.push({
        index: i,
        name: slot.registration?.name || `cap_${i}`,
        html: escapeForScriptTag(slot.sourceHtml)
      });
    }
  }

  // Prepare state for embedding (strip large sources from embedded state)
  const embeddedState = {
    ...state,
    slots: state.slots.map(s => ({
      ...s,
      sourceHtml: undefined,  // Don't duplicate - sources are in separate script tags
      hasEmbeddedSource: !!s.sourceHtml
    }))
  };

  // Optionally strip storage
  if (!includeStorage && embeddedState.hubState) {
    embeddedState.hubState.storageSnapshot = {};
  }

  const timestamp = new Date().toISOString();

  // Build compiled HTML
  const compiled = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(name)}</title>
  <meta name="generator" content="platokit_compiler.js">
  <meta name="compiled-at" content="${timestamp}">
  <meta name="slots-count" content="${state.slots.length}">
  <style>
    body { margin: 0; padding: 0; overflow: hidden; }
    #hub-frame { width: 100%; height: 100vh; border: none; }
    #loading {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: #111; color: #0f0; font-family: monospace;
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 10px;
    }
    #loading.hidden { display: none; }
  </style>
</head>
<body>
<!--
  COMPILED WORKSPACE: ${escapeHtml(name)}
  ========================================
  Generated: ${timestamp}
  Slots: ${state.slots.length}
  Sources embedded: ${embeddedCaps.length}

  This is a self-contained platokit workspace.
  To edit: Modify original files and recompile.
-->

<div id="loading">
  <div>Loading compiled workspace...</div>
  <div id="load-status">Initializing</div>
</div>

<!-- Embedded Hub Source -->
<script id="hub-source" type="text/html">
${escapeForScriptTag(hubHtml)}
</script>

<!-- Embedded Capability Sources -->
${embeddedCaps.map(cap => `
<script id="cap-${cap.index}-source" type="text/html" data-name="${escapeHtml(cap.name)}">
${cap.html}
</script>
`).join('')}

<!-- Embedded Workspace State -->
<script id="workspace-state" type="application/json">
${JSON.stringify(embeddedState, null, 2)}
</script>

<!-- Bootstrap: Reconstruct workspace -->
<script>
(function() {
  'use strict';

  const $loading = document.getElementById('loading');
  const $status = document.getElementById('load-status');

  function setStatus(msg) {
    $status.textContent = msg;
    console.log('[compiled]', msg);
  }

  // Unescape embedded content
  function unescape(escaped) {
    return escaped
      .replace(/<\\\\/script>/gi, '</script>')
      .replace(/<\\\\/style>/gi, '</style>');
  }

  // Get embedded content
  const hubSource = unescape(document.getElementById('hub-source').textContent);
  const state = JSON.parse(document.getElementById('workspace-state').textContent);

  setStatus('Creating hub frame...');

  // Create hub iframe with srcdoc
  const hubFrame = document.createElement('iframe');
  hubFrame.id = 'hub-frame';
  // More permissive sandbox for compiled workspaces - they're trusted
  hubFrame.sandbox = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';
  hubFrame.srcdoc = hubSource;
  document.body.appendChild(hubFrame);

  hubFrame.onload = () => {
    setStatus('Hub loaded, injecting capabilities...');

    // Give hub a moment to initialize
    setTimeout(() => {
      // Inject each capability
      let loaded = 0;
      const toLoad = state.slots.filter(s => s.hasEmbeddedSource).length;

      state.slots.forEach((slot, i) => {
        if (!slot.hasEmbeddedSource) return;

        const sourceEl = document.getElementById('cap-' + i + '-source');
        if (!sourceEl) return;

        const capHtml = unescape(sourceEl.textContent);

        // Send to hub to load
        hubFrame.contentWindow.postMessage({
          kind: 'load_compiled_cap',
          v: 1,
          slot: i,
          html: capHtml,
          loadInfo: slot.loadInfo,
          registration: slot.registration,
          capState: slot.capState
        }, '*');

        loaded++;
        setStatus('Loaded ' + loaded + '/' + toLoad + ' capabilities');
      });

      // Restore storage if present
      if (state.hubState?.storageSnapshot) {
        const keys = Object.keys(state.hubState.storageSnapshot);
        if (keys.length > 0) {
          setStatus('Restoring ' + keys.length + ' storage keys...');
          hubFrame.contentWindow.postMessage({
            kind: 'restore_storage',
            v: 1,
            storage: state.hubState.storageSnapshot
          }, '*');
        }
      }

      // Hide loading overlay
      setTimeout(() => {
        $loading.classList.add('hidden');
      }, 500);

    }, 100);
  };

  hubFrame.onerror = (e) => {
    setStatus('Error loading hub: ' + e);
  };

})();
</script>
</body>
</html>`;

  return compiled;
}

/**
 * Escape HTML entities
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==========================================================================
// BOOKMARKLET GENERATION
// ==========================================================================

/**
 * Generate bookmarklet code for a compiled workspace
 *
 * @param {Object} options - Bookmarklet options
 * @param {string} options.url - URL to hosted workspace (recommended)
 * @param {string} options.html - Inline HTML (size limited!)
 * @param {string} options.mode - 'fetch' (default), 'navigate', 'overlay', 'inline'
 * @returns {string} javascript: URL for bookmarklet
 */
export function generateBookmarklet(options = {}) {
  const {
    url = null,
    html = null,
    mode = 'fetch'
  } = options;

  let code;

  if (url) {
    switch (mode) {
      case 'navigate':
        // Simple: just navigate to the URL
        code = `location.href='${url}'`;
        break;

      case 'overlay':
        // Open as iframe overlay on current page
        code = `(function(){
          var f=document.createElement('iframe');
          f.src='${url}';
          f.style='position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;border:none;background:#111;';
          f.sandbox='allow-scripts allow-popups allow-same-origin';
          var c=document.createElement('button');
          c.textContent='X';
          c.style='position:fixed;top:10px;right:10px;z-index:9999999;padding:5px 10px;cursor:pointer;';
          c.onclick=function(){f.remove();c.remove();};
          document.body.appendChild(f);
          document.body.appendChild(c);
        })()`;
        break;

      case 'fetch':
      default:
        // Fetch and inject as srcdoc (most isolated)
        code = `(function(){
          var f=document.createElement('iframe');
          f.style='position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;border:none;background:#111;';
          f.sandbox='allow-scripts allow-popups';
          document.body.appendChild(f);
          fetch('${url}').then(function(r){return r.text()}).then(function(h){
            f.srcdoc=h;
          }).catch(function(e){
            f.srcdoc='<pre style="color:red">Failed to load: '+e+'</pre>';
          });
          var c=document.createElement('button');
          c.textContent='X';
          c.style='position:fixed;top:10px;right:10px;z-index:9999999;padding:5px 10px;cursor:pointer;';
          c.onclick=function(){f.remove();c.remove();};
          document.body.appendChild(c);
        })()`;
        break;
    }
  } else if (html) {
    // Inline HTML (size limited!)
    const encoded = btoa(unescape(encodeURIComponent(html)));
    if (encoded.length > 50000) {
      console.warn('Bookmarklet HTML is very large (' + encoded.length + ' chars). May not work in all browsers.');
    }
    code = `(function(){
      var h=decodeURIComponent(escape(atob('${encoded}')));
      var w=window.open('','_blank');
      w.document.write(h);
      w.document.close();
    })()`;
  } else {
    throw new Error('Either url or html must be provided');
  }

  // Minify (basic)
  code = code.replace(/\s+/g, ' ').trim();

  return 'javascript:' + encodeURIComponent(code);
}

/**
 * Create a draggable bookmarklet link element
 *
 * @param {string} name - Display name
 * @param {string} bookmarkletUrl - javascript: URL
 * @returns {HTMLAnchorElement}
 */
export function createBookmarkletLink(name, bookmarkletUrl) {
  const a = document.createElement('a');
  a.href = bookmarkletUrl;
  a.textContent = '📎 ' + name;
  a.title = 'Drag to bookmarks bar';
  a.style.cssText = `
    display: inline-block;
    padding: 8px 16px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    text-decoration: none;
    border-radius: 4px;
    font-family: monospace;
    cursor: grab;
  `;
  return a;
}

// ==========================================================================
// DOWNLOAD UTILITIES
// ==========================================================================

/**
 * Download content as file
 *
 * @param {string} content - File content
 * @param {string} filename - Filename with extension
 * @param {string} mimeType - MIME type (default: text/html)
 */
export function download(content, filename, mimeType = 'text/html') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Copy content to clipboard
 *
 * @param {string} content - Content to copy
 * @returns {Promise<boolean>} Success status
 */
export async function copyToClipboard(content) {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch (e) {
    console.error('Copy failed:', e);
    return false;
  }
}

// ==========================================================================
// HIGH-LEVEL API
// ==========================================================================

/**
 * Full compile and download workflow
 *
 * @param {Object} state - Workspace state from PlatoKit.exportState()
 * @param {Object} options - Options
 * @param {string} options.name - Workspace name
 * @param {string} options.filename - Output filename
 */
export async function compileAndDownload(state, options = {}) {
  const {
    name = 'Compiled Workspace',
    filename = `workspace_${new Date().toISOString().slice(0,10)}.html`
  } = options;

  const html = await compileToHtml(state, { name });
  download(html, filename);

  return {
    success: true,
    filename,
    size: html.length,
    slots: state.slots.length
  };
}

// Export version
export const VERSION = '1.0.0';

// Default export for convenience
export default {
  VERSION,
  compileToHtml,
  generateBookmarklet,
  createBookmarkletLink,
  download,
  copyToClipboard,
  compileAndDownload,
  escapeForScriptTag,
  unescapeFromScriptTag,
  escapeHtml
};
