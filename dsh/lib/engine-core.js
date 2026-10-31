/* DSH particle boot — drawing core.
 *
 * Pure canvas: no DOM, no window. Runs either on the page's main thread or in a
 * worker over an OffscreenCanvas, so the animation keeps its frame rate even
 * while the host app is busy loading.
 *
 * The finale: every particle leaves the wordmark and streams onto the edges of
 * the real interface (sidebar divider, header rule, composer outline), so the
 * layer can dissolve straight into the workspace instead of exploding outward.
 *
 *   var core = DSHBootCore.create({ canvas, cw, ch, dpr })
 *   core.setTargets([{x1,y1,x2,y2}, ...], [{x,y,w,h,r}, ...])   // screen px
 *   core.draw(t)          // t in seconds
 *   core.resize(cw, ch, dpr)
 */
(function (global) {
  'use strict';

  var W = 1920, H = 1080, CX = 960, CY = 396, TAU = Math.PI * 2;
  var T_LOCK = 6.9;
  var T_MORPH = 7.12;
  var MORPH_DUR = 1.0;
  var T_FORM = 8.12;
  var T_REVEAL = 8.3;
  var T_END = 9.25;

  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  function smooth(a, b, x) {
    if (a === b) return x < b ? 0 : 1;
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  var eOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  var eInOut = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = global.document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function hexPts(cx, cy, r, rot) {
    var out = [];
    for (var i = 0; i < 6; i++) {
      var a = rot + i * Math.PI / 3;
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return out;
  }

  function create(opts) {
    var canvas = opts.canvas;
    var ctx = opts.ctx || canvas.getContext('2d');
    var cw = opts.cw || W, ch = opts.ch || H, dpr = opts.dpr || 1;
    var scale = 1, ox = 0, oy = 0;

    var rnd = mulberry32(opts.seed || 20261030);

    /* Cached colour strings: thousands of fills per frame must not allocate. */
    var styleCache = new Map();
    function style(r, g, b, a) {
      r = r >> 3; g = g >> 3; b = b >> 3;
      if (a <= 0) a = 0; else if (a >= 1) a = 1;
      var ai = (a * 96 + 0.5) | 0;
      var key = ((r * 33 + g) * 33 + b) * 97 + ai;
      var s = styleCache.get(key);
      if (s === undefined) {
        s = 'rgba(' + (r << 3) + ',' + (g << 3) + ',' + (b << 3) + ',' + (ai / 96).toFixed(3) + ')';
        if (styleCache.size < 8192) styleCache.set(key, s);
      }
      return s;
    }

    var OUT = [0, 0];

    /* ---------- emblem geometry ---------- */
    var hex150 = hexPts(CX, CY, 150, -Math.PI / 2);
    var NODES = [];
    for (var k = 0; k < 6; k++) {
      var na = -Math.PI / 2 + k * Math.PI / 3;
      NODES.push({ x: CX + Math.cos(na) * 150, y: CY + Math.sin(na) * 150 });
    }

    /* ---------- ambient particle targets ---------- */
    var targets = [];
    NODES.forEach(function (n) {
      var pts = hexPts(n.x, n.y, 20, -Math.PI / 2);
      for (var e = 0; e < 6; e++) {
        var a = pts[e], b = pts[(e + 1) % 6];
        for (var s = 0; s < 5; s++) {
          var u = s / 5;
          targets.push({ x: lerp(a[0], b[0], u), y: lerp(a[1], b[1], u), kind: 'node' });
        }
      }
    });
    for (var e2 = 0; e2 < 6; e2++) {
      var a2 = hex150[e2], b2 = hex150[(e2 + 1) % 6];
      for (var s2 = 0; s2 < 20; s2++) {
        var u2 = (s2 + 0.5) / 20;
        targets.push({ x: lerp(a2[0], b2[0], u2), y: lerp(a2[1], b2[1], u2), kind: 'edge' });
      }
    }
    for (var c1 = 0; c1 < 36; c1++) targets.push({ x: CX + Math.cos(c1 / 36 * TAU) * 38, y: CY + Math.sin(c1 / 36 * TAU) * 38, kind: 'core' });
    for (var c2 = 0; c2 < 24; c2++) targets.push({ x: CX + Math.cos(c2 / 24 * TAU + 0.07) * 17, y: CY + Math.sin(c2 / 24 * TAU + 0.07) * 17, kind: 'core' });
    for (var c3 = 0; c3 < 6; c3++) targets.push({ x: CX + Math.cos(c3 / 6 * TAU) * 5, y: CY + Math.sin(c3 / 6 * TAU) * 5, kind: 'core' });
    for (var c4 = 0; c4 < 60; c4++) targets.push({ x: CX + Math.cos(c4 / 60 * TAU) * 228, y: CY + Math.sin(c4 / 60 * TAU) * 228, kind: 'ring' });

    var COUNT = 1400, P = [];
    for (var i = 0; i < COUNT; i++) {
      var tg = targets[i];
      if (!tg) {
        var ha = rnd() * TAU, hr = 212 + Math.pow(rnd(), 0.8) * 128;
        tg = { x: CX + Math.cos(ha) * hr, y: CY + Math.sin(ha) * hr * 0.5, kind: 'halo' };
      }
      var d = Math.pow(rnd(), 0.75);
      var fs = 0.45 + d * 0.62;
      var fe = fs + 1.0;
      var ls = 1.9 + d * 0.85;
      var le = ls + 1.2;
      P.push({
        tx: tg.x, ty: tg.y, kind: tg.kind,
        a0: rnd() * TAU, r0: 430 + rnd() * 380,
        orbitR: 200 + rnd() * 100,
        turn: rnd() * 0.45,
        spin: (0.14 + rnd() * 0.2) * (rnd() < 0.5 ? -1 : 1),
        fs: fs, fe: fe, ls: ls, le: le,
        size: tg.kind === 'halo' ? (0.6 + rnd() * 0.9) : (1.0 + Math.pow(rnd(), 2.2) * 2.1),
        alpha: tg.kind === 'halo' ? (0.07 + rnd() * 0.13) : (0.3 + rnd() * 0.5),
        blue: tg.kind === 'node' ? (rnd() < 0.55) : (tg.kind === 'core' ? (rnd() < 0.3) : (rnd() < 0.2)),
        ph: rnd() * TAU,
        delay: rnd() * 0.12,
        mx: 0, my: 0, hasM: false
      });
    }

    /* ---------- wordmark particles ---------- */
    var textCanvas = makeCanvas(W, H);
    var tctx = textCanvas.getContext('2d', { willReadFrequently: true });

    function sampleLine(cfg) {
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, W, H);
      tctx.font = cfg.font;
      tctx.textAlign = 'left';
      tctx.textBaseline = 'middle';
      tctx.fillStyle = '#fff';
      var chars = cfg.text.split('');
      var widths = chars.map(function (ch) { return tctx.measureText(ch).width; });
      var total = 0;
      for (var i = 0; i < widths.length; i++) total += widths[i];
      total += cfg.track * (chars.length - 1);
      var x0 = cfg.cx - total / 2;
      var x = x0, y = cfg.cy;
      for (var j = 0; j < chars.length; j++) {
        tctx.fillText(chars[j], x, y);
        x += widths[j] + cfg.track;
      }
      /* Read back only the glyph box: the full-frame readback is 8 MB. */
      var size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(cfg.font) || [0, 40])[1]) || 40;
      var bx = Math.max(0, Math.floor(x0 - 32));
      var by = Math.max(0, Math.floor(cfg.cy - size));
      var bw = Math.min(W - bx, Math.ceil(total + 64));
      var bh = Math.min(H - by, Math.ceil(size * 1.6 + 24));
      var img = tctx.getImageData(bx, by, bw, bh).data;
      var pts = [], step = cfg.step;
      for (var py = 0; py < bh; py += step) {
        for (var px = 0; px < bw; px += step) {
          if (img[(((py | 0) * bw + (px | 0)) * 4) + 3] > 150) {
            pts.push({ x: bx + px + (rnd() - 0.5) * step * 0.75, y: by + py + (rnd() - 0.5) * step * 0.75 });
          }
        }
      }
      return pts;
    }

    var T = [];
    function addTextParticles(pts, cfg) {
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var ang = rnd() * TAU, rad = 22 + Math.pow(rnd(), 0.7) * 250;
        var late = clamp((p.x - cfg.x0) / (cfg.x1 - cfg.x0), 0, 1);
        T.push({
          tx: p.x, ty: p.y,
          sx: CX + Math.cos(ang) * rad, sy: CY + Math.sin(ang) * rad * 0.9,
          t0: cfg.t0 + late * cfg.stagger + rnd() * 0.12,
          dur: cfg.dur + rnd() * 0.2,
          ax: (rnd() - 0.5) * 110, ay: -30 - rnd() * 55,
          size: cfg.size * (0.75 + rnd() * 0.55),
          alpha: cfg.alpha * (0.72 + rnd() * 0.28),
          blue: rnd() < cfg.blue,
          ph: rnd() * TAU,
          delay: Math.min(0.34, Math.hypot(p.x - CX, p.y - CY) / 1600 * 0.3) + rnd() * 0.06,
          mx: 0, my: 0, hasM: false
        });
      }
    }

    var titlePts = sampleLine({
      text: 'HARNESS',
      font: '300 128px Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif',
      track: 20.5, cx: 960, cy: 800, step: 3.4
    });
    var kickPts = sampleLine({
      text: 'DEEPSEEK',
      font: '21px "Cascadia Mono", Consolas, monospace',
      track: 13, cx: 960, cy: 711, step: 1.5
    });
    addTextParticles(titlePts, { t0: 5.45, stagger: 0.45, dur: 0.75, x0: 622, x1: 1298, size: 1.5, alpha: 0.92, blue: 0.1 });
    addTextParticles(kickPts, { t0: 5.75, stagger: 0.16, dur: 0.68, x0: 872, x1: 1048, size: 0.95, alpha: 0.78, blue: 0.14 });

    /* ---------- canvas setup ---------- */
    function resize(ncw, nch, ndpr) {
      cw = ncw; ch = nch; dpr = ndpr || 1;
      canvas.width = Math.max(1, Math.round(cw * dpr));
      canvas.height = Math.max(1, Math.round(ch * dpr));
      if (canvas.style) {
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';
      }
      scale = Math.max(cw / W, ch / H);
      ox = (cw - W * scale) / 2;
      oy = (ch - H * scale) / 2;
    }
    resize(cw, ch, dpr);

    function toDevice(x, y) { return [(x - ox) / scale, (y - oy) / scale]; }

    function posAt(p, t, out) {
      var f = smooth(p.fs, p.fe, t), ef = eOut(f);
      var ang = p.a0 + (0.55 + p.turn) * TAU * ef + p.spin * Math.max(0, t - p.fs);
      var rad = lerp(p.r0, p.orbitR, ef);
      var x = CX + Math.cos(ang) * rad, y = CY + Math.sin(ang) * rad * 0.92;
      var lk = smooth(p.ls, p.le, t);
      if (lk > 0) { var el = eInOut(lk); x = lerp(x, p.tx, el); y = lerp(y, p.ty, el); }
      var st = Math.max(0, t - 4.6);
      if (st > 0) {
        var w = Math.min(1, st * 0.6);
        x += Math.sin(t * 0.55 + p.ph) * 0.8 * w;
        y += Math.cos(t * 0.47 + p.ph * 1.4) * 0.8 * w;
      }
      out[0] = x; out[1] = y;
      return out;
    }

    function emblemAlpha(t) {
      return smooth(0.6, 2.4, t) * (1 - smooth(T_MORPH - 0.25, T_MORPH + 0.35, t));
    }

    /* ---------- interface targets ---------- */
    var segments = [];   // screen px, for the flash lines
    var targetsSet = false;

    /* Every particle picks the nearest interface edge that still has room in
     * its length-proportional quota; inside an edge the order is kept by the
     * projection parameter, so the swarm never crosses itself in flight. */
    function setTargets(segs) {
      if (!segs || !segs.length) return;

      var S = [], total = 0;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 24) continue;
        var a = toDevice(s.x1, s.y1), b = toDevice(s.x2, s.y2);
        var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1) continue;
        S.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], len: len, cands: [], quota: 0 });
        total += len;
      }
      if (!S.length) return;

      var all = [];
      for (var j = 0; j < P.length; j++) {
        posAt(P[j], T_MORPH, OUT);
        all.push({ p: P[j], x: OUT[0], y: OUT[1] });
      }
      for (var k = 0; k < T.length; k++) {
        all.push({ p: T[k], x: T[k].tx, y: T[k].ty });
      }
      var N = all.length;
      for (var q = 0; q < S.length; q++) {
        S[q].quota = Math.max(3, Math.round(S[q].len / total * N));
      }

      for (var n = 0; n < N; n++) {
        var it = all[n], best = null, bestCost = Infinity, bestU = 0;
        for (var m = 0; m < S.length; m++) {
          var sg = S[m];
          var ux = sg.x2 - sg.x1, uy = sg.y2 - sg.y1;
          var L2 = ux * ux + uy * uy;
          var u = L2 > 0 ? ((it.x - sg.x1) * ux + (it.y - sg.y1) * uy) / L2 : 0;
          u = u < 0 ? 0 : (u > 1 ? 1 : u);
          var dx = it.x - (sg.x1 + ux * u), dy = it.y - (sg.y1 + uy * u);
          var cost = (dx * dx + dy * dy) * (sg.cands.length >= sg.quota ? 9 : 1);
          if (cost < bestCost) { bestCost = cost; best = sg; bestU = u; }
        }
        if (best) best.cands.push({ it: it, u: bestU });
      }

      for (var g = 0; g < S.length; g++) {
        var cands = S[g].cands;
        if (!cands.length) continue;
        cands.sort(function (c1, c2) { return c1.u - c2.u; });
        var ex = S[g].x2 - S[g].x1, ey = S[g].y2 - S[g].y1;
        for (var c = 0; c < cands.length; c++) {
          var uu = (c + 0.5) / cands.length;
          var item = cands[c].it;
          item.p.mx = S[g].x1 + ex * uu + (rnd() - 0.5) * 1.4;
          item.p.my = S[g].y1 + ey * uu + (rnd() - 0.5) * 1.4;
          item.p.hasM = true;
        }
      }

      segments = segs.slice();
      targetsSet = true;
    }

    function morphAt(item, t, out) {
      var p = item.p;
      var u = clamp((t - T_MORPH - (p.delay || 0) * 0.35) / MORPH_DUR, 0, 1);
      var e = eInOut(u);
      out[0] = lerp(item.x, p.mx, e);
      out[1] = lerp(item.y, p.my, e);
      out[2] = u;
      return out;
    }

    function drawEmblem(t, a) {
      if (a <= 0.003) return;
      ctx.save();
      ctx.translate(CX, CY);

      var ringIn = smooth(0.9, 3.0, t);
      ctx.save();
      ctx.rotate(t * 0.07);
      ctx.beginPath(); ctx.arc(0, 0, 228, 0, TAU);
      ctx.setLineDash([1, 9]);
      ctx.strokeStyle = 'rgba(232,172,158,' + (0.34 * a * ringIn).toFixed(3) + ')';
      ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.rotate(-t * 0.11 + 0.3);
      ctx.beginPath(); ctx.arc(0, 0, 196, 0, TAU);
      ctx.setLineDash([96, 110]);
      ctx.strokeStyle = 'rgba(214,134,120,' + (0.32 * a * smooth(1.2, 3.2, t)).toFixed(3) + ')';
      ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();

      ctx.setLineDash([]);
      var hp = smooth(2.4, 4.0, t);
      if (hp > 0) {
        ctx.beginPath();
        ctx.moveTo(hex150[0][0] - CX, hex150[0][1] - CY);
        for (var i = 1; i < 6; i++) ctx.lineTo(hex150[i][0] - CX, hex150[i][1] - CY);
        ctx.closePath();
        var per = 900;
        ctx.setLineDash([per, per]);
        ctx.lineDashOffset = per * (1 - hp);
        ctx.strokeStyle = 'rgba(255,118,94,' + (0.6 * a).toFixed(3) + ')';
        ctx.lineWidth = 1; ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }

      for (var n = 0; n < 6; n++) {
        var nd = NODES[n];
        var np = smooth(2.9 + n * 0.08, 3.35 + n * 0.08, t);
        if (np <= 0) continue;
        var pts = hexPts(nd.x - CX, nd.y - CY, 19 * (0.6 + 0.4 * np), -Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var q = 1; q < 6; q++) ctx.lineTo(pts[q][0], pts[q][1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(224,57,43,' + (0.2 * np * a).toFixed(3) + ')';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,152,130,' + (0.95 * np * a).toFixed(3) + ')';
        ctx.lineWidth = 1; ctx.stroke();
      }

      var cp = smooth(2.7, 3.2, t);
      if (cp > 0) {
        ctx.beginPath(); ctx.arc(0, 0, 38, 0, TAU);
        ctx.setLineDash([2, 8]); ctx.lineDashOffset = -t * 12;
        ctx.strokeStyle = 'rgba(255,236,230,' + (0.16 * cp * a).toFixed(3) + ')';
        ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      ctx.restore();
    }

    var OUT3 = [0, 0, 0];
    function fadeOut(t) {
      return 1 - smooth(T_REVEAL + 0.05, T_END - 0.1, t);
    }

    function drawWordmark(t) {
      var fo = fadeOut(t);
      if (fo <= 0.01) return;
      for (var j = 0; j < T.length; j++) {
        var q = T[j];
        var prog = (t - q.t0) / q.dur;
        if (prog <= 0) continue;
        var qu = prog > 1 ? 1 : prog;
        var qe = eOut(qu);
        var arc = Math.sin(Math.PI * qu);
        var qx = lerp(q.sx, q.tx, qe) + q.ax * arc;
        var qy = lerp(q.sy, q.ty, qe) + q.ay * arc;
        var settled = Math.max(0, t - (q.t0 + q.dur));
        var pulse = 1;
        if (settled > 0) {
          var sw = Math.min(1, settled * 1.6);
          qx += Math.sin(t * 1.6 + q.ph) * 0.35 * sw;
          qy += Math.cos(t * 1.4 + q.ph) * 0.35 * sw;
          pulse = 1 + 0.18 * Math.sin(t * 2.4 + q.ph);
        }
        var aq = q.alpha * smooth(0, 0.2, qu);
        if (settled > 0) aq *= 1 + 0.12 * Math.sin(t * 2.0 + q.ph * 1.7);
        var szq = Math.max(0.5, q.size * (0.5 + 0.5 * qu) * pulse);
        var cr = q.blue ? 255 : 246, cg = q.blue ? 120 : 238, cb = q.blue ? 96 : 233;

        if (q.hasM && t >= T_MORPH) {
          morphAt({ p: q, x: qx, y: qy }, t, OUT3);
          qx = OUT3[0]; qy = OUT3[1];
          var mu = OUT3[2];
          szq *= 1 - 0.25 * mu;
          aq *= 0.9 + 0.1 * mu;
        }
        aq *= fo;
        if (aq < 0.012) continue;
        ctx.fillStyle = style(cr, cg, cb, aq);
        ctx.beginPath(); ctx.arc(qx, qy, szq, 0, TAU); ctx.fill();
      }
    }

    function drawAmbient(t) {
      var seed = smooth(0.1, 1.4, t);
      var fo = fadeOut(t);
      if (fo <= 0.01) return;
      for (var i = 0; i < P.length; i++) {
        var p = P[i];
        var fly = smooth(p.fs, p.fe, t);
        if (fly <= 0) continue;
        var a = p.alpha * (0.22 + 0.78 * fly) * seed;
        if (p.kind === 'halo') a *= 0.62;
        posAt(p, t, OUT);
        var x = OUT[0], y = OUT[1];
        var sz = p.size * (0.55 + 0.45 * fly);
        var cr = p.blue ? 255 : 242, cg = p.blue ? 110 : 232, cb = p.blue ? 88 : 228;

        if (p.hasM && t >= T_MORPH) {
          morphAt({ p: p, x: x, y: y }, t, OUT3);
          x = OUT3[0]; y = OUT3[1];
          var mu = OUT3[2];
          a = Math.min(1, a * (1 + 0.5 * mu));
          if (a < 0.46 * mu) a = 0.46 * mu;
          sz *= 1 - 0.2 * mu;
        }
        a *= fo;
        if (a < 0.01) continue;
        if (x < -180 || x > W + 180 || y < -180 || y > H + 180) continue;
        ctx.fillStyle = style(cr, cg, cb, a);
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, sz), 0, TAU); ctx.fill();
      }
    }

    var spriteGlow = null, spriteLine = null, spriteBand = null;
    function ensureSprites() {
      if (spriteGlow) return;
      var R = 260;
      spriteGlow = makeCanvas(R * 2, R * 2);
      var g = spriteGlow.getContext('2d');
      var grd = g.createRadialGradient(R, R, 0, R, R, R);
      grd.addColorStop(0, 'rgba(255,228,218,1)');
      grd.addColorStop(0.28, 'rgba(255,96,74,0.45)');
      grd.addColorStop(1, 'rgba(150,30,20,0)');
      g.fillStyle = grd; g.fillRect(0, 0, R * 2, R * 2);

      spriteLine = makeCanvas(1120, 2);
      var l = spriteLine.getContext('2d');
      var lg = l.createLinearGradient(0, 0, 1120, 0);
      lg.addColorStop(0, 'rgba(255,120,96,0)');
      lg.addColorStop(0.5, 'rgba(255,150,126,0.5)');
      lg.addColorStop(1, 'rgba(255,120,96,0)');
      l.fillStyle = lg; l.fillRect(0, 0, 1120, 2);

      spriteBand = makeCanvas(840, 180);
      var bd = spriteBand.getContext('2d');
      var lv = bd.createLinearGradient(0, 0, 0, 180);
      lv.addColorStop(0, 'rgba(255,90,70,0)');
      lv.addColorStop(0.5, 'rgba(255,90,70,0.16)');
      lv.addColorStop(1, 'rgba(255,90,70,0)');
      bd.fillStyle = lv; bd.fillRect(0, 0, 840, 180);
    }

    function drawFx(t) {
      var seed = smooth(0.2, 1.5, t);
      var lock = Math.exp(-Math.pow((t - 6.72) / 0.17, 2));
      var glowR = 30 + 40 * seed + 190 * lock;
      var glowA = 0.1 * seed + 0.85 * lock;
      var die = 1 - smooth(T_MORPH - 0.1, T_MORPH + 0.55, t);
      if (die <= 0.01) return;

      ensureSprites();

      if (t < T_MORPH) {
        var fade = 1 - smooth(5.9, 7.2, t) * 0.55;
        var ga = clamp(glowA * fade, 0, 1) * die;
        if (ga > 0.002) {
          ctx.globalAlpha = ga;
          ctx.drawImage(spriteGlow, CX - glowR, CY - glowR, glowR * 2, glowR * 2);
          ctx.globalAlpha = 1;
        }
      }

      var lc = Math.exp(-Math.pow((t - 6.72) / 0.16, 2)) * die;
      if (lc > 0.01) {
        ctx.globalAlpha = lc;
        ctx.drawImage(spriteLine, CX - 560, 798, 1120, 1.6);
        ctx.drawImage(spriteBand, CX - 420, 760 - 90, 840, 180);
        ctx.globalAlpha = 1;
      }

      for (var s = 0; s < 2; s++) {
        var t0 = 6.72 + s * 0.13;
        if (t > t0 && t < t0 + 1.1) {
          var u = (t - t0) / 1.1;
          var rr = 16 + 330 * eOut(u);
          ctx.strokeStyle = 'rgba(255,120,96,' + (0.3 * (1 - u) * (1 - u) * die).toFixed(3) + ')';
          ctx.lineWidth = 1.6 * (1 - u) + 0.25;
          ctx.beginPath(); ctx.arc(CX, CY, rr, 0, TAU); ctx.stroke();
        }
      }
    }

    /* Thin glow along the measured interface edges, pulses as the wireframe forms. */
    function drawFrame(t) {
      if (!segments.length || t < T_MORPH + 0.2) return;
      var flash = Math.exp(-Math.pow((t - (T_MORPH + MORPH_DUR)) / 0.22, 2));
      var base = smooth(T_FORM - 0.35, T_FORM + 0.05, t) * (0.1 + 0.5 * flash);
      var fo = fadeOut(t);
      var a = clamp(base * fo, 0, 1);
      if (a < 0.01) return;
      ctx.strokeStyle = 'rgba(255,120,98,' + a.toFixed(3) + ')';
      ctx.lineWidth = 1.1;
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        var p1 = toDevice(s.x1, s.y1), p2 = toDevice(s.x2, s.y2);
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
      }
    }

    function draw(t) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      ctx.globalCompositeOperation = 'lighter';
      drawFrame(t);
      drawEmblem(t, emblemAlpha(t));
      drawAmbient(t);
      drawWordmark(t);
      drawFx(t);
      ctx.globalCompositeOperation = 'source-over';
    }

    return {
      canvas: canvas,
      ctx: ctx,
      draw: draw,
      resize: resize,
      setTargets: setTargets,
      hasTargets: function () { return targetsSet; }
    };
  }

  global.DSHBootCore = {
    create: create,
    T_LOCK: T_LOCK,
    T_MORPH: T_MORPH,
    T_FORM: T_FORM,
    T_REVEAL: T_REVEAL,
    T_END: T_END,
    version: '3.0.0'
  };
})(typeof self !== 'undefined' ? self : this);
