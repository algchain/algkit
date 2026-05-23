/* bookmarklet.exit.src.js — PlatoKit: Exit the Cave (v0.7.7 / v1+).
 *
 * The trust anchor. The user reads this once before installing; never changes
 * thereafter. Updates land in collar.js at HUB origin (live), not here.
 *
 * Spec: ../spec_min_platokitexit.md (normative).
 * Layout: host <div> → collar iframe (HUB origin) → uapp iframe nested inside.
 * The host page has no DOM handle to the uapp iframe.
 *
 * R6: collar required. If the 1500 ms handshake doesn't complete, stop.
 * R7: two-tier caps. user-grant requires chip toggle; collar-only invocable
 *     only from the collar (enforced in collar §5.1).
 *
 * v0.7.7 — persistent panel + two-step ×:
 *   1st × click on a normal panel COLLAPSES it to a header-only strip
 *   ("PlatoKit: Exit the Cave   ×"). The chrome and uapp iframe stay alive
 *   but are clipped by overflow:hidden + a small height. Click anywhere on
 *   the visible strip (except × itself) to restore the previous size.
 *   2nd × click while minimized HIDES the panel completely (display:none).
 *   Re-clicking the bookmark unhides + restores to the last user size.
 *
 *   The collar iframe, the active uapp, the message port, granted
 *   permissions, overlays, and chat history all stay alive in the
 *   background through every state — only the panel chrome's display
 *   changes. No handshake, no vp round-trip, no blurp on any transition.
 *
 *   This eliminates the open/activate repeat-click resize blurp completely
 *   without storing any persistent state on the host page. The "memory" is
 *   just the live closure + DOM that already exist; reload/navigate/close-tab
 *   still hard-resets everything (browser garbage-collects the host frame).
 *
 *   Trade-offs the user has accepted:
 *     - Hidden-but-running uapps continue to execute JS in the background.
 *       Puter.js stays loaded; chat.html keeps its iframe alive. The grant
 *       chips' on-state still applies, so a hidden uapp could in principle
 *       invoke a granted cap with no visual indicator. Mitigation if this
 *       bites: surface a "(active in: <name>)" hint when a hidden uapp
 *       fires a cap. Not built; flagged in plan_v1_plus.md §3.2a (K1b).
 *     - Grants do NOT auto-reset on hide. The user dismissed the panel,
 *       not the session. To clear grants, untoggle the chips, or close the
 *       tab. This trades the v0.7.6 "fresh-session = fresh-grant" property
 *       for the persistence the user explicitly asked for.
 *
 *   Programmatic resizes (vp) are CSS-transitioned for ~120ms inline, so
 *   the first session's paint→saved-size jump and any cross-uapp swap
 *   animate instead of jolting. User-drag via resize:both stays snappy
 *   because the transition is applied only on vp, then cleared.
 *
 * v1+ additions (forward-compat with v0.7 protocol, optional kinds only):
 *   - k:"vp" — collar may push a viewport hint to resize the host panel
 *     when the user swaps to a different uapp. Clamped to safe bounds here.
 *     Old bookmarks ignore unknown kinds → graceful degradation.
 *
 * H1/H2/H4 security floors were attempted at v0.7.4 but reverted: the H2
 * self-injection guard fires when the bookmark is dragged onto a page
 * served from the HUB itself (common during local dev), and the sandbox
 * attribute appears to interact badly with Puter.js popup auth. Re-attempt
 * after a proper test pass — see plan_v1_plus.md §5 (H-series).
 *
 * Audit shortcut: read CAPS below. That's every DOM op the bookmark can do.
 * Everything else is generic handshake + dispatch + chrome.
 *
 * No console.log in this file. Diagnostic output happens at T2/T3 frames;
 * the host page's console stays clean.
 */
