/* DSH particle boot — presentation shell.
 *
 * Owns the DOM (veil, canvas, HUD) and the timeline. The canvas is driven by
 * DSHBootCore, either on this thread or — when possible — inside a worker over
 * an OffscreenCanvas, so the animation keeps its frame rate while the host app
 * is busy loading.
 *
 * The ending: the shell measures the real interface behind it (dock dividers,
 * header rule, composer outline), hands those edges to the core, and every
 * particle flies onto them. The veil then cross-fades, so the workspace appears
 * underneath the wireframe instead of the particles scattering into the void.
 *
 *   DSHBootOverlay.play()                 // once, auto-dismiss
 *   DSHBootOverlay.play({ still: 8.4 })   // render one frozen frame
 */
(function (global) {
  'use strict';

  var CSS = [
    '.dshb-root{position:fixed;inset:0;z-index:2147483000;overflow:hidden;',
    'background:#050405;pointer-events:auto;isolation:isolate;',
    'font-family:"Cascadia Mono",Consolas,monospace;-webkit-font-smoothing:antialiased}',
    '.dshb-root *{box-sizing:border-box;margin:0;padding:0}',
    '.dshb-veil{position:absolute;inset:0;',
    'background:radial-gradient(1180px 760px at 50% 34%,rgba(44,18,17,.42) 0%,rgba(18,8,8,.28) 46%,rgba(6,4,4,0) 74%),',
    'radial-gradient(760px 620px at 50% 40%,rgba(224,57,43,.08) 0%,rgba(224,57,43,0) 62%),',
    'linear-gradient(180deg,#0a0607 0%,#060404 60%,#040303 100%);contain:paint}',
    '.dshb-veil::after{content:"";position:absolute;inset:0;',
    'background:radial-gradient(ellipse 78% 70% at 50% 44%,rgba(0,0,0,0) 40%,rgba(0,0,0,.55) 100%)}',
    '.dshb-canvas{position:absolute;inset:0;display:block}',
    '.dshb-hud{position:absolute;font-size:12px;letter-spacing:.3em;text-transform:uppercase;',
    'color:#7c5c56;opacity:0;transition:opacity .55s ease;white-space:nowrap}',
    '.dshb-hud.on{opacity:1}',
    '.dshb-tl{left:60px;top:48px;display:flex;align-items:center;gap:11px}',
    '.dshb-tl .mk{width:7px;height:7px;border:1px solid rgba(255,122,98,.85);background:rgba(224,57,43,.3)}',
    '.dshb-tr{right:60px;top:48px;color:#e6ab9f}',
    '.dshb-bl{left:60px;bottom:46px}',
    '.dshb-br{right:60px;bottom:46px}',
    '.dshb-bar{position:absolute;left:0;right:0;bottom:0;height:2px;opacity:0;transition:opacity .5s ease}',
    '.dshb-bar.on{opacity:1}',
    '.dshb-bar i{display:block;height:100%;transform-origin:0 50%;transform:scaleX(0);',
    'background:linear-gradient(90deg,rgba(255,92,72,0) 0%,rgba(255,92,72,.55) 30%,rgba(255,150,128,.95) 100%);',
    'box-shadow:0 0 14px rgba(255,92,72,.55)}',
    '.dshb-skip{position:absolute;right:60px;bottom:88px;font-size:10.5px;letter-spacing:.28em;',
    'color:#6a4f4a;text-transform:uppercase;opacity:0;transition:opacity .6s ease}',
    '.dshb-skip.on{opacity:.9}',
    '.dshb-root.revealing .dshb-hud,.dshb-root.revealing .dshb-skip,.dshb-root.revealing .dshb-bar{opacity:0!important}',
    '.dshb-root.leaving{opacity:0;transition:opacity .32s ease}'
  ].join('');

  var T_LOCK = 6.9;
  var T_MORPH = 7.12;
  var MORPH_DUR = 1.0;
  var T_FORM = 8.12;
  var T_REVEAL = 8.3;
  var T_END = 9.25;
  var LIFT_DUR = 0.85;

  /* Geometry probing stops here: the morph is already in flight after it. */
  var PROBE_UNTIL = T_MORPH - 0.18;
  var PROBE_STEP = 0.5;

  var mounted = null;

  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  function smooth(a, b, x) {
    if (a === b) return x < b ? 0 : 1;
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function coreSource() {
    var el = document.getElementById('dshb-core-src');
    return el ? el.textContent : '';
  }

  function ensureCore() {
    if (global.DSHBootCore) return global.DSHBootCore;
    var src = coreSource();
    if (!src) return null;
    try { new Function(src)(); } catch (e) { return null; }
    return global.DSHBootCore || null;
  }

  /* ---------- real interface geometry ----------
   * The desktop shell is a dockkit layout: panes separated by
   * [data-dockkit-divider], a chrome strip on top and an editor box near the
   * bottom. We only read rectangles — no styles are changed, nothing is
   * touched — and fall back to a canonical layout when the shell is still
   * empty (React may not have mounted yet at first paint). */

  function autoLayout(vw, vh, segs, push) {
    var sw = Math.round(Math.min(300, Math.max(180, vw * 0.2)));
    var hy = Math.round(Math.min(60, Math.max(34, vh * 0.065)));
    push(sw, 0, sw, vh);
    push(0, hy, vw, hy);
    var bw = Math.round(Math.min(900, vw * 0.58));
    var bh = Math.round(Math.min(132, vh * 0.15));
    var bx = Math.round((vw - bw) / 2);
    var by = Math.round(vh - bh - Math.max(18, vh * 0.03));
    outline(push, bx, by, bx + bw, by + bh, 12);
    return false;
  }

  function outline(push, x1, y1, x2, y2, cut) {
    cut = cut || 6;
    push(x1 + cut, y1, x2 - cut, y1);
    push(x2, y1 + cut, x2, y2 - cut);
    push(x2 - cut, y2, x1 + cut, y2);
    push(x1, y2 - cut, x1, y1 + cut);
  }

  function collectSegments() {
    var vw = global.innerWidth, vh = global.innerHeight;
    var segs = [];
    var real = false;

    function push(x1, y1, x2, y2) {
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return;
      if (Math.hypot(x2 - x1, y2 - y1) < 44) return;
      segs.push({ x1: +x1.toFixed(1), y1: +y1.toFixed(1), x2: +x2.toFixed(1), y2: +y2.toFixed(1) });
    }

    function rectOf(el) {
      try {
        var r = el.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0 ? r : null;
      } catch (e) { return null; }
    }

    function insideBoot(el) {
      return !!(el.closest && el.closest('.dshb-root'));
    }

    /* A strip glued to the top edge and spanning the window: the chrome bar. */
    function scanTop(el, depth) {
      var kids = el && el.children;
      if (!kids) return null;
      for (var i = 0; i < kids.length && i < 30; i++) {
        var k = kids[i];
        if (insideBoot(k)) continue;
        var r = rectOf(k);
        if (!r) continue;
        if (r.top <= 6 && r.width >= vw * 0.85 && r.height >= 16 && r.height <= 96) return r;
        if (depth > 0) {
          var deep = scanTop(k, depth - 1);
          if (deep) return deep;
        }
      }
      return null;
    }

    try {
      /* 1. dock dividers: the pane seams, i.e. the sidebar edge */
      var rails = document.querySelectorAll('[data-dockkit-divider],[class*="divider"],[class*="Divider"]');
      for (var i = 0; i < rails.length && segs.length < 6; i++) {
        var el = rails[i];
        if (insideBoot(el)) continue;
        var r = rectOf(el);
        if (!r) continue;
        if (r.width <= 12 && r.height >= vh * 0.3) {
          push(r.left + r.width / 2, r.top, r.left + r.width / 2, r.bottom);
          real = true;
        } else if (r.height <= 12 && r.width >= vw * 0.3) {
          push(r.left, r.top + r.height / 2, r.right, r.top + r.height / 2);
          real = true;
        }
      }

      /* 2. header rule: the boldest horizontally-spanning strip at the top */
      var hasHeader = false;
      var bars = document.querySelectorAll('header,.topbar,[class*="topbar"],[class*="titlebar"],[class*="stripChrome"],[class*="toolbar"]');
      for (var h = 0; h < bars.length; h++) {
        var hb = bars[h];
        if (insideBoot(hb)) continue;
        var hr = rectOf(hb);
        if (!hr) continue;
        if (hr.width >= vw * 0.8 && hr.height >= 16 && hr.bottom <= vh * 0.2) {
          push(hr.left, hr.bottom, hr.right, hr.bottom);
          real = true;
          hasHeader = true;
          break;
        }
      }
      if (!hasHeader) {
        var strip = scanTop(document.body, 2);
        if (strip) {
          push(strip.left, strip.bottom, strip.right, strip.bottom);
          real = true;
        }
      }

      /* 2b. sidebar edge, when the shell does not expose a divider element */
      var vertical = false;
      for (var v = 0; v < segs.length; v++) {
        if (Math.abs(segs[v].x2 - segs[v].x1) < 2 && Math.abs(segs[v].y2 - segs[v].y1) > vh * 0.5) vertical = true;
      }
      if (!vertical) {
        var rail = document.querySelector('aside,[class*="sidebar"],[class*="Sidebar"],[class*="sidePanel"]');
        if (rail && !insideBoot(rail)) {
          var rr = rectOf(rail);
          if (rr && rr.width >= 120 && rr.height >= vh * 0.5 && rr.right < vw * 0.7) {
            push(rr.right - 0.5, rr.top, rr.right - 0.5, rr.bottom);
            real = true;
          }
        }
      }

      /* 3. composer: the bordered box wrapped around the editor */
      var eds = document.querySelectorAll('textarea,[contenteditable="true"]');
      var ed = null, bestA = 0;
      for (var e1 = 0; e1 < eds.length; e1++) {
        if (insideBoot(eds[e1])) continue;
        var tr = rectOf(eds[e1]);
        if (!tr || tr.width < 120 || tr.height < 12) continue;
        var area = tr.width * tr.height;
        if (area > bestA) { bestA = area; ed = eds[e1]; }
      }
      if (!ed) {
        var edc = document.querySelector('[class*="editor"]');
        if (edc && !insideBoot(edc)) ed = edc;
      }
      if (ed) {
        var e0 = rectOf(ed);
        if (e0) {
          var node = ed, box = null, depth = 0;
          while (node && node !== document.body && depth < 7) {
            var nr = rectOf(node);
            if (nr && nr.width >= e0.width - 1 && nr.height >= e0.height - 1 &&
                nr.height <= Math.min(420, e0.height + 240) && nr.width <= vw * 0.94) {
              box = nr;
              var cs = global.getComputedStyle(node);
              if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0 ||
                  parseFloat(cs.borderTopLeftRadius) > 8) break;
            }
            node = node.parentElement;
            depth++;
          }
          if (box && box.width >= 220) {
            outline(push, box.left, box.top, box.right, box.bottom, 10);
            real = true;
          }
        }
      }
    } catch (e) { /* a hostile page must not stop the boot */ }

    if (!segs.length) {
      real = autoLayout(vw, vh, segs, push);
    } else if (segs.length > 14) {
      segs.sort(function (a, b) {
        return Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      });
      segs.length = 14;
    }

    return { segs: segs, real: real };
  }

  function play(opts) {
    if (mounted) return mounted;
    opts = opts || {};
    if (typeof document === 'undefined') return null;

    var reduced = false;
    try { reduced = global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    if (!document.getElementById('dshb-style')) {
      var styleEl = document.createElement('style');
      styleEl.id = 'dshb-style';
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
    }

    var host = opts.host || null;
    var root = host || document.createElement('div');
    if (host) {
      root.classList.add('dshb-root');
    } else {
      root.className = 'dshb-root';
      root.setAttribute('aria-hidden', 'true');
    }

    var veil = document.createElement('div');
    veil.className = 'dshb-veil';

    var canvas = document.createElement('canvas');
    canvas.className = 'dshb-canvas';

    var hudTL = document.createElement('div');
    hudTL.className = 'dshb-hud dshb-tl';
    hudTL.innerHTML = '<span class="mk"></span><span>DeepSeek Harness</span>';

    var hudTR = document.createElement('div');
    hudTR.className = 'dshb-hud dshb-tr';
    var statusEl = document.createElement('span');
    statusEl.textContent = 'Initializing';
    hudTR.appendChild(statusEl);

    var hudBL = document.createElement('div');
    hudBL.className = 'dshb-hud dshb-bl';
    hudBL.textContent = 'Agent = Model + Harness';

    var hudBR = document.createElement('div');
    hudBR.className = 'dshb-hud dshb-br';
    hudBR.textContent = 'Everything is a plugin';

    var bar = document.createElement('div');
    bar.className = 'dshb-bar';
    var barFill = document.createElement('i');
    bar.appendChild(barFill);

    var skip = document.createElement('div');
    skip.className = 'dshb-skip';
    skip.textContent = 'Click to skip';

    root.appendChild(veil);
    root.appendChild(canvas);
    root.appendChild(hudTL);
    root.appendChild(hudTR);
    root.appendChild(hudBL);
    root.appendChild(hudBR);
    root.appendChild(bar);
    root.appendChild(skip);
    if (!host) (document.body || document.documentElement).appendChild(root);

    var cw = global.innerWidth, ch = global.innerHeight;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';

    var target = opts.revealTarget ? document.querySelector(opts.revealTarget) : null;
    if (target) {
      target.classList.remove('dshb-live');
      target.classList.add('dshb-pending');
    }

    /* ---------- HUD / hand-over ---------- */
    var hudTLon = false, hudTRon = false, hudBLon = false, hudBRon = false, barOn = false, skipOn = false, barQ = -1;
    var lastAria = -1;
    var lifted = false, veilOp = -1, liftAt = -1e9;

    function setHud(t) {
      if (t > 0.35 && !hudTLon) { hudTLon = true; hudTL.classList.add('on'); }
      if (t > 0.5 && !hudTRon) { hudTRon = true; hudTR.classList.add('on'); }
      if (t > 1.0 && !hudBLon) { hudBLon = true; hudBL.classList.add('on'); }
      if (t > 1.15 && !hudBRon) { hudBRon = true; hudBR.classList.add('on'); }
      if (t > 1.5 && !barOn) { barOn = true; bar.classList.add('on'); }
      if (t > 1.2 && t < T_MORPH && !skipOn) { skipOn = true; skip.classList.add('on'); }
      var q = Math.round(clamp((t - 1.5) / (T_MORPH - 1.5), 0, 1) * 200);
      if (q !== barQ) { barQ = q; barFill.style.transform = 'scaleX(' + (q / 200).toFixed(3) + ')'; }
      if (t > T_LOCK && statusEl.textContent !== 'Ready') statusEl.textContent = 'Ready';
      if (t > T_MORPH && statusEl.textContent !== 'Mapping interface') statusEl.textContent = 'Mapping interface';
      var pct = Math.round(clamp(t / T_END, 0, 1) * 100);
      if (pct !== lastAria) { lastAria = pct; root.setAttribute('aria-valuenow', String(pct)); }
    }

    /* The particles have landed on the real edges: cross-fade the backdrop so
     * the workspace shows through beneath the wireframe. No radial hole. */
    function setReveal(t) {
      if (t < T_FORM) return;
      if (!lifted) {
        lifted = true;
        root.classList.add('revealing');
        root.style.background = 'transparent';
        root.style.pointerEvents = 'none';
        revealTarget();
      }
      var u = smooth(T_FORM, T_FORM + LIFT_DUR, t);
      var op = Math.round((1 - u) * 60) / 60;
      if (op !== veilOp && t * 1000 - liftAt >= 33) {
        liftAt = t * 1000;
        veilOp = op;
        veil.style.opacity = String(op);
        if (op <= 0) veil.style.visibility = 'hidden';
      }
    }

    /* ---------- lifecycle ---------- */
    var done = false;
    var resolveDone;
    var promise = new Promise(function (resolve) { resolveDone = resolve; });

    function revealTarget() {
      if (target) {
        target.classList.remove('dshb-pending');
        target.classList.add('dshb-live');
      }
      try { document.dispatchEvent(new CustomEvent('dsh-boot:reveal')); } catch (e) {}
    }

    function finish() {
      if (done) return;
      done = true;
      stop();
      revealTarget();
      root.classList.add('leaving');
      setTimeout(function () {
        if (root.parentNode) root.parentNode.removeChild(root);
        mounted = null;
        try { document.dispatchEvent(new CustomEvent('dsh-boot:done')); } catch (e) {}
        try { document.dispatchEvent(new CustomEvent('hsx:done')); } catch (e) {}
        try { document.documentElement.removeAttribute('data-hsx-boot'); } catch (e) {}
        resolveDone();
      }, 330);
    }

    function onKey(ev) {
      if (ev.key === 'Escape') { stop(); finish(); }
    }
    document.addEventListener('keydown', onKey);

    function onResize() {
      cw = global.innerWidth; ch = global.innerHeight;
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
      if (api && api.resize) api.resize(cw, ch, dpr);
      if (worker) worker.postMessage({ type: 'resize', cw: cw, ch: ch, dpr: dpr });
      if (virtualTime < PROBE_UNTIL) {
        targetsLocked = false;
        lastSig = '';
        nextProbe = 0;
        probe(virtualTime, true);
      }
    }
    global.addEventListener('resize', onResize);

    function onSkip() {
      if (virtualTime < 1.0) return;
      if (virtualTime >= T_FORM) return;
      if (worker) worker.postMessage({ type: 'skip' });
      else if (localStart !== null) localStart = performance.now() - (T_MORPH - 0.15) * 1000;
      else skipLocal = true;
      try { document.dispatchEvent(new CustomEvent('dsh-boot:skip')); } catch (e) {}
    }
    root.addEventListener('click', onSkip);

    var api = null;
    var worker = null;
    var localStart = null;
    var skipLocal = false;
    var virtualTime = 0;
    var raf = 0;
    var workerUrl = null;
    var coreUrl = null;

    /* ---------- edge acquisition ---------- */
    var lastSig = '';
    var realHits = 0;
    var targetsLocked = false;
    var nextProbe = 0;

    function signature(m) {
      var s = m.real ? 'r' : 'f';
      for (var i = 0; i < m.segs.length; i++) {
        var g = m.segs[i];
        s += '|' + g.x1 + ',' + g.y1 + ',' + g.x2 + ',' + g.y2;
      }
      return s;
    }

    function sendTargets(segs) {
      if (worker) {
        try { worker.postMessage({ type: 'targets', segs: segs }); } catch (e) {}
      } else if (api && api.setTargets) {
        api.setTargets(segs);
      }
    }

    function probe(t, force) {
      if (targetsLocked && !force) return;
      if (!force && t > PROBE_UNTIL) return;
      if (!force && t < nextProbe) return;
      nextProbe = t + PROBE_STEP;
      var m = collectSegments();
      var sig = signature(m);
      if (sig !== lastSig) {
        lastSig = sig;
        sendTargets(m.segs);
        realHits = m.real ? 1 : 0;
      } else if (m.real && ++realHits >= 3) {
        targetsLocked = true;
      }
      if (t >= PROBE_UNTIL) targetsLocked = true;
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      if (worker) { try { worker.postMessage({ type: 'stop' }); } catch (e) {} worker.terminate(); worker = null; }
      if (workerUrl) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
      if (coreUrl) { URL.revokeObjectURL(coreUrl); coreUrl = null; }
      document.removeEventListener('keydown', onKey);
      global.removeEventListener('resize', onResize);
      root.removeEventListener('click', onSkip);
    }

    function tick(t) {
      virtualTime = t;
      setHud(t);
      setReveal(t);
      probe(t, false);
    }

    /* ---------- worker path ---------- */
    function startWorker(src, segs) {
      try {
        coreUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        var glue =
          'importScripts(' + JSON.stringify(coreUrl) + ');' +
          'var core=null,start=0,timer=0,stopped=false,lastPost=0;' +
          'function post(m){self.postMessage(m)}' +
          'function loop(){if(stopped)return;' +
          'var now=performance.now(),t=(now-start)/1000;' +
          'try{core.draw(t)}catch(err){stopped=true;post({type:"fail",message:String(err)});return}' +
          'if(now-lastPost>=33){lastPost=now;post({type:"frame",t:t})}' +
          'if(t>=DSHBootCore.T_END){stopped=true;post({type:"done"});return}' +
          'timer=setTimeout(loop,16)}' +
          'self.onmessage=function(e){var m=e.data||{};' +
          'if(m.type==="probe"){post({type:"alive"});return}' +
          'if(m.type==="init"){try{core=DSHBootCore.create({canvas:m.canvas,cw:m.cw,ch:m.ch,dpr:m.dpr});' +
          'if(m.segs&&m.segs.length)core.setTargets(m.segs);}' +
          'catch(err){post({type:"fail",message:String(err)});return}' +
          'start=performance.now();post({type:"ready"});loop();return}' +
          'if(m.type==="targets"){if(core&&m.segs&&m.segs.length)core.setTargets(m.segs);return}' +
          'if(m.type==="resize"){if(core)core.resize(m.cw,m.ch,m.dpr);return}' +
          'if(m.type==="skip"){start=performance.now()-(DSHBootCore.T_MORPH-0.15)*1000;' +
          'if(lastPost){lastPost=0}return}' +
          'if(m.type==="stop"){stopped=true;if(timer)clearTimeout(timer);return}};';

        workerUrl = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
        var w = new Worker(workerUrl);
        var started = false;
        var probeTimer = setTimeout(function () { if (!started) bail(); }, 900);

        function bail() {
          if (started) return;
          started = true;
          clearTimeout(probeTimer);
          try { w.terminate(); } catch (e) {}
          worker = null;
          startLocal(true);
        }

        w.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.type === 'alive' && !started) {
            started = true;
            clearTimeout(probeTimer);
            var off;
            try { off = canvas.transferControlToOffscreen(); }
            catch (e) { startLocal(true); return; }
            try {
              w.postMessage({ type: 'init', canvas: off, cw: cw, ch: ch, dpr: dpr, segs: segs || null }, [off]);
            } catch (e) { startLocal(true); return; }
            return;
          }
          if (m.type === 'ready') return;
          if (m.type === 'frame') { if (!done) tick(m.t); return; }
          if (m.type === 'done') { finish(); return; }
          if (m.type === 'fail') { startLocal(true); return; }
        };
        w.onerror = function () { if (!done) startLocal(true); };

        worker = w;
        w.postMessage({ type: 'probe' });
      } catch (e) {
        startLocal(false);
      }
    }

    /* ---------- local path ---------- */
    function startLocal(replaceCanvas) {
      if (done) return;
      if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
      if (replaceCanvas) {
        var fresh = document.createElement('canvas');
        fresh.className = 'dshb-canvas';
        fresh.style.width = cw + 'px';
        fresh.style.height = ch + 'px';
        canvas.parentNode.replaceChild(fresh, canvas);
        canvas = fresh;
      }
      var core = ensureCore();
      if (!core) { fadeOnly(); return; }

      api = core.create({ canvas: canvas, cw: cw, ch: ch, dpr: dpr });
      var m = collectSegments();
      lastSig = signature(m);
      api.setTargets(m.segs);
      localStart = performance.now();
      if (skipLocal) localStart -= (T_MORPH - 0.15) * 1000;

      function frame(now) {
        if (done) return;
        var t = (now - localStart) / 1000;
        if (api) api.draw(t);
        tick(t);
        if (t >= T_END) { finish(); return; }
        raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
    }

    function fadeOnly() {
      root.style.transition = 'opacity .4s ease';
      requestAnimationFrame(function () {
        root.style.opacity = '0';
        revealTarget();
        setTimeout(finish, 380);
      });
    }

    if (reduced) { fadeOnly(); }
    else if (opts.still != null) {
      var core0 = ensureCore();
      if (core0) {
        api = core0.create({ canvas: canvas, cw: cw, ch: ch, dpr: dpr });
        var m0 = collectSegments();
        api.setTargets(m0.segs);
        var st = clamp(Number(opts.still) || 0, 0, T_END);
        api.draw(st);
        tick(st);
        if (st >= T_FORM) {
          lifted = true;
          root.classList.add('revealing');
          root.style.background = 'transparent';
          veil.style.opacity = String(1 - smooth(T_FORM, T_FORM + LIFT_DUR, st));
          revealTarget();
        }
        root.style.pointerEvents = 'none';
      } else {
        fadeOnly();
      }
    } else {
      var src = opts.coreSrc || coreSource();
      var canWorker = opts.worker !== false && typeof Worker !== 'undefined' &&
        typeof HTMLCanvasElement !== 'undefined' &&
        !!HTMLCanvasElement.prototype.transferControlToOffscreen && !!src;
      /* Measure once now so the worker has edges before its first frame. */
      var seg0 = collectSegments();
      lastSig = signature(seg0);
      if (canWorker) startWorker(src, seg0.segs);
      else startLocal(false);
    }

    mounted = {
      promise: promise,
      remove: function () { stop(); finish(); },
      measure: collectSegments
    };
    return mounted;
  }

  global.DSHBootOverlay = { play: play, version: '3.0.0' };
})(typeof window !== 'undefined' ? window : this);
