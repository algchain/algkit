/* collar.js — PlatoKit: Exit collar (v0.7 + uapp-swap + K1 + S1).
 *
 * The trusted broker (T2) between the bookmark (T1) and the active uapp
 * (T3). Spec: ../spec_collar.md (normative) + ../plan_v1_plus.md (v1+
 * additions: uapp-swap, vp viewport hints, K1 keep-alive, S1 persistence).
 * All v1+ additions are backward-compatible with v0.7 bookmarks.
 *
 * Position:
 *   host page → collar iframe (this, at HUB origin) → nested uapp iframes.
 *
 * Two channels, two roles, gatekeeper in the middle:
 *
 *   port_up         ↔ bookmark    (one, stable for the session)
 *   port_down[name] ↔ uapp name   (one per uapp, K1: kept alive across swaps)
 *
 *   The bus (B1, future) would fan out across port_down's only — it would
 *   NEVER touch port_up. That's the structural property that keeps inter-
 *   uapp messaging invisible to the trust anchor.
 *
 * K1 keep-alive semantics:
 *   - Swap = hide old iframe, show new (or create on first swap).
 *   - port_down for each bound uapp persists; state is preserved.
 *   - gr / rs / er / bye from bookmark → broadcast to all bound uapps.
 *   - iv from any bound uapp → forwarded up (the user's grant checkbox
 *     still gates at the bookmark; in-flight calls finish even after swap).
 *   - vp from non-active uapp → DROPPED (hidden uapps cannot resize panel).
 *
 * Up direction (uapp → bookmark) for iv passes through:
 *   §5.1 CAP_SCOPE → §5.2 size cap → §5.3 version pin → §5.4 VALIDATORS
 */