(function () {
  if (window.__bcrpc__) {
    /* Persistent panel (v0.7.7): closure stayed alive after a previous ×.
     * Reopen unhides the panel — already sized, already connected, already
     * in-session. This is the no-blurp path. */
    if (window.__bcrpc__.__bcReopen) window.__bcrpc__.__bcReopen();
    else window.__bcrpc__.scrollIntoView({block: "center"});
    return;
  }

  /* HUB is the base URL the collar loads from. May be just an origin
   * (http://localhost:8099) or include a path prefix
   * (https://algchain.github.io/algkit/bookmarks/v1) — the bookmarklet
   * just concatenates "/collar.html". One bookmark variant per HUB base. */
  var HUB = "__HUB_ORIGIN__";
  var P = "bc.v0";
  var session = crypto.randomUUID();
  var COLLAR_TIMEOUT_MS = 1500;

  /* §6.1 CAPS — every DOM op the bookmark can perform on the host page.
   *   tier: "user-grant" → requires an on-state chip in the panel.
   * Handlers do the DOM op only; per-cap validation lives in collar §5.4.
   * Each handler keeps a small T1 floor (unconditional safety constraint). */
  var overlays = new Map();
  var CAPS = {
    rd: { tier: "user-grant", label: "Read page text", handler: function (p) {
      var sel = String(window.getSelection() || "").trim();
      if (sel) return {text: sel.slice(0, 65536)};                  /* T1 floor: 64 KiB */
      var root = (p && p.selector) ? document.querySelector(p.selector) : document.body;
      return {text: (root ? root.innerText || "" : "").slice(0, 65536)};
    }},
    ov: { tier: "user-grant", label: "Overlay images", handler: function (p) {
      var id = "bc_o" + (overlays.size + 1);
      var img = document.createElement("img");
      img.src = p.url; img.alt = ""; img.referrerPolicy = "no-referrer";
      /* T1 floor: pointer-events:none + fixed z-index — no click capture. */
      img.style.cssText = "position:fixed;left:" + (p.x|0) + "px;top:" + (p.y|0) + "px;" +
        "width:" + (p.w|0) + "px;height:" + (p.h|0) + "px;" +
        "opacity:" + (p.o == null ? 1 : +p.o) + ";pointer-events:none;z-index:2147483000";
      document.body.appendChild(img); overlays.set(id, img);
      return {id: id};
    }},
    sc: { tier: "user-grant", label: "Scroll this page", handler: function (p) {
      window.scrollBy({top: +p.top || 0, behavior: "smooth"});
      return {ok: true};
    }},
  };

  var grants = {};
  Object.keys(CAPS).forEach(function (c) { if (CAPS[c].tier === "user-grant") grants[c] = false; });

  var port = null, iframe = null, connected = false, collarTimer = null;

  /* ----- UI ----- */
  var ui = document.createElement("div");
  ui.id = "bcrpc-ui";
  var style = document.createElement("style");
  /* resize:both gives the user a native bottom-right grip. Flex column makes
   * the iframe fill the remaining height — resizing the panel resizes the hub. */
  style.textContent =
    "#bcrpc-ui{position:fixed;right:12px;top:12px;width:360px;height:520px;background:#fff;color:#000;" +
    "border:1px solid #000;padding:10px;z-index:2147483647;font:13px/1.4 system-ui,sans-serif;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.25);border-radius:4px;" +
    "display:flex;flex-direction:column;resize:both;overflow:auto;" +
    "min-width:280px;min-height:280px;max-width:96vw;max-height:96vh;user-select:none}" +
    /* Minimized strip: hide everything except the header. The class is the
     * single switch; setMin toggles it. width/height/min-* live inline so
     * the transition has explicit numeric endpoints to animate between. */
    "#bcrpc-ui.bcrpc-min>*:not(.h){display:none}" +
    "#bcrpc-ui.bcrpc-min .h{margin:0}" +
    "#bcrpc-ui .h{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;cursor:move;user-select:none}" +
    "#bcrpc-ui .h b{font-size:14px}" +
    /* Close button: borderless circular hover icon, not a boxed "×". */
    "#bcrpc-ui .x{background:none;border:0;cursor:pointer;width:28px;height:28px;border-radius:14px;padding:0;color:#999;font:inherit;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center}" +
    "#bcrpc-ui .x:hover{background:#f0f0f0;color:#000}" +
    /* Permissions section label — small caps, muted, sits directly above the
     * chip row. Tells the user that the chips ARE the permission switches,
     * so a disabled tool button in a uapp doesn't read as "broken". Quiet
     * typography on purpose: the chips themselves are the loud element. */
    "#bcrpc-ui .perms-label{font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:#888;margin:6px 0 4px 1px;font-weight:500}" +
    /* Chip-style caps: muted outline = off, filled = granted. Live toggles, not an install-time checklist. */
    "#bcrpc-ui .chip{display:inline-block;border:1px solid #aaa;background:#fff;color:#555;padding:3px 10px;margin:2px 4px 2px 0;border-radius:14px;font:inherit;font-size:11px;cursor:pointer;line-height:1.3}" +
    "#bcrpc-ui .chip:hover{border-color:#1a73e8;color:#1a73e8}" +
    "#bcrpc-ui .chip.on{background:#1a73e8;border-color:#1a73e8;color:#fff;box-shadow:0 0 0 2px #e6efff}" +
    "#bcrpc-ui .chip.ext{border-color:#3a9b50;color:#2c8f3b}" +
    "#bcrpc-ui .chip.ext.on{background:#2c8f3b;border-color:#2c8f3b;color:#fff;box-shadow:0 0 0 2px #dcfae3}" +
    "#bcrpc-status{margin:4px 0;font-size:12px;color:#333}" +
    "#bcrpc-status.err{color:#b00}#bcrpc-status.ok{color:#063}" +
    "#bcrpc-frame-wrap{flex:1;margin-top:8px;min-height:140px}" +
    "#bcrpc-frame-wrap iframe{width:100%;height:100%;border:0;border-radius:3px;display:block;background:#fff}";
  ui.appendChild(style);

  var head = document.createElement("div"); head.className = "h";
  var title = document.createElement("b");
  title.textContent = "PlatoKit: Exit the Cave";
  /* Host + hub origins are in the tooltip — quiet by default, available on hover
   * for the "did I drag this on the right tab?" safety check. */
  title.title = "Acting on " + location.origin + " · collar at " + new URL(HUB).origin;
  var xbtn = document.createElement("button"); xbtn.className = "x"; xbtn.textContent = "×"; xbtn.title = "close";
  head.appendChild(title); head.appendChild(xbtn); ui.appendChild(head);

  /* Drag-to-move via the header. Listen on document so the drag survives
   * the pointer leaving the header — important in minimized state where
   * the header is only 140×32 and a quick drag easily overshoots. Cleanup
   * on pointerup AND pointercancel: without the latter, a browser-cancelled
   * gesture (right-click, alt-tab, scroll, contextual interrupt) leaves mv
   * attached and the panel follows the pointer indefinitely.
   *
   * didDrag is shared with the click-to-restore handler below. A drag is
   * detected as soon as the pointer moves more than 3px from the down
   * position; the trailing click event (browsers fire one after pointerup
   * even after significant travel in some cases) is then suppressed so a
   * drag-to-move on the minimized strip doesn't accidentally restore. */
  var didDrag = false;
  head.addEventListener("pointerdown", function (e) {
    if (e.target === xbtn) return;
    didDrag = false;
    var startX = e.clientX, startY = e.clientY;
    var off = {x: e.clientX - ui.offsetLeft, y: e.clientY - ui.offsetTop};
    function mv(ev) {
      if (!didDrag &&
          (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)) {
        didDrag = true;
      }
      ui.style.left  = (ev.clientX - off.x) + "px";
      ui.style.top   = (ev.clientY - off.y) + "px";
      ui.style.right = "auto";
    }
    function up() {
      document.removeEventListener("pointermove",   mv);
      document.removeEventListener("pointerup",     up);
      document.removeEventListener("pointercancel", up);
    }
    document.addEventListener("pointermove",   mv);
    document.addEventListener("pointerup",     up);
    document.addEventListener("pointercancel", up);
  });

  var status = document.createElement("div"); status.id = "bcrpc-status";
  status.textContent = "connecting to collar…";
  ui.appendChild(status);
  /* Hide the status line when everything is good; only show when
   * the user actually needs to know something (connecting / error). */
  function setStatus(msg, cls) {
    status.textContent = msg;
    status.className = cls || "";
    status.style.display = (cls === "ok") ? "none" : "";
  }

  /* "Choose page permissions:" sits above the chip row (below the title bar
   * and any status text). Pure label — non-interactive; the chips below
   * are where the actual grant action happens. */
  var permsLabel = document.createElement("div");
  permsLabel.className = "perms-label";
  permsLabel.textContent = "Choose page permissions:";
  ui.appendChild(permsLabel);

  var permsHost = document.createElement("div"); ui.appendChild(permsHost);

  /* Chip = live capability toggle. .on = granted; otherwise muted outline.
   * Click toggles in place; sendGrants() pushes the full grant state to the
   * collar so every bound uapp's `gr` view stays in sync.
   *
   * The set of chips is FIXED at install time — exactly the user-grant CAPS
   * declared above. The bookmark deliberately exposes no channel for the
   * collar (or anyone downstream) to inject new chips at runtime: the trust
   * anchor's UI surface is what you see in this source, nothing more. If a
   * future cap is needed, add it to CAPS and re-drag. */
  function makeChip(id, label) {
    var c = document.createElement("button");
    c.type = "button"; c.className = "chip";
    c.textContent = label;
    c.onclick = function () { grants[id] = !grants[id]; c.classList.toggle("on", grants[id]); sendGrants(); };
    return c;
  }

  Object.keys(CAPS).forEach(function (c) {
    if (CAPS[c].tier !== "user-grant") return;
    permsHost.appendChild(makeChip(c, CAPS[c].label));
  });

  var frameWrap = document.createElement("div"); frameWrap.id = "bcrpc-frame-wrap"; ui.appendChild(frameWrap);

  /* Two-step ×: normal→minimize, minimized→hide. stopPropagation prevents
   * the click from bubbling to ui's restore handler. */
  xbtn.onclick = function (e) { e && e.stopPropagation(); minimized ? hidePanel() : setMin(true); };

  /* ----- handshake ----- */
  iframe = document.createElement("iframe");
  iframe.src = HUB + "/collar.html#s=" + session;
  iframe.referrerPolicy = "no-referrer";
  frameWrap.appendChild(iframe);

  collarTimer = setTimeout(function () {
    if (!connected) { setStatus("PlatoKit: Exit — collar unavailable", "err"); }
  }, COLLAR_TIMEOUT_MS);

  function onHi(e) {
    var d = e.data;
    if (!d || d.p !== P || d.k !== "hi" || d.s !== session) return;
    if (!iframe || e.source !== iframe.contentWindow) return;       /* source pin */
    window.removeEventListener("message", onHi);
    clearTimeout(collarTimer); collarTimer = null;
    var ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = onPortMsg;
    port.start();
    e.source.postMessage({p: P, s: session, k: "port"}, "*", [ch.port2]);
    connected = true;
    setStatus("connected · collar handshake complete", "ok");
    sendGrants();
  }
  window.addEventListener("message", onHi);

  /* ----- port RPC ----- */
  function reply(id, k, ex) { if (port) port.postMessage(Object.assign({k: k, rt: id}, ex)); }
  function sendGrants() { if (port) port.postMessage({k: "gr", pl: {grants: grants}}); }

  function onPortMsg(e) {
    var d = e.data; if (!d) return;
    /* iv: invoke a capability. d.to is reserved (Q3) — single-target in v0.7. */
    if (d.k === "iv") {
      var cap = CAPS[d.c];
      if (!cap) return reply(d.id, "er", {e: {c: "NO_SUCH_CAP", m: d.c}});
      if (cap.tier === "user-grant" && !grants[d.c]) {
        return reply(d.id, "er", {e: {c: "DENIED", m: d.c}});
      }
      try { reply(d.id, "rs", {pl: cap.handler(d.pl || {})}); }
      catch (x) { reply(d.id, "er", {e: {c: "THROWN", m: String((x && x.message) || x)}}); }
      return;
    }
    /* vp: collar pushes viewport hint (v1+ — uapp-swap). Clamped to safe
     * bounds so a misbehaving collar/uapp can't reduce the panel to 1×1
     * or grow it beyond the viewport. Unknown to v0.7 bookmarks (ignored).
     *
     * v0.7.7: brief inline transition smooths the resize. Applied only here
     * so user-drag via resize:both stays snappy (no transition on arbitrary
     * style.width changes). The 180ms cleanup beats the 120ms transition by
     * a small margin; if a second vp arrives mid-animation the setTimeouts
     * harmlessly stack and clear. */
    if (d.k === "vp") {
      var pl = d.pl || {};
      var maxW = Math.floor(window.innerWidth * 0.96);
      var maxH = Math.floor(window.innerHeight * 0.96);
      ui.style.transition = "width .12s ease-out, height .12s ease-out";
      if (+pl.w) ui.style.width  = Math.max(280, Math.min(maxW, +pl.w)) + "px";
      if (+pl.h) ui.style.height = Math.max(280, Math.min(maxH, +pl.h)) + "px";
      setTimeout(function () { ui.style.transition = ""; }, 180);
      return;
    }
    /* px (extension permissions) is intentionally NOT handled here. v0.7.5
     * and earlier accepted `{k:"px", pl:{add,remove}}` from the collar to
     * inject/remove chips with collar-controlled labels. That broke the
     * bookmark's invariant of "the chips you see are exactly what this
     * source declares" — a downstream component could fabricate a chip
     * with arbitrary text in the trust-anchor panel. Removed in v0.7.6.
     * Unknown kinds are dropped silently (forward-compat). */
    if (d.k === "bye") { hidePanel(); return; }
  }

  /* v0.7.7 lifecycle: × is two-step (normal → minimized → hidden). Nothing
   * inside the panel tears down — port, grants, iframe, chat history all
   * stay alive. Tab GC is the only real close.
   *
   * setMin(yes) does the chrome-only collapse/restore. The .bcrpc-min class
   * hides every child but the header; inline width/height/min-* give the
   * transition explicit numeric endpoints to animate between. The setTimeout
   * clears the transition after the 120ms animation settles so user-drag
   * via resize:both doesn't lag the cursor by 120ms.
   *
   * Title swaps to "PlatoKit" when minimized — the full string is too wide
   * for the 140px strip and would either truncate or push × out of view. */
  var minimized = false, savedHeight = "", savedWidth = "";
  function setMin(yes) {
    if (minimized === yes) return;
    /* Pin the right edge to the panel's CURRENT right edge on BOTH
     * directions of setMin:
     *
     *   - On minimize: strip shrinks in place; its right edge stays
     *     exactly where the full panel's right edge was. Not toward
     *     the screen corner.
     *   - On restore: if the user dragged the minimized strip (the
     *     drag handler sets left:Xpx, right:auto, switching anchor
     *     to left-only), growing width back would extend rightward,
     *     possibly off-screen. Re-pinning the right edge here forces
     *     the width to grow LEFTWARD instead — top-right of the strip
     *     stays put, panel restores in-place.
     *
     * Use document.documentElement.clientWidth (NOT window.innerWidth):
     * for position:fixed elements, CSS `right:` is resolved against
     * the viewport's content area, which EXCLUDES the vertical
     * scrollbar. innerWidth INCLUDES it — using innerWidth would
     * over-count by the scrollbar width and shift the panel ~15px left. */
    if (yes) {
      savedHeight = ui.style.height || "";
      savedWidth  = ui.style.width  || "";
    }
    var rect = ui.getBoundingClientRect();
    var vpw  = document.documentElement.clientWidth;
    ui.style.right = (vpw - rect.right) + "px";
    ui.style.left  = "auto";
    ui.style.transition = "width .12s ease-out, height .12s ease-out";
    ui.classList.toggle("bcrpc-min", yes);
    ui.style.minHeight = ui.style.minWidth = yes ? "0" : "";
    ui.style.height    = yes ? "32px"  : savedHeight;
    ui.style.width     = yes ? "140px" : savedWidth;
    title.textContent  = yes ? "PlatoKit" : "PlatoKit: Exit the Cave";
    setTimeout(function () { ui.style.transition = ""; }, 180);
    minimized = yes;
  }
  function hidePanel() { ui.style.display = "none"; }
  /* Bookmark re-click is a three-way toggle:
   *
   *   hidden                → unhide, snap to top-right default, full size
   *   visible + full        → minimize
   *   visible + minimized   → restore
   *
   * The hidden→unhide branch also clears inline left/top/right so the CSS
   * rule's right:12;top:12 reapplies — drag is a within-session affordance,
   * not a persistent placement. The visible-toggle branch keeps whatever
   * position the panel currently has (drag-during-min/restore stays put). */
  function reopen() {
    if (ui.style.display === "none") {
      ui.style.display = "flex";
      ui.style.left = ui.style.top = ui.style.right = "";
      setMin(false);
      ui.scrollIntoView({block: "center"});
      return;
    }
    setMin(!minimized);
  }
  /* Click anywhere on the minimized strip → restore. xbtn handles itself
   * (stopPropagation prevents this listener from firing on the × click).
   * Drag-to-move on the header is excluded explicitly via didDrag —
   * relying on browser "click suppressed after significant travel"
   * behavior turned out unreliable for slow/short drags on the strip. */
  ui.addEventListener("click", function (e) {
    if (didDrag) { didDrag = false; return; }
    if (minimized && e.target !== xbtn) setMin(false);
  });
  ui.__bcReopen = reopen;

  document.body.appendChild(ui);
  window.__bcrpc__ = ui;
})();
