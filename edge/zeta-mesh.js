/*! zeta-mesh.js — "if one tab is alive, zeta is alive."
 *
 * Drop-in mesh node for any page on the zeta origin. No deps, no build step.
 * Protocol-compatible with gitpull.html: same channel ("zeta-mesh"), same
 * per-tab identity key ("zeta-edge-nodeid"), same beacon shape
 * {v:1, kind:"beacon"|"dark", id, seq, head, yin, t} — so a gitpull tab and a
 * homepage tab discover each other. Fold is LWW-by-seq per id: commutative and
 * idempotent, so arrival order and replays are irrelevant by construction.
 *
 * Usage (plain page):
 *   <script src="edge/zeta-mesh.js"></script>
 *   <zeta-mesh-pip></zeta-mesh-pip>            inline chip (opens downward)
 *   <zeta-mesh-pip float></zeta-mesh-pip>      chip that opens its panel upward
 *
 * Usage (DC template):
 *   <x-import component-from-global-scope="zeta-mesh-pip" from="./edge/zeta-mesh.js"
 *             hint-size="150px,24px"></x-import>
 *
 * API (singleton, shared by every pip on the page):
 *   ZetaMesh.id            this tab's node id
 *   ZetaMesh.snapshot()    {id, alive, tabs, peers[], wsStatus, lastAlive}
 *   ZetaMesh.on(fn)/off(fn)  subscribe to snapshots (fires immediately on `on`)
 *   ZetaMesh.announce()    beacon now (also runs every 5s)
 *   ZetaMesh.send(msg)     raw message onto every transport
 *   ZetaMesh.inject(msg)   fold a message locally (test/sim hook; BC has no loopback)
 *   ZetaMesh.gateway(url)  connect a wss:// RNS-bridge gateway ("" disconnects);
 *                          persisted in localStorage, reconnects on next load
 */
