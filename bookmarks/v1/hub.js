/* hub.js — PlatoKit: Exit sample hub (v0.7).
 *
 * Lives at the HUB origin, nested inside the collar iframe. Talks only to
 * the collar via port (bound after the two-stage handshake). The collar
 * brokers every message to the bookmark and runs §5 policy.
 *
 * The hub cannot invoke collar-only caps (collar drops them with NOT_ALLOWED
 * per §5.1). It can invoke rd, ov, sc, rs when the user has granted them via
 * the host-page checkboxes.
 *
 * This file is intentionally chatty in console.log — the hub is T3
 * (untrusted by structure); console noise is fine and helps debugging.
 */
console.log("[bcrpc:hub] hub.js v0.7 loaded");
(function () {
  var P = "bc.v0";
  var s = new URLSearchParams(location.hash.slice(1)).get("s");
  console.log("[bcrpc:hub] session fragment:", s);

  /* Generated sample image — visible at any size, no network needed. */
  var SAMPLE_SVG =
    "data:image/svg+xml;utf8," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'>" +
        "<defs><linearGradient id='g' x1='0' x2='1' y2='1'>" +
          "<stop offset='0' stop-color='%230a5'/><stop offset='1' stop-color='%23063'/>" +
        "</linearGradient></defs>" +
        "<rect width='200' height='200' fill='url(%23g)' rx='14'/>" +
        "<circle cx='100' cy='80' r='38' fill='%23fff' opacity='0.95'/>" +
        "<text x='100' y='90' text-anchor='middle' font-family='system-ui' font-size='18' font-weight='bold' fill='%23063'>PK</text>" +
        "<text x='100' y='150' text-anchor='middle' font-family='system-ui' font-size='15' font-weight='bold' fill='%23fff'>PlatoKit</text>" +
        "<text x='100' y='172' text-anchor='middle' font-family='system-ui' font-size='11' fill='%23cfe'>Exit · sample overlay</text>" +
      "</svg>"
    );

  buildDOM();
  var statusEl = document.getElementById("status");
  function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = cls || ""; }
  setStatus("hub.js running · resolving peer…");

  if (!s) { console.error("[bcrpc:hub] missing session in fragment"); setStatus("missing session in fragment", "err"); return; }
  if (window.parent === window) { console.error("[bcrpc:hub] no parent — opened standalone?"); setStatus("no parent — hub opened standalone?", "err"); return; }
  var peer = window.parent;

  var port = null;
  var remoteGrants = {rd: false, ov: false, sc: false};
  var pending = new Map();
  var invokeCount = 0;

  var log = document.getElementById("log");
  function add(line, cls) {
    var span = document.createElement("span");
    span.className = cls || "";
    span.textContent = "[" + new Date().toLocaleTimeString() + "] " + line + "\n";
    log.appendChild(span);
    log.scrollTop = log.scrollHeight;
  }

  function refreshButtons() {
    var on = !!port;
    document.getElementById("rd-go").disabled = !(on && remoteGrants.rd);
    document.getElementById("ov-go").disabled = !(on && remoteGrants.ov);
    document.getElementById("sc-go").disabled = !(on && remoteGrants.sc);
  }

  function call(cap, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!port) { reject(new Error("no port")); return; }
      var id = crypto.randomUUID();
      invokeCount++;
      console.log("[bcrpc:hub] iv →", cap, "id=" + id.slice(0, 8), "payload=", payload);
      var timer = setTimeout(function () {
        pending.delete(id);
        console.warn("[bcrpc:hub] iv ✗ timeout", cap, id.slice(0, 8));
        reject(new Error("timeout invoking " + cap));
      }, timeoutMs || 15000);
      pending.set(id, {resolve: resolve, reject: reject, timer: timer, cap: cap, t0: performance.now()});
      port.postMessage({k: "iv", id: id, c: cap, pl: payload});
    });
  }

  function onPortMsg(e) {
    var d = e.data; if (!d) return;
    if (d.k === "gr") {
      var g = (d.pl && d.pl.grants) || {};
      remoteGrants = {rd: !!g.rd, ov: !!g.ov, sc: !!g.sc};
      /* Extension grants flow through here too; we don't render them in the
       * hub UI in v0.7, just log them. */
      var extKeys = Object.keys(g).filter(function (k) { return ["rd","ov","sc"].indexOf(k) < 0; });
      console.log("[bcrpc:hub] gr ← grants=", remoteGrants, "ext=", extKeys.length ? extKeys : "(none)");
      add("grants updated: " + JSON.stringify(remoteGrants) + (extKeys.length ? " · ext: " + extKeys.join(",") : ""), "dim");
      refreshButtons();
      return;
    }
    if (d.k === "rs" || d.k === "er") {
      var entry = pending.get(d.rt);
      if (!entry) { console.warn("[bcrpc:hub] reply for unknown id", d.rt); return; }
      pending.delete(d.rt); clearTimeout(entry.timer);
      var dt = Math.round(performance.now() - entry.t0);
      if (d.k === "rs") {
        console.log("[bcrpc:hub] rs ←", entry.cap, "id=" + String(d.rt).slice(0, 8), "·", dt + "ms", "pl=", d.pl);
        entry.resolve(d.pl);
      } else {
        console.warn("[bcrpc:hub] er ←", entry.cap, "id=" + String(d.rt).slice(0, 8), "·", dt + "ms", "code=", d.e && d.e.c, "m=", d.e && d.e.m);
        var err = new Error((d.e && d.e.c) || "remote error");
        err.code = d.e && d.e.c;
        entry.reject(err);
      }
      return;
    }
    /* iv on this side: collar invoking a cap toward us. v0.7 has none — but
     * if e.g. lg arrives here, log it (the boot-time lg fires UP to the
     * bookmark, not toward us). */
    if (d.k === "iv") {
      console.log("[bcrpc:hub] iv ←", d.c, "(unexpected — hub is invoker, not target in v0.7)");
      return;
    }
    if (d.k === "bye") {
      console.warn("[bcrpc:hub] bookmark said bye — teardown");
      add("bookmark says bye", "dim");
      try { port.close(); } catch (e) {} port = null;
      remoteGrants = {rd: false, ov: false, sc: false};
      refreshButtons();
      setStatus("agent disconnected", "err");
      return;
    }
  }

  function onPortReply(e) {
    var d = e.data;
    if (!d || d.p !== P || d.k !== "port" || d.s !== s) return;
    if (!e.ports || !e.ports[0]) { console.error("[bcrpc:hub] port reply lacked MessagePort"); add("port reply lacked MessagePort", "err"); return; }
    window.removeEventListener("message", onPortReply);
    port = e.ports[0];
    port.onmessage = onPortMsg;
    port.start();
    console.log("[bcrpc:hub] port bound · session=" + s.slice(0, 8) + " · RPC active");
    setStatus("connected · port bound", "ok");
    add("port bound — RPC active (via collar)", "ok");
    refreshButtons();
  }
  window.addEventListener("message", onPortReply);

  console.log("[bcrpc:hub] posting hi → window.parent (collar) · session=" + s.slice(0, 8));
  peer.postMessage({p: P, s: s, k: "hi"}, "*");
  add("sent hi → collar (window.parent)", "dim");
  setStatus("waiting for collar port transfer…");

  /* ---- button wiring ---- */
  document.getElementById("rd-go").onclick = function () {
    var sel = document.getElementById("rd-sel").value.trim();
    call("rd", sel ? {selector: sel} : {}).then(function (r) {
      var txt = (r && r.text) || "";
      var preview = txt.slice(0, 80).replace(/\s+/g, " ");
      add("rd ✓ read " + txt.length + " chars" + (sel ? " (selector: " + sel + ")" : " (full body)") + (txt ? ' · "' + preview + (txt.length > 80 ? "…" : "") + '"' : ""), "ok");
    }, function (e) { add("rd ✗ " + (e.code || e.message), "err"); });
  };

  document.getElementById("ov-go").onclick = function () {
    var url = document.getElementById("ov-url").value.trim() || SAMPLE_SVG;
    if (url === SAMPLE_SVG) console.log("[bcrpc:hub] ov using auto-generated sample SVG");
    var pl = {
      url: url,
      x: +document.getElementById("ov-x").value || 100,
      y: +document.getElementById("ov-y").value || 100,
      w: +document.getElementById("ov-w").value || 200,
      h: +document.getElementById("ov-h").value || 200,
      o: +document.getElementById("ov-o").value || 0.85
    };
    call("ov", pl).then(
      function (r) { add("ov ✓ id=" + r.id + " · placed at (" + pl.x + "," + pl.y + ") size " + pl.w + "×" + pl.h + " · opacity " + pl.o, "ok"); },
      function (e) { add("ov ✗ " + (e.code || e.message), "err"); });
  };

  document.getElementById("sc-go").onclick = function () {
    var top = +document.getElementById("sc-top").value || 300;
    call("sc", {top: top}).then(
      function (r) { add("sc ✓ scrolled by " + r.top + " px (requested " + top + ")", "ok"); },
      function (e) { add("sc ✗ " + (e.code || e.message), "err"); });
  };

  window.addEventListener("beforeunload", function () {
    console.log("[bcrpc:hub] beforeunload · invokes-this-session=" + invokeCount);
    if (port) { try { port.postMessage({k: "bye"}); port.close(); } catch (e) {} }
  });

  function buildDOM() {
    var style = document.createElement("style");
    style.textContent =
      "body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:14px;color:#111;background:#fafafa}" +
      "h1{font-size:17px;margin:0 0 4px}" +
      "h2{font-size:13px;margin:12px 0 4px}" +
      "#status{color:#555;margin-bottom:12px;font-size:13px}" +
      "#status.ok{color:#060}#status.err{color:#a00}" +
      "fieldset{border:1px solid #bbb;padding:8px 12px;margin:8px 0;background:#fff;border-radius:4px}" +
      "legend{font-weight:bold;padding:0 4px;font-size:13px}" +
      "button{padding:5px 12px;margin:3px 4px 0 0;cursor:pointer;font:inherit;font-size:12px}" +
      "button:disabled{opacity:.4;cursor:not-allowed}" +
      "pre#log{background:#111;color:#ddd;border:1px solid #333;padding:6px;height:140px;overflow:auto;" +
      "font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;margin:4px 0}" +
      ".ok{color:#6f6}.err{color:#f88}.dim{color:#888}" +
      "label{display:inline-block;margin:2px 6px 2px 0;font-size:12px}" +
      "input[type=text],input[type=number]{font:inherit;padding:2px 4px;box-sizing:border-box;font-size:12px}" +
      ".row{display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr 1fr;gap:4px;align-items:end}" +
      ".row label{display:block;margin:0;font-size:11px;color:#444}" +
      "small{color:#888;font-size:11px}";
    document.head.appendChild(style);
    document.body.innerHTML =
      '<h1>PlatoKit: Exit — hub</h1>' +
      '<div id="status">starting…</div>' +
      '<fieldset><legend>rd · read page text</legend>' +
        '<label>selector: <input id="rd-sel" type="text" placeholder="(blank = full body)" style="width:180px"></label>' +
        '<button id="rd-go" disabled>Invoke rd</button> ' +
        '<small>defaults: selection → body</small>' +
      '</fieldset>' +
      '<fieldset><legend>ov · overlay image (sample autogen if url blank)</legend>' +
        '<div class="row">' +
          '<label>url<br><input id="ov-url" type="text" placeholder="(blank = auto SVG sample)" style="width:100%"></label>' +
          '<label>x<br><input id="ov-x" type="number" value="60" style="width:100%"></label>' +
          '<label>y<br><input id="ov-y" type="number" value="80" style="width:100%"></label>' +
          '<label>w<br><input id="ov-w" type="number" value="200" style="width:100%"></label>' +
          '<label>h<br><input id="ov-h" type="number" value="200" style="width:100%"></label>' +
          '<label>op<br><input id="ov-o" type="number" min="0" max="1" step="0.1" value="0.9" style="width:100%"></label>' +
        '</div>' +
        '<button id="ov-go" disabled>Invoke ov</button>' +
      '</fieldset>' +
      '<fieldset><legend>sc · scroll (smooth, clamped to ±innerHeight)</legend>' +
        '<label>top: <input id="sc-top" type="number" value="300" style="width:80px"></label>' +
        '<button id="sc-go" disabled>Invoke sc</button>' +
      '</fieldset>' +
      '<small>The host-page panel is draggable by its header and resizable from its bottom-right corner.</small>' +
      '<h2>log</h2><pre id="log"></pre>';
  }
})();