console.log("[bcrpc:collar] collar.js v0.7+ (K1) loaded");
(function () {
  var P = "bc.v0";
  var s = new URLSearchParams(location.hash.slice(1)).get("s");
  if (!s) { console.error("[bcrpc:collar] missing session in fragment"); return; }

  /* ---- UAPP registry (v1+) ----
   * Adding a uapp = add an entry here + drop the file under /uapps/.
   * Insertion order is button order in the bar. size{w,h} is forwarded
   * to the bookmark as a vp hint on activation.
   */
  /* Relative srcs (no leading "/"): resolve against the collar's URL, so
   * they work whether the HUB sits at origin root (dev) or in a subdirectory
   * (GH Pages, https://algchain.github.io/algkit/bookmarks/v1/...). The
   * srcIsAllowed validator below handles both relative and absolute forms
   * via the URL constructor with location.href as the base. */
  var UAPPS = {
    chat: { label: "Chat", src: "uapps/chat.html", size: {w: 540, h: 640}, locked: true },
    hub:  { label: "Hub",  src: "hub.html",        size: {w: 360, h: 520}, locked: true },
    add:  { label: "Add",  src: "uapps/add.html",  size: {w: 460, h: 480}, locked: true, admin: true },
  };
  var DEFAULT_UAPP = "chat";
  /* User-installed uapps live in localStorage at HUB origin. They get merged
   * into UAPPS on boot (validated each time) and persisted whenever Add
   * mutates the registry. `locked` = built-in (no remove). `admin` = may
   * invoke the `ua` admin kind (only Add today).
   *
   * Two flavors:
   *   url    — entry has `src`: a URL the iframe loads from (same-origin,
   *            localhost http, or any https — see srcIsAllowed).
   *   paste  — entry has `html`: literal HTML the collar wraps in a Blob
   *            at boot, producing a blob: URL with HUB origin. Stored as
   *            html to survive page reloads (blob URLs are doc-scoped).
   *
   * Validation runs both at write-time (ua add) and read-time (loadUserUapps),
   * so tampering with localStorage cannot smuggle bad entries in. */
  var UAPPS_KEY = "bcrpc.registry.uapps";
  var UAPP_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
  var HTML_MAX = 256 * 1024;   /* matches SIZE_CAP — same ceiling as a port message */
  function srcIsAllowed(src) {
    if (typeof src !== "string" || !src) return false;
    if (src.charAt(0) === "/" && src.charAt(1) !== "/") return true;
    try {
      var u = new URL(src, location.href);
      if (u.origin === location.origin) return true;
      if (u.protocol === "https:") return true;
      if (u.protocol === "http:" &&
          (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
      return false;
    } catch (e) { return false; }
  }
  function htmlToBlobSrc(html) {
    try { return URL.createObjectURL(new Blob([html], {type: "text/html"})); }
    catch (e) { return null; }
  }
  function loadUserUapps() {
    var raw; try { raw = localStorage.getItem(UAPPS_KEY); } catch (e) { return; }
    if (!raw) return;
    var arr; try { arr = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(arr)) return;
    arr.forEach(function (u) {
      if (!u || !UAPP_NAME_RE.test(u.name) || UAPPS[u.name]) return;
      var entrySrc = null, html = null;
      if (typeof u.html === "string" && u.html.length > 0 && u.html.length <= HTML_MAX) {
        html = u.html;
        entrySrc = htmlToBlobSrc(html);
        if (!entrySrc) return;
      } else if (srcIsAllowed(u.src)) {
        entrySrc = String(u.src);
      } else { return; }
      var sz = (u.size && typeof u.size === "object") ? u.size : {};
      UAPPS[u.name] = {
        label: String(u.label || u.name).slice(0, 32),
        src: entrySrc,
        size: { w: Math.max(200, Math.min(1200, +sz.w || 460)),
                h: Math.max(200, Math.min(1200, +sz.h || 480)) },
        pasted: !!html,
        _html: html,
      };
    });
  }
  function persistUserUapps() {
    var out = Object.keys(UAPPS).filter(function (k) { return !UAPPS[k].locked; })
      .map(function (k) {
        var u = UAPPS[k];
        var ent = { name: k, label: u.label, size: u.size };
        if (u._html) ent.html = u._html;       /* paste — re-blob'd each boot */
        else ent.src = u.src;
        return ent;
      });
    try { localStorage.setItem(UAPPS_KEY, JSON.stringify(out)); } catch (e) {}
  }
  loadUserUapps();

  /* ---- Per-uapp panel size memory (foreshadows S1-backed config) ----
   *
   * Each uapp has a "natural" size in UAPPS[name].size — what it asks for
   * on first activation. After that, if the user drags the panel corner,
   * we attribute the new size to the active uapp and remember it. Next
   * time the user swaps to that uapp, we push the saved size up to the
   * bookmark instead of the registry default. The panel feels permanent:
   * chat at 540×640 (or whatever you dragged it to), hub at 360×520, etc.
   *
   * Stored at HUB origin under `bcrpc.layout.uapps`. This is collar-internal
   * config — not exposed via the `st` kind. Future work folds it into the
   * broader system-config schema (see plan_v1_plus.md S1+); the key name
   * is forward-compatible — the data shape is {name: {w,h}} which the S1
   * layer can ingest as-is.
   *
   * Self-resize attribution:
   *   When we push vp, the bookmark resizes its panel, which resizes our
   *   iframe, which fires our ResizeObserver. We must NOT attribute that
   *   to the user. lastVpAt is the timestamp of our most recent vp; any
   *   RO fire within RESIZE_GRACE_MS is ignored as self-induced.
   *
   * Overhead correction:
   *   The bookmark's vp pl is panel size; our window.innerWidth/Height is
   *   collar-iframe size. Panel = collar + (header + status + chip-row).
   *   We learn the overhead on first vp by comparing requested-vs-observed,
   *   then add it back when saving so saved values stay panel-shaped.
   */
  /* Layout-storage schema v2. Bumped from v1 (which used the bare key
   * "bcrpc.layout.uapps") because v1 saves were corrupted by a broken
   * runtime overhead probe — the probe ran before the bookmark had
   * actually applied vp, so `lastVpReq − innerWidth` measured the wrong
   * thing and inflated saved values by hundreds of px. Using a new key
   * leaves the corrupt v1 data orphaned in localStorage and starts fresh. */
  var LAYOUT_KEY = "bcrpc.layout.uapps.v2";

  /* Bookmark panel chrome overhead (panel size − collar viewport size).
   * Hardcoded from the bookmark's CSS layout — runtime measurement turned
   * out to be unreliable:
   *   - bookmark applies vp asynchronously, so the post-resize RO fire
   *     happens at unpredictable times (Puter.js can stall the shared
   *     event loop for hundreds of ms);
   *   - if the host viewport is small the bookmark clamps the panel to
   *     96vw/96vh, making `lastVpReq − innerSize` measure the clamp,
   *     not the chrome overhead.
   * Stable for any v0.7.x bookmark. A bookmark layout change requires
   * a matching update here.
   *
   * Composition (vertical):
   *   panel padding-top    10
   *   header               28
   *   permsLabel           24
   *   permsHost (1 chip row) 26
   *   frameWrap margin-top  8
   *   panel padding-bottom 10
   *   = 106 ≈ H_OVERHEAD
   * (the status line is display:none on the connected/ok state, so we
   * tune to the steady-state — slight under-size during early boot)
   *
   * Horizontal:
   *   panel padding L+R    20 = W_OVERHEAD
   */
  var W_OVERHEAD = 20;
  var H_OVERHEAD = 106;

  /* Saves are paused (treated as self-induced settling) for this many ms
   * after every vp push, and for BOOT_PAUSE_MS after collar boot. Boot is
   * generous because Puter.js loading inside chat (same-origin iframe →
   * shared event loop) can delay RO callbacks well past a tight grace. */
  var SAVE_PAUSE_MS = 1500;
  var BOOT_PAUSE_MS = 3000;

  var savedLayouts = {};
  try {
    var lraw = localStorage.getItem(LAYOUT_KEY);
    if (lraw) { var parsed = JSON.parse(lraw); if (parsed && typeof parsed === "object") savedLayouts = parsed; }
  } catch (e) {}
  console.log("[bcrpc:collar] layout: loaded savedLayouts =", JSON.stringify(savedLayouts));

  var layoutArmed = false;     /* false until first pushVp — blocks bogus saves
                                * from the initial ResizeObserver fire. */
  var savesPausedUntil = Date.now() + BOOT_PAUSE_MS;
  var saveTimer = null;

  function effectiveSize(name) {
    if (savedLayouts[name]) return savedLayouts[name];
    return (UAPPS[name] && UAPPS[name].size) || null;
  }
  function persistLayouts() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(savedLayouts)); } catch (e) {}
  }
  function pushVp(size) {
    if (!port_up || !size) return;
    layoutArmed = true;
    savesPausedUntil = Math.max(savesPausedUntil, Date.now() + SAVE_PAUSE_MS);
    try { port_up.postMessage({k: "vp", pl: size}); } catch (e) {}
  }
  function captureUserResize() {
    if (!activeName || !layoutArmed) return;
    if (Date.now() < savesPausedUntil) return;   /* pause = self-induced settle */
    var w = window.innerWidth, h = window.innerHeight;
    /* Translate collar viewport back to panel size by adding the hardcoded
     * chrome overhead. Round-trip: save (innerW + W_OH, innerH + H_OH);
     * on restore push that as vp; bookmark sets panel = saved; collar
     * inner becomes saved − overhead = original innerW × innerH. Stable. */
    var pw = w + W_OVERHEAD, ph = h + H_OVERHEAD;
    if (pw < 200 || pw > 4000 || ph < 200 || ph > 4000) return;
    var name = activeName;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      savedLayouts[name] = {w: pw, h: ph};
      persistLayouts();
      console.log("[bcrpc:collar] layout: saved", name, "=", pw + "×" + ph);
    }, 120);
  }
  if (typeof ResizeObserver === "function") {
    try { new ResizeObserver(captureUserResize).observe(document.documentElement); }
    catch (e) { /* old browser without RO on html — quietly skip persistence */ }
  }
  /* Backup signal — some browsers don't always fire RO on cross-document
   * iframe resizes triggered by the host's CSS resize handle. */
  window.addEventListener("resize", captureUserResize);

  /* §5.1 CAP_SCOPE (R7 enforcement). */
  var CAP_SCOPE = {
    rd: ["hub", "collar"],
    ov: ["hub", "collar"],
    sc: ["hub", "collar"],
  };

  /* §5.4 VALIDATORS. */
  var overlay_count = 0;
  var VALIDATORS = {
    rd: function (pl) {
      pl = pl || {};
      return { selector: typeof pl.selector === "string" ? pl.selector : null };
    },
    ov: function (pl) {
      pl = pl || {};
      if (!/^(https:|data:image\/)/i.test(String(pl.url || ""))) throw new Error("BAD_SCHEME");
      var w = +pl.w | 0, h = +pl.h | 0;
      if (w <= 0 || w > 4096 || h <= 0 || h > 4096) throw new Error("DIM_CAP");
      if (w * h > 16e6) throw new Error("AREA_CAP");
      var o = pl.o == null ? 1 : +pl.o;
      if (!(o >= 0 && o <= 1)) throw new Error("OPACITY_BOUNDS");
      if (overlay_count >= 50) throw new Error("COUNT_CAP");
      overlay_count++;
      return { url: String(pl.url), x: +pl.x|0, y: +pl.y|0, w: w, h: h, o: o };
    },
    sc: function (pl) {
      pl = pl || {};
      var top = +pl.top || 0;
      var ih = (typeof window !== "undefined") ? window.innerHeight : 800;
      return { top: Math.max(-ih, Math.min(ih, top)) };
    },
  };

  /* §5.2 payload size cap. */
  var SIZE_CAP = 262_144;
  function sizeOk(d) { try { return JSON.stringify(d).length <= SIZE_CAP; } catch (e) { return false; } }

  /* ---- S1: persistence ----
   * Uapps get a {get, set, remove} storage API via the `st` kind. Replies
   * are `sr`. Both are collar-internal — they NEVER cross port_up. The
   * gatekeeper property (collar mediates everything its uapps see) extends
   * to storage: uapps can't reach localStorage directly, only through here.
   *
   * Backed by localStorage at HUB origin. Every key is prefixed with
   * `bcrpc.st.` to avoid collisions with Puter.js / future tenants.
   *
   * Scopes:
   *   - "uapp"   (default): key namespaced under the calling uapp's name.
   *                         Other uapps cannot read.
   *   - "shared": key in a single shared namespace. Explicit opt-in on BOTH
   *               producer and consumer sides. Use with deliberate contract.
   *
   * Protocol:
   *   uapp → collar: {k:"st", id, op:"get"|"set"|"remove",
   *                   scope?:"uapp"|"shared", key, value?}
   *   collar → uapp: {k:"sr", rt:id, ok:bool, value?, error?}
   *
   * On `get` for a missing key: {ok:true, value:null}.
   * Errors: BAD_OP, BAD_KEY, NO_VALUE, NOT_SERIALIZABLE, QUOTA, TOO_LARGE.
   */
  var ST_PREFIX = "bcrpc.st.";
  var ST_KEY_RE = /^[A-Za-z0-9_./:-]{1,128}$/;
  var ST_OPS = {get: 1, set: 1, remove: 1};

  function stFullKey(uappName, scope, key) {
    var ns = (scope === "shared") ? "shared:" : ("uapp:" + uappName + ":");
    return ST_PREFIX + ns + key;
  }
  function stReply(uappName, id, ok, value, error) {
    var st = uappState[uappName];
    if (!st || !st.port_down) return;
    var msg = {k: "sr", rt: id, ok: ok};
    if (value !== undefined) msg.value = value;
    if (error) msg.error = error;
    try { st.port_down.postMessage(msg); } catch (x) {}
  }
  /* ---- ua: registry admin (Add uapp only) ----
   * Collar-internal kind. Replies on `ur`. NEVER crosses port_up.
   * Scope: requester must have UAPPS[name].admin === true (the Add uapp).
   * Other uapps get ADMIN_DENIED — same property as CAP_SCOPE for bookmark
   * caps, except the scope check lives here because `ua` is collar-only.
   *
   * Ops:
   *   list   — returns [{name, label, src, size, locked, admin}, ...]
   *   add    — {name, src, label?, size?} → validate, register, persist
   *   remove — {name} → unregister (locked + active are refused), persist
   */
  function uaReply(uappName, id, ok, value, error) {
    var st = uappState[uappName];
    if (!st || !st.port_down) return;
    var msg = { k: "ur", rt: id, ok: !!ok };
    if (value !== undefined) msg.value = value;
    if (error) msg.error = error;
    try { st.port_down.postMessage(msg); } catch (x) {}
  }
  function handleUappAdmin(uappName, d) {
    if (!UAPPS[uappName] || !UAPPS[uappName].admin) {
      return uaReply(uappName, d.id, false, undefined, "ADMIN_DENIED");
    }
    var op = String(d.op || "");
    if (op === "list") {
      var list = Object.keys(UAPPS).map(function (k) {
        var u = UAPPS[k];
        var ext = false;
        if (!u.pasted) {
          try { ext = new URL(u.src, location.href).origin !== location.origin; } catch (e) {}
        }
        return { name: k, label: u.label, src: u.src, size: u.size,
                 locked: !!u.locked, admin: !!u.admin,
                 external: ext, pasted: !!u.pasted };
      });
      return uaReply(uappName, d.id, true, list);
    }
    if (op === "add") {
      var n = String(d.name || "").trim();
      if (!UAPP_NAME_RE.test(n)) return uaReply(uappName, d.id, false, undefined, "BAD_NAME");
      if (UAPPS[n]) return uaReply(uappName, d.id, false, undefined, "NAME_TAKEN");
      var entrySrc = null, htmlBody = null;
      if (typeof d.html === "string" && d.html.length > 0) {
        if (d.html.length > HTML_MAX) return uaReply(uappName, d.id, false, undefined, "HTML_TOO_LARGE");
        htmlBody = d.html;
        entrySrc = htmlToBlobSrc(htmlBody);
        if (!entrySrc) return uaReply(uappName, d.id, false, undefined, "BLOB_FAILED");
      } else {
        var src = String(d.src || "").trim();
        if (!srcIsAllowed(src)) return uaReply(uappName, d.id, false, undefined, "BAD_SRC");
        entrySrc = src;
      }
      var sz = (d.size && typeof d.size === "object") ? d.size : {};
      UAPPS[n] = {
        label: String(d.label || n).slice(0, 32),
        src: entrySrc,
        size: { w: Math.max(200, Math.min(1200, +sz.w || 460)),
                h: Math.max(200, Math.min(1200, +sz.h || 480)) },
        pasted: !!htmlBody,
        _html: htmlBody,
      };
      persistUserUapps();
      renderUappBar();
      return uaReply(uappName, d.id, true);
    }
    if (op === "remove") {
      var rn = String(d.name || "").trim();
      if (!UAPPS[rn]) return uaReply(uappName, d.id, false, undefined, "NOT_FOUND");
      if (UAPPS[rn].locked) return uaReply(uappName, d.id, false, undefined, "LOCKED");
      if (rn === activeName) return uaReply(uappName, d.id, false, undefined, "ACTIVE");
      var st = uappState[rn];
      if (st) {
        if (st.port_down) { try { st.port_down.close(); } catch (e) {} }
        if (st.frame)     { try { st.frame.remove();   } catch (e) {} }
        delete uappState[rn];
      }
      /* Free the blob URL for pasted uapps — these aren't garbage-collected
       * until explicitly revoked. */
      if (UAPPS[rn].pasted && UAPPS[rn].src) {
        try { URL.revokeObjectURL(UAPPS[rn].src); } catch (e) {}
      }
      delete UAPPS[rn];
      /* Drop any saved layout for the removed uapp so we don't accumulate
       * orphan entries. If the same name is re-added later it starts at
       * registry default again — fresh slate. */
      if (savedLayouts[rn]) { delete savedLayouts[rn]; persistLayouts(); }
      persistUserUapps();
      renderUappBar();
      return uaReply(uappName, d.id, true);
    }
    return uaReply(uappName, d.id, false, undefined, "BAD_OP");
  }

  function handleStorage(uappName, d) {
    var id = d.id;
    var op = String(d.op || "");
    var scope = (d.scope === "shared") ? "shared" : "uapp";
    var key = d.key;
    if (!ST_OPS[op]) return stReply(uappName, id, false, undefined, "BAD_OP");
    if (typeof key !== "string" || !ST_KEY_RE.test(key)) return stReply(uappName, id, false, undefined, "BAD_KEY");

    var fullKey = stFullKey(uappName, scope, key);
    try {
      if (op === "get") {
        var raw = localStorage.getItem(fullKey);
        var val = (raw == null) ? null : JSON.parse(raw);
        return stReply(uappName, id, true, val);
      }
      if (op === "set") {
        if (!("value" in d)) return stReply(uappName, id, false, undefined, "NO_VALUE");
        var str;
        try { str = JSON.stringify(d.value); }
        catch (e) { return stReply(uappName, id, false, undefined, "NOT_SERIALIZABLE"); }
        if (str.length > SIZE_CAP) return stReply(uappName, id, false, undefined, "TOO_LARGE");
        try { localStorage.setItem(fullKey, str); }
        catch (e) { return stReply(uappName, id, false, undefined, "QUOTA"); }
        return stReply(uappName, id, true);
      }
      if (op === "remove") {
        localStorage.removeItem(fullKey);
        return stReply(uappName, id, true);
      }
    } catch (e) {
      return stReply(uappName, id, false, undefined, "EXC:" + (e.message || e));
    }
  }

  /* ---- state ---- */
  var frameHost = document.getElementById("frame-host");
  var uappsBar  = document.getElementById("uapps");
  var port_up = null;
  var activeName = null;
  var lastGrants = null;

  /* uappState[name] = {
   *   frame:     <iframe>          — the nested element (may be display:none)
   *   port_down: MessagePort       — collar↔uapp; null until handshake completes
   *   hubWin:    Window            — frame.contentWindow at hi time
   *   bound:     boolean           — true once port_down is live
   *   hiListener:fn or null        — pending message listener for stage-1 hi
   * } */
  var uappState = {};

  /* v0.7.7: collar issues its own hi to the bookmark at boot, independent of
   * any uapp. port_up binds from that round-trip directly, so the first vp
   * fires the moment port_up is alive — chat.html's Puter.js download is no
   * longer on the critical path for the host panel's first resize.
   *
   * tryBindUapp (defined below) is the single chokepoint that mints port_down
   * for a uapp once BOTH conditions are true: port_up is bound AND the uapp's
   * hubWin has been recorded (its hi arrived). Either one can land first; the
   * second arrival triggers the bind. No bootPromise queue any more. */

  /* ---- uapp bar ---- */
  function renderUappBar() {
    uappsBar.innerHTML = "";
    Object.keys(UAPPS).forEach(function (k) {
      var u = UAPPS[k];
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.uapp = k;
      b.title = u.pasted ? "pasted html (blob:)" : u.src;
      if (k === activeName) b.className = "active";
      b.textContent = u.label;
      /* Tiny blue dot marks user-installed (non-locked) entries — quick
       * visual cue that these came in via Add, not the built-in registry. */
      if (!u.locked) {
        var dot = document.createElement("span");
        dot.textContent = " •";
        dot.style.cssText = "color:#1a73e8;font-size:14px;line-height:0";
        b.appendChild(dot);
      }
      b.onclick = function () { if (k !== activeName) swapTo(k); };
      uappsBar.appendChild(b);
    });
  }

  /* ---- forwarding ----
   * makeForwardUp returns a per-uapp port_down.onmessage handler. It knows
   * which uapp it's serving (via closure on name), so policy can branch on
   * active vs hidden.
   *
   * Bus (B1, future) would extend this: a uapp-level kind like {k:"bp",...}
   * is intercepted here and fanned out to subscribed port_downs WITHOUT
   * reaching port_up. */
  function policyUp(d) {
    if (d && d.k === "iv") {
      var scope = CAP_SCOPE[d.c];
      if (!scope || scope.indexOf("hub") < 0) {
        return { drop: true, reply: { k: "er", rt: d.id, e: { c: "NOT_ALLOWED", m: d.c } } };
      }
      var v = VALIDATORS[d.c];
      if (v) {
        try { d = Object.assign({}, d, { pl: v(d.pl || {}) }); }
        catch (e) { return { drop: true, reply: { k: "er", rt: d.id, e: { c: String(e.message || e), m: d.c } } }; }
      }
    }
    return { data: d };
  }

  function makeForwardUp(name) {
    return function (e) {
      if (!port_up) return;
      var st = uappState[name];
      var d = e.data;
      if (!sizeOk(d)) {
        if (st && st.port_down) try { st.port_down.postMessage({k:"er", rt:(d && d.id) || null, e:{c:"PAYLOAD_TOO_LARGE"}}); } catch (x) {}
        return;
      }
      /* S1: storage requests are collar-internal — never leave T2. */
      if (d && d.k === "st") {
        handleStorage(name, d);
        return;
      }
      /* ua: registry-admin. Scope check inside (admin-only). Never leaves T2. */
      if (d && d.k === "ua") {
        handleUappAdmin(name, d);
        return;
      }
      /* Drop ALL `vp` from uapps. Layout is collar-driven: pushVp() on swap
       * uses savedLayouts (user-dragged) or registry size, and that path
       * stamps lastVpReq/savesPausedUntil so RO callbacks are correctly
       * classified. A uapp's runtime vp would slip past those guards,
       * cause an extra panel resize, and the late RO fire would be
       * misclassified as user-driven — overwriting the saved layout
       * with chat's hardcoded hint. (See change_log 2026-05-22 vp drop.) */
      if (d && d.k === "vp") {
        console.log("[bcrpc:collar] vp from uapp dropped:", name, JSON.stringify(d.pl));
        return;
      }
      var res = policyUp(d);
      if (res.drop) {
        if (res.reply && st && st.port_down) try { st.port_down.postMessage(res.reply); } catch (x) {}
        return;
      }
      port_up.postMessage(res.data);
    };
  }

  /* forwardDown: messages from the bookmark (gr / rs / er / bye / px).
   * Broadcasts to every bound uapp's port_down. rs/er with unknown rt are
   * harmlessly ignored by the receiving uapp; gr keeps every uapp in sync. */
  function forwardDown(e) {
    var d = e.data;
    if (!sizeOk(d)) {
      var act = uappState[activeName];
      if (act && act.port_down) try { act.port_down.postMessage({k:"er", rt:(d && d.id) || null, e:{c:"PAYLOAD_TOO_LARGE"}}); } catch (x) {}
      return;
    }
    if (d && d.k === "gr") {
      lastGrants = (d.pl && d.pl.grants) || lastGrants;
    }
    Object.keys(uappState).forEach(function (name) {
      var st = uappState[name];
      if (st && st.port_down) {
        try { st.port_down.postMessage(d); } catch (x) {}
      }
    });
  }

  /* ---- ensureBound / showUapp / swapTo ----
   * ensureBound creates a uapp's iframe + runs the bc.v0 handshake the
   * first time the user activates it. On subsequent activations the
   * iframe and port_down are reused — chat history, Puter auth state in
   * Puter's own localStorage, etc. all persist.
   *
   * showUapp toggles display so only the active uapp's frame is visible,
   * and pushes a vp hint up so the host panel can resize. */
  /* tryBindUapp: mint port_down for a uapp if both prerequisites are met —
   * the uapp's hubWin (recorded when its hi arrived) AND port_up. Idempotent;
   * called from ensureBound's onHi (uapp side ready) and onPortFromParent
   * (port_up side ready). Whichever lands second triggers the bind. */
  function tryBindUapp(name) {
    var st = uappState[name];
    if (!st || !st.hubWin || st.bound || !port_up) return;
    var ch = new MessageChannel();
    st.port_down = ch.port1;
    st.port_down.onmessage = makeForwardUp(name);
    st.port_down.start();
    st.hubWin.postMessage({p: P, s: s, k: "port"}, "*", [ch.port2]);
    if (lastGrants) { try { st.port_down.postMessage({k: "gr", pl: {grants: lastGrants}}); } catch (e) {} }
    st.bound = true;
    if (st._bindResolve) {
      var r = st._bindResolve;
      delete st._bindResolve; delete st._bindReject;
      r(st);
    }
  }

  function ensureBound(name) {
    var st = uappState[name];
    if (st && st.bound) return Promise.resolve(st);
    if (!UAPPS[name]) return Promise.reject(new Error("unknown uapp: " + name));
    var u = UAPPS[name];

    return new Promise(function (resolve, reject) {
      if (!st) {
        st = uappState[name] = {frame:null, port_down:null, hubWin:null, bound:false, hiListener:null};
      }
      st._bindResolve = resolve;
      st._bindReject = reject;

      /* Iframe is created hidden; showUapp will reveal it once the caller
       * decides it's the active one. This avoids a visual flash if we ever
       * bind a uapp in the background (today only the active one is bound,
       * but the shape allows pre-binding). */
      var fr = document.createElement("iframe");
      fr.src = u.src + "#s=" + s;
      fr.referrerPolicy = "no-referrer";
      fr.style.display = "none";
      fr.dataset.uapp = name;
      frameHost.appendChild(fr);
      st.frame = fr;

      function onHi(e) {
        var d = e.data;
        if (!d || d.p !== P || d.k !== "hi" || d.s !== s) return;
        if (!st.frame || e.source !== st.frame.contentWindow) return;
        window.removeEventListener("message", onHi);
        st.hiListener = null;
        st.hubWin = e.source;
        /* No-op if port_up isn't bound yet — onPortFromParent will sweep all
         * uapps once port_up arrives, calling tryBindUapp on each. */
        tryBindUapp(name);
      }
      st.hiListener = onHi;
      window.addEventListener("message", onHi);
    });
  }

  function showUapp(name) {
    Object.keys(uappState).forEach(function (n) {
      var st = uappState[n];
      if (st && st.frame) st.frame.style.display = (n === name ? "" : "none");
    });
    activeName = name;
    renderUappBar();
    /* Use saved-layout if present (user has dragged this uapp before),
     * otherwise the registry default. pushVp tracks lastVpAt so the
     * resulting RO fire is correctly attributed to us, not the user. */
    pushVp(effectiveSize(name));
    console.log("[bcrpc:collar] active uapp →", name);
  }

  function swapTo(name) {
    if (!UAPPS[name]) { console.warn("[bcrpc:collar] unknown uapp:", name); return; }
    if (activeName === name) return;
    /* Optimistically update the button highlight so the click feels
     * responsive even if ensureBound has to wait on a slow load. */
    activeName = name;
    renderUappBar();
    ensureBound(name).then(function () { showUapp(name); }, function (err) {
      console.error("[bcrpc:collar] bind failed for", name, "·", err);
    });
  }

  /* ---- handshake stage 2: parent → collar "port" with port2 ----
   * v0.7.7: independent of any uapp's load progress. Collar issued hi at
   * boot, bookmark replied with port, we bind port_up here and IMMEDIATELY
   * push vp using the active uapp's saved layout (which lives in HUB
   * localStorage, accessible synchronously). Then we sweep uapps known to
   * ensureBound — any whose hi already arrived gets bound now; later
   * arrivals go through ensureBound's onHi → tryBindUapp directly. */
  function onPortFromParent(e) {
    var d = e.data;
    if (!d || d.p !== P || d.k !== "port" || d.s !== s) return;
    if (e.source !== window.parent) return;
    if (!e.ports || !e.ports[0]) { console.error("[bcrpc:collar] no MessagePort in port reply"); return; }
    window.removeEventListener("message", onPortFromParent);

    port_up = e.ports[0];
    port_up.onmessage = forwardDown;
    port_up.start();

    /* First-vp latency win: push the active uapp's saved size NOW, regardless
     * of whether the uapp iframe has finished loading. Bookmark applies it
     * to its panel; collar's smooth-resize transition (v0.7.7 bookmark) keeps
     * it visually clean. The same vp will be pushed again from showUapp once
     * the uapp binds — same size, no second visible jump. */
    pushVp(effectiveSize(activeName));

    console.log("[bcrpc:collar] port_up bound · " + P + " · session " + s.slice(0, 8) + " · active=" + activeName);

    /* Sweep: bind port_down for any uapp whose hi has already arrived. */
    Object.keys(uappState).forEach(tryBindUapp);
  }
  window.addEventListener("message", onPortFromParent);

  /* ---- boot ----
   * v0.7.7: kick off the bookmark↔collar handshake immediately. The active
   * uapp's iframe loads in parallel — its hi arrives whenever it's ready
   * (Puter.js download etc), and tryBindUapp glues the two threads back
   * together. Decoupling means port_up binding (and therefore the first vp)
   * doesn't wait for any uapp to finish loading. */
  activeName = DEFAULT_UAPP;
  renderUappBar();
  if (window.parent === window) {
    console.error("[bcrpc:collar] no parent window — bookmark host not present?");
    return;
  }
  /* Synchronous post — runs as soon as collar.js's IIFE reaches this line.
   * The bookmark has its onHi listener installed since before the iframe
   * was even created, so this round-trip starts the moment we get here. */
  window.parent.postMessage({p: P, s: s, k: "hi"}, "*");

  ensureBound(DEFAULT_UAPP).then(function () { showUapp(DEFAULT_UAPP); }, function (err) {
    console.error("[bcrpc:collar] boot bind failed:", err);
  });
})();