(() => {
  "use strict";
  if (window.ZetaMesh) return; // one node per tab, however many pips

  const CH_NAME = "zeta-mesh";
  const ID_KEY = "zeta-edge-nodeid";        // shared with gitpull.html
  const LAST_KEY = "zeta-mesh-last-alive";  // device-local "zeta was last alive at"
  const WS_KEY = "zeta-mesh-ws-url";
  const BEACON_MS = 5000;
  const TTL_MS = 12500; // miss two beacons and change → you are presumed dark

  const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  let id;
  try { id = sessionStorage.getItem(ID_KEY) || rand(4); sessionStorage.setItem(ID_KEY, id); }
  catch (_) { id = rand(4); }

  const pageName = () => {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "index.html";
  };

  let seq = 0;
  const peers = new Map(); // id -> {seq, head, yin, page, seen, sim, via}
  const subs = new Set();

  // --- transports -----------------------------------------------------------
  let chan = null;
  try { chan = new BroadcastChannel(CH_NAME); chan.onmessage = (e) => fold(e.data, "tabs"); } catch (_) { chan = null; }

  let ws = null, wsStatus = "off";
  function gateway(url) {
    url = (url || "").trim();
    try { url ? localStorage.setItem(WS_KEY, url) : localStorage.removeItem(WS_KEY); } catch (_) {}
    if (ws) { try { ws.close(); } catch (_) {} ws = null; wsStatus = "off"; }
    if (!url) { emit(); return; }
    try {
      wsStatus = "connecting"; emit();
      ws = new WebSocket(url);
      ws.onopen = () => { wsStatus = "open"; announce(); };
      ws.onmessage = (e) => fold(e.data, "ws");
      ws.onerror = () => { wsStatus = "error"; emit(); }; // honest: unreachable stays visible
      ws.onclose = () => { if (wsStatus !== "error") wsStatus = "off"; emit(); };
    } catch (_) { wsStatus = "error"; emit(); }
  }

  function send(msg) {
    if (chan) try { chan.postMessage(msg); } catch (_) {}
    if (ws && ws.readyState === 1) try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }

  // --- the fold: commutative + idempotent, LWW by seq per id ----------------
  function fold(msg, via) {
    if (typeof msg === "string") { try { msg = JSON.parse(msg); } catch (_) { return; } }
    if (!msg || !msg.id || msg.id === id) return;
    const cur = peers.get(msg.id);
    if (cur && cur.seq >= msg.seq) return; // replays and reorders are no-ops
    if (msg.kind === "dark") { if (cur) { peers.delete(msg.id); emit(); } return; }
    if (msg.kind !== "beacon") return;
    peers.set(msg.id, {
      seq: msg.seq, head: msg.head || "", yin: msg.yin || 0,
      page: msg.page || "", seen: Date.now(), sim: !!msg.sim, via: via || "tabs",
    });
    emit();
  }

  function prune() {
    const cut = Date.now() - TTL_MS;
    let changed = false;
    for (const [k, p] of peers) if (p.seen < cut) { peers.delete(k); changed = true; }
    return changed;
  }

  function announce() {
    send({ v: 1, kind: "beacon", id, seq: ++seq, head: "", yin: 0, t: Date.now(), page: pageName() });
    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (_) {}
    prune(); emit();
  }

  function snapshot() {
    prune();
    let lastAlive = 0;
    try { lastAlive = Number(localStorage.getItem(LAST_KEY) || 0); } catch (_) {}
    return {
      id,
      alive: !!chan || wsStatus === "open",
      tabs: peers.size + 1,
      peers: [...peers.entries()].map(([k, p]) => ({ id: k, ...p })),
      wsStatus,
      lastAlive,
    };
  }

  function emit() { const s = snapshot(); for (const f of subs) { try { f(s); } catch (_) {} } }

  const ticker = setInterval(announce, BEACON_MS);
  const goDark = () => send({ v: 1, kind: "dark", id, seq: ++seq });
  addEventListener("pagehide", goDark);

  window.ZetaMesh = {
    id,
    snapshot,
    announce,
    send,
    inject: (m) => fold(m, "inject"),
    gateway,
    on(fn) { subs.add(fn); try { fn(snapshot()); } catch (_) {} return fn; },
    off(fn) { subs.delete(fn); },
    destroy() { clearInterval(ticker); goDark(); removeEventListener("pagehide", goDark); if (chan) chan.close(); if (ws) try { ws.close(); } catch (_) {} },
  };

  announce();
  try { const saved = localStorage.getItem(WS_KEY); if (saved) gateway(saved); } catch (_) {}

  // --- <zeta-mesh-pip> — the visible pulse ----------------------------------
  if (!customElements.get("zeta-mesh-pip")) {
    if (!document.getElementById("zeta-mesh-kf")) {
      const st = document.createElement("style");
      st.id = "zeta-mesh-kf";
      st.textContent = "@keyframes zm-breathe{0%,100%{opacity:.45}50%{opacity:1}}";
      document.head.appendChild(st);
    }

    const MONO = "'Space Mono',ui-monospace,monospace";
    const ago = (t) => {
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h";
    };

    class ZetaMeshPip extends HTMLElement {
      connectedCallback() {
        if (this._init) return;
        this._init = true;
        const up = this.hasAttribute("float");
        this.style.cssText += ";display:inline-block;position:relative;font-family:" + MONO;

        this._chip = document.createElement("button");
        this._chip.setAttribute("aria-label", "zeta mesh status");
        this._chip.style.cssText = "all:unset;cursor:pointer;font-family:" + MONO + ";font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid #26304A;color:#94A0BC;display:inline-flex;align-items:center;gap:6px;background:rgba(7,9,15,.85);white-space:nowrap";
        this._dot = document.createElement("span");
        this._dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:#5EC8C2;display:inline-block;flex-shrink:0";
        this._label = document.createElement("span");
        this._chip.append(this._dot, this._label);

        this._panel = document.createElement("div");
        this._panel.style.cssText = "display:none;position:absolute;right:0;" + (up ? "bottom:calc(100% + 8px)" : "top:calc(100% + 8px)") + ";z-index:80;min-width:250px;background:#0B0E16;border:1px solid #26304A;border-radius:8px;padding:10px 12px;box-shadow:0 14px 34px rgba(0,0,0,.6);font-size:10px;letter-spacing:.06em;color:#94A0BC;text-align:left";
        this.append(this._chip, this._panel);

        this._chip.addEventListener("click", () => {
          this._open = !this._open;
          this._panel.style.display = this._open ? "block" : "none";
          if (this._open) this._render(window.ZetaMesh.snapshot());
        });
        this._sub = window.ZetaMesh.on((s) => this._render(s));
        this._tick = setInterval(() => { if (this._open) this._render(window.ZetaMesh.snapshot()); }, 1000);
      }
      disconnectedCallback() {
        if (this._sub) window.ZetaMesh.off(this._sub);
        clearInterval(this._tick);
      }
      _render(s) {
        if (!s.alive) {
          this._dot.style.background = "#e0746a";
          this._dot.style.boxShadow = "none";
          this._dot.style.animation = "none";
          this._label.textContent = "mesh · unavailable";
        } else if (s.tabs > 1) {
          this._dot.style.background = "#5EC8C2";
          this._dot.style.boxShadow = "0 0 8px 1px rgba(94,200,194,.8)";
          this._dot.style.animation = "zm-breathe 2s infinite";
          this._label.textContent = "zeta alive · " + s.tabs + " tabs";
        } else {
          this._dot.style.background = "#5EC8C2";
          this._dot.style.boxShadow = "none";
          this._dot.style.animation = "none";
          this._label.textContent = "zeta alive · 1 tab";
        }
        if (!this._open) return;
        const rows = [];
        rows.push('<div style="display:flex;justify-content:space-between;gap:14px;padding:3px 0"><span style="color:#E8B566">this tab · ' + s.id + '</span><span style="color:#565f7d">' + esc(pageName()) + "</span></div>");
        for (const p of s.peers) {
          rows.push('<div style="display:flex;justify-content:space-between;gap:14px;padding:3px 0;border-top:1px solid #1a2136"><span style="color:#5EC8C2">' + esc(p.id) + (p.sim ? " · sim" : "") + '</span><span style="color:#565f7d">' + esc(p.page || "?") + " · " + ago(p.seen) + " ago · " + esc(p.via) + "</span></div>");
        }
        if (!s.peers.length) rows.push('<div style="padding:3px 0;border-top:1px solid #1a2136;color:#565f7d">no other tabs · open another zeta page to see discovery</div>');
        rows.push('<div style="padding:4px 0 0;margin-top:3px;border-top:1px solid #1a2136;color:#565f7d;text-transform:uppercase;letter-spacing:.1em">ws gateway · ' + esc(s.wsStatus) + " · transport: tabs" + (s.wsStatus === "open" ? " + ws" : "") + "</div>");
        this._panel.innerHTML = rows.join("");
      }
    }
    const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    customElements.define("zeta-mesh-pip", ZetaMeshPip);
  }
})();
