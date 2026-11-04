/* מאמן הילוכים — מנוע הזיהוי. קוד טהור בלי DOM, רץ גם בדפדפן וגם ב-Node. */
(function (root) {
  'use strict';

  // ---------- FFT (radix-2) ----------
  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    if ((1 << levels) !== n) throw new Error('FFT size must be a power of 2');
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    return function (re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = im[l] * cos[k] - re[l] * sin[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  class Spectrum {
    constructor(n) {
      this.n = n; this.fft = makeFFT(n);
      this.win = new Float64Array(n);
      for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      this.re = new Float64Array(n); this.im = new Float64Array(n);
      this.mag = new Float64Array(n / 2);
    }
    // samples: array-like, uses the last n values (or from `start`)
    compute(samples, start) {
      const n = this.n, off = start == null ? samples.length - n : start;
      let mean = 0;
      for (let i = 0; i < n; i++) mean += samples[off + i];
      mean /= n;
      for (let i = 0; i < n; i++) { this.re[i] = (samples[off + i] - mean) * this.win[i]; this.im[i] = 0; }
      this.fft(this.re, this.im);
      for (let k = 0; k < n / 2; k++) this.mag[k] = Math.hypot(this.re[k], this.im[k]);
      return this.mag;
    }
  }

  // ---------- סל"ד מתוך ספקטרום ----------
  // מנוע 4 פעימות: מספר הצתות לסיבוב = צילינדרים / 2. תדר ההצתה = סל"ד/60 × הצתות לסיבוב.
  class RpmTracker {
    constructor(o) {
      this.sr = o.sampleRate; this.n = o.n || 8192;
      this.binHz = this.sr / this.n;
      this.H = o.harmonics || 6;
      this.confMin = o.confMin != null ? o.confMin : 3.2;
      this.wExp = o.wExp != null ? o.wExp : 0.8;
      this.alpha = o.alpha != null ? o.alpha : 0.4;
      this.contFloor = o.contFloor != null ? o.contFloor : 0.3;
      this.linear = !!o.linear;
      this.setCylinders(o.cylinders || 4);
      this.reset();
    }
    setCylinders(c) {
      this.cyl = c; this.firingPerRev = c / 2;
      this.minRpm = 600; this.maxRpm = 7600;
      this.fMin = this.minRpm / 60 * this.firingPerRev;
      this.fMax = this.maxRpm / 60 * this.firingPerRev;
      this.fStep = 0.25 * this.firingPerRev;
      this.nc = Math.floor((this.fMax - this.fMin) / this.fStep) + 1;
      this.score = new Float64Array(this.nc);
      this.W = Math.max(4, Math.round(45 / this.binHz));
      this.kTop = Math.min(this.n / 2 - 1, Math.ceil(this.H * this.fMax / this.binHz) + this.W + 3);
      this.l = new Float64Array(this.kTop + 1);
      this.P = new Float64Array(this.kTop + 2);
      this.s = new Float64Array(this.kTop + 2);
    }
    reset() { this.prevRpm = null; this.prevT = -1e9; this.raw = []; this.out = null; this.outT = -1e9; }
    rpmFromF(f) { return f * 60 / this.firingPerRev; }
    whiten(mag) {
      const K = this.kTop, l = this.l, P = this.P, s = this.s, W = this.W;
      const lin = this.linear;
      for (let k = 0; k <= K; k++) l[k] = lin ? mag[k] : Math.log(mag[k] + 1e-12);
      P[0] = 0; for (let k = 0; k <= K; k++) P[k + 1] = P[k] + l[k];
      const kLow = Math.ceil(24 / this.binHz);
      for (let k = 0; k <= K; k++) {
        const a = Math.max(0, k - W), b = Math.min(K, k + W);
        const avg = (P[b + 1] - P[a]) / (b - a + 1);
        const v = lin ? Math.min(30, l[k] / (avg + 1e-12) - 1) : l[k] - avg;
        s[k] = (k < kLow || v < 0) ? 0 : v;
      }
      s[K + 1] = 0;
    }
    // משקל יורד להרמוניות: התדר הבסיסי של המועמד חייב להיות חזק (מונע טעות של חצי סל"ד).
    // עונש על נקודות האמצע: מונע טעות של סל"ד כפול.
    scoreAll() {
      const s = this.s, inv = 1 / this.binHz, H = this.H, sc = this.score;
      if (!this.w) { this.w = []; for (let h = 1; h <= H; h++) this.w.push(Math.pow(h, -this.wExp)); }
      const w = this.w, alpha = this.alpha;
      const at = (x) => { const i = x | 0, fr = x - i; return s[i] * (1 - fr) + s[i + 1] * fr; };
      for (let c = 0; c < this.nc; c++) {
        const f = this.fMin + c * this.fStep;
        let a = 0, b = 0;
        for (let h = 1; h <= H; h++) { a += w[h - 1] * at(h * f * inv); b += w[h - 1] * at((h - 0.5) * f * inv); }
        sc[c] = a - alpha * b;
      }
    }
    prior(rpm, t, priors) {
      let p = 1;
      if (this.prevRpm && t - this.prevT < 1.5) {
        const dt = Math.max(0.05, t - this.prevT);
        const sig = 0.08 + 0.5 * dt;
        const d = Math.log(rpm / this.prevRpm) / sig;
        p *= this.contFloor + (1 - this.contFloor) * Math.exp(-0.5 * d * d);
      }
      if (priors && priors.length) {
        let g = 0;
        for (const pr of priors) { if (!(pr > 0)) continue; const d = Math.log(rpm / pr) / 0.07; g = Math.max(g, Math.exp(-0.5 * d * d)); }
        p *= 0.55 + 0.45 * g;
      }
      return p;
    }
    // mag: magnitude spectrum, t: seconds, priors: predicted rpm values (one per gear) or null
    update(mag, t, priors) {
      this.whiten(mag); this.scoreAll();
      const sc = this.score, nc = this.nc;
      let mean = 0; for (let c = 0; c < nc; c++) mean += sc[c]; mean /= nc;
      let v = 0; for (let c = 0; c < nc; c++) v += (sc[c] - mean) * (sc[c] - mean);
      const std = Math.sqrt(v / nc) + 1e-9;
      const peaks = [];
      for (let c = 1; c < nc - 1; c++) if (sc[c] > sc[c - 1] && sc[c] >= sc[c + 1] && sc[c] > mean + std) peaks.push(c);
      peaks.sort((a, b) => sc[b] - sc[a]);
      let best = -1, bestV = -Infinity, bestZ = 0;
      for (let i = 0; i < Math.min(8, peaks.length); i++) {
        const c = peaks[i], z = (sc[c] - mean) / std;
        const rpm = this.rpmFromF(this.fMin + c * this.fStep);
        const val = z * this.prior(rpm, t, priors);
        if (val > bestV) { bestV = val; best = c; bestZ = z; }
      }
      if (best < 0 || bestZ < this.confMin) return this.hold(t, bestZ);
      const y0 = sc[best - 1], y1 = sc[best], y2 = sc[best + 1];
      const den = y0 - 2 * y1 + y2;
      let delta = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
      delta = Math.max(-0.5, Math.min(0.5, delta));
      const rpm = this.rpmFromF(this.fMin + (best + delta) * this.fStep);
      if (this.out && t - this.outT > 0.6) this.raw = [];
      this.raw.push(rpm); if (this.raw.length > 3) this.raw.shift();
      const med = this.raw.slice().sort((a, b) => a - b)[this.raw.length >> 1];
      this.out = med; this.outT = t; this.prevRpm = rpm; this.prevT = t;
      return { rpm: med, conf: bestZ, raw: rpm };
    }
    hold(t, z) {
      if (this.out && t - this.outT < 0.45) return { rpm: this.out, conf: z || 0, held: true };
      this.out = null; this.raw = [];
      return { rpm: null, conf: z || 0 };
    }
  }

  // ---------- למידת יחסי הילוכים (סל"ד לכל קמ"ש) ----------
  const TEMPLATE_RATIO = [120, 70, 48, 36, 29, 24];
  const TEMPLATE_STEP = [0.56, 0.41, 0.29, 0.22, 0.18];

  class GearModel {
    constructor(nGears) {
      this.lo = Math.log(10); this.hi = Math.log(250); this.bw = 0.012;
      this.nb = Math.ceil((this.hi - this.lo) / this.bw);
      this.c = new Float64Array(this.nb); this.total = 0;
      this.nGears = nGears || 5; this.gears = []; this.dirty = false;
    }
    setGearCount(n) { this.nGears = n; this.dirty = true; this.solve(); }
    add(ratio, w) {
      const i = Math.floor((Math.log(ratio) - this.lo) / this.bw);
      if (i < 0 || i >= this.nb) return;
      this.c[i] += (w || 1); this.total += (w || 1); this.dirty = true;
    }
    clear() { this.c.fill(0); this.total = 0; this.gears = []; this.dirty = false; }
    get complete() { return this.gears.length === this.nGears; }
    solve() {
      if (!this.dirty) return this.gears;
      this.dirty = false;
      const nb = this.nb, c = this.c, sm = new Float64Array(nb);
      for (let i = 0; i < nb; i++) {
        let a = 0;
        for (let d = -4; d <= 4; d++) { const j = i + d; if (j >= 0 && j < nb) a += c[j] * Math.exp(-0.5 * (d / 1.5) * (d / 1.5)); }
        sm[i] = a;
      }
      const minMass = Math.max(8, 0.03 * this.total);
      let peaks = [];
      for (let i = 1; i < nb - 1; i++) {
        if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1]) {
          let m = 0, mx = 0;
          for (let d = -5; d <= 5; d++) { const j = i + d; if (j >= 0 && j < nb) { m += c[j]; mx += c[j] * (j + 0.5); } }
          if (m >= minMass) peaks.push({ x: mx / m, mass: m });
        }
      }
      peaks.sort((a, b) => b.mass - a.mass);
      const kept = [];
      for (const p of peaks) {
        if (kept.every(k => Math.abs(k.x - p.x) * this.bw > 0.1)) kept.push(p);
        if (kept.length >= this.nGears) break;
      }
      const found = kept.map(p => ({ ratio: Math.exp(this.lo + p.x * this.bw), mass: p.mass }))
        .sort((a, b) => b.ratio - a.ratio);
      const idx = this.assign(found);
      this.gears = found.map((g, i) => ({ n: idx[i] + 1, ratio: g.ratio, mass: g.mass }));
      return this.gears;
    }
    // מספור הילוכים כשלא נמצאו כולם: התאמה לצעדי יחס טיפוסיים
    assign(found) {
      const n = this.nGears, m = found.length;
      if (m === 0) return [];
      if (m === n) return found.map((_, i) => i);
      let best = null, bestCost = Infinity;
      const combo = [];
      const rec = (start) => {
        if (combo.length === m) {
          let cost = 0;
          for (let j = 0; j + 1 < m; j++) {
            const obs = Math.log(found[j].ratio / found[j + 1].ratio);
            let ex = 0; for (let k = combo[j]; k < combo[j + 1]; k++) ex += TEMPLATE_STEP[Math.min(k, TEMPLATE_STEP.length - 1)];
            cost += (obs - ex) * (obs - ex);
          }
          for (let j = 0; j < m; j++) {
            const d = Math.log(found[j].ratio / TEMPLATE_RATIO[Math.min(combo[j], 5)]);
            cost += 0.08 * d * d;
          }
          if (cost < bestCost) { bestCost = cost; best = combo.slice(); }
          return;
        }
        for (let i = start; i < n; i++) { combo.push(i); rec(i + 1); combo.pop(); }
      };
      rec(0);
      return best;
    }
    classify(rpm, kmh) {
      if (!this.gears.length || !(kmh >= 6) || !(rpm > 0)) return null;
      const lr = Math.log(rpm / kmh);
      let best = null, bd = Infinity;
      for (const g of this.gears) { const d = Math.abs(lr - Math.log(g.ratio)); if (d < bd) { bd = d; best = g; } }
      return bd < 0.075 ? best : null;
    }
    predict(kmh) { return (kmh >= 8) ? this.gears.map(g => g.ratio * kmh) : null; }
    toJSON() {
      const bins = [];
      for (let i = 0; i < this.nb; i++) if (this.c[i] > 0) bins.push([i, Math.round(this.c[i] * 100) / 100]);
      return { v: 1, nGears: this.nGears, bins };
    }
    static fromJSON(o, nGears) {
      const g = new GearModel(nGears || (o && o.nGears) || 5);
      if (o && o.v === 1 && Array.isArray(o.bins)) {
        for (const [i, v] of o.bins) if (i >= 0 && i < g.nb) { g.c[i] = v; g.total += v; }
        g.dirty = true; g.solve();
      }
      return g;
    }
  }

  // ---------- ספים לפי מצב ----------
  function thresholds(s) {
    if (s.mode === 'sport') {
      const R = s.redline;
      return { mode: 'sport', lug: 1300, goodLo: R - 1300, goodHi: R - 300, slightHi: R - 50, prompt: R - 700, near: R - 1500, ledLo: Math.round(R * 0.4), ledHi: R };
    }
    const T = s.ecoTarget;
    return { mode: 'eco', lug: 1300, goodLo: T - 500, goodHi: T + 300, slightHi: T + 800, prompt: T, near: T - 400, ledLo: 1000, ledHi: T + 800 };
  }

  const GRADES = {
    good: { label: 'בזמן', score: 100 },
    slight: { label: 'קצת מאוחר', score: 70 },
    late: { label: 'מאוחר מדי', score: 40 },
    early: { label: 'מוקדם מדי', score: 50 }
  };

  function gradeShift(before, after, th) {
    if (after != null && after < th.lug) return { grade: 'early', note: 'המנוע נחנק אחרי ההעברה' };
    if (before < th.goodLo) return { grade: 'early', note: th.mode === 'sport' ? 'היה עוד כוח במנוע' : 'הסל"ד היה נמוך מדי' };
    if (before <= th.goodHi) return { grade: 'good', note: 'העברה בזמן' };
    if (before <= th.slightHi) return { grade: 'slight', note: 'אפשר להעביר קצת קודם' };
    return { grade: 'late', note: th.mode === 'sport' ? 'נגעת בקו האדום' : 'סובבת את המנוע יותר מדי' };
  }

  function smoothLabel(j) {
    if (j == null) return null;
    if (j < 5) return 'smooth';
    if (j < 10) return 'ok';
    return 'harsh';
  }
  // בלי מד תאוצה: חלקות לפי התאמת הסל"ד ומשך ההעברה
  function audioSmooth(revDrop, duration) {
    if (revDrop <= 8 && duration <= 1.6) return 'smooth';
    if (revDrop <= 18 && duration <= 2.4) return 'ok';
    return 'harsh';
  }

  // ---------- המאמן: מאחד סאונד, GPS ותנועה ----------
  class Coach {
    constructor(settings, gears) {
      this.gears = gears || new GearModel(settings.nGears);
      this.configure(settings);
      this.reset();
    }
    configure(settings) {
      this.s = Object.assign({}, settings);
      this.th = thresholds(this.s);
      if (this.gears.nGears !== this.s.nGears) this.gears.setGearCount(this.s.nGears);
    }
    reset() {
      this.hist = []; this.gps = [];
      this.lagCands = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
      this.lagScore = this.lagCands.map(() => 0); this.lagN = 0; this.lag = 0.4;
      this.jerk = []; this.lp = null; this.lastMotion = null;
      this.state = 'track'; this.drop = null; this.refractUntil = 0;
      this.events = []; this.pending = [];
      this.lowSince = null; this.trace = []; this.lastTraceT = -1e9; this.startT = null;
      this.hasGps = false; this.hasMotion = false;
      this.onEvent = this.onEvent || null; this.onEventUpdate = this.onEventUpdate || null;
    }

    // --- קלטים ---
    audio(t, r) {
      if (this.startT == null) this.startT = t;
      this.hist.push({ t, rpm: r.rpm });
      while (this.hist.length && this.hist[0].t < t - 8) this.hist.shift();
      if (t - this.lastTraceT >= 0.25) {
        this.lastTraceT = t;
        const k = this.speedAt(t), g = (r.rpm && k != null) ? this.gears.classify(r.rpm, k) : null;
        this.trace.push({ t: t - this.startT, rpm: r.rpm ? Math.round(r.rpm) : null, kmh: k != null ? Math.round(k) : null, gear: g ? g.n : null });
      }
      this.detect(t);
      this.flushPending(t);
    }
    // כל דגימת GPS: מחשבים יחס סל"ד/קמ"ש לכל פריימי הסאונד שבין שתי הדגימות האחרונות.
    // ה-GPS מאחר בזמן לא ידוע, אז בודקים כמה השהיות ובוחרים את זו שנותנת יחס הכי יציב.
    gpsFix(t, kmh) {
      if (!(kmh >= 0)) return;
      this.hasGps = true;
      this.gps.push({ t, kmh });
      while (this.gps.length && this.gps[0].t < t - 15) this.gps.shift();
      const g = this.gps; if (g.length < 2) return;
      const a = g[g.length - 2], b = g[g.length - 1];
      if (a.kmh < 8 || b.kmh < 8 || b.t - a.t > 2.5 || b.t <= a.t) return;
      const ratiosFor = (L) => {
        const out = [];
        for (const f of this.hist) {
          const tt = f.t + L;
          if (tt < a.t || tt > b.t || !f.rpm) continue;
          const k = a.kmh + (b.kmh - a.kmh) * (tt - a.t) / (b.t - a.t);
          if (k >= 8) out.push(f.rpm / k);
        }
        return out;
      };
      const stat = (rs) => {
        if (rs.length < 4) return null;
        const s = rs.slice().sort((x, y) => x - y), med = s[s.length >> 1];
        const dev = s.map(r => Math.abs(r / med - 1)).sort((x, y) => x - y);
        return { med, mad: dev[dev.length >> 1], agree: dev.filter(d => d <= 0.03).length / dev.length, n: rs.length };
      };
      let curStat = null;
      this.lagCands.forEach((L, i) => {
        const st = stat(ratiosFor(L));
        if (st) this.lagScore[i] += Math.min(st.mad, 0.08);
        if (L === this.lag) curStat = st;
      });
      this.lagN++;
      if (this.lagN >= 8) {
        let bi = 0; this.lagScore.forEach((v, i) => { if (v < this.lagScore[bi]) bi = i; });
        this.lag = this.lagCands[bi];
      }
      if (curStat && curStat.agree >= 0.7) { this.gears.add(curStat.med, curStat.agree * curStat.n / 12); this.gears.solve(); }
    }
    motion(t, ax, ay, az) {
      if (!(isFinite(ax) && isFinite(ay) && isFinite(az))) return;
      this.hasMotion = true;
      if (!this.lp) { this.lp = [ax, ay, az]; this.lastMotion = t; return; }
      const dt = t - this.lastMotion; if (dt <= 0) return;
      const a = Math.min(1, dt / 0.12);
      const p = this.lp, nx = p[0] + a * (ax - p[0]), ny = p[1] + a * (ay - p[1]), nz = p[2] + a * (az - p[2]);
      const j = Math.hypot(nx - p[0], ny - p[1], nz - p[2]) / dt;
      this.lp = [nx, ny, nz]; this.lastMotion = t;
      this.jerk.push({ t, j });
      while (this.jerk.length && this.jerk[0].t < t - 8) this.jerk.shift();
    }

    // --- עזרים ---
    // מהירות בזמן t, אחרי תיקון ההשהיה של ה-GPS
    speedAt(t) {
      const g = this.gps; if (!g.length) return null;
      const L = this.lag, last = g[g.length - 1], lt = last.t - L;
      if (t - lt > 3.5) return null;
      if (t >= lt) {
        if (g.length >= 2) {
          const prev = g[g.length - 2], dt = last.t - prev.t;
          if (dt > 0 && dt < 3) { const slope = (last.kmh - prev.kmh) / dt; return Math.max(0, last.kmh + slope * Math.min(1.5, t - lt)); }
        }
        return last.kmh;
      }
      for (let i = g.length - 1; i > 0; i--) {
        const at = g[i - 1].t - L;
        if (at <= t) { const a = g[i - 1], b = g[i], f = (t - at) / ((b.t - a.t) || 1); return a.kmh + f * (b.kmh - a.kmh); }
      }
      return g[0].kmh;
    }
    rpmAt(t) {
      const h = this.hist; let best = null, bd = 0.3;
      for (let i = h.length - 1; i >= 0; i--) {
        const d = Math.abs(h[i].t - t);
        if (d < bd && h[i].rpm) { bd = d; best = h[i].rpm; }
        if (h[i].t < t - 0.3) break;
      }
      return best;
    }
    maxJerk(t0, t1) {
      let m = null;
      for (const e of this.jerk) if (e.t >= t0 && e.t <= t1) m = Math.max(m || 0, e.j);
      return m;
    }

    // --- זיהוי העברה למעלה ---
    detect(t) {
      const h = this.hist, last = h[h.length - 1];
      const cur = last && last.rpm;
      if (!cur) {
        if (this.state !== 'track' && this.drop && t - this.drop.lastValid > 1.0) this.state = 'track';
        return;
      }
      if (this.state === 'track') {
        if (t < this.refractUntil) return;
        let m = null;
        for (let i = h.length - 1; i >= 0 && h[i].t >= t - 1.5; i--) if (h[i].rpm && (!m || h[i].rpm > m.rpm)) m = h[i];
        if (!m || m.t > t - 0.12 || m.t < t - 1.4) return;
        if (m.rpm < 1400) return;
        if (cur > m.rpm * 0.84 || t - m.t > 0.9) return;
        const pre = this.rpmAt(m.t - 1.0);
        if (pre == null || m.rpm - pre < 60) return;
        // קפיצה של יותר מ-35% בין שני פריימים היא טעות זיהוי (אוקטבה), לא האצה אמיתית
        let prev = null;
        for (const f of h) {
          if (f.t < m.t - 1.0 || f.t > m.t) continue;
          if (prev && f.rpm && prev.rpm && f.rpm / prev.rpm > 1.35) return;
          if (f.rpm) prev = f;
        }
        this.state = 'drop';
        this.drop = { peak: m.rpm, tPeak: m.t, min: cur, tMin: t, kmhStart: this.speedAt(m.t), lastValid: t, tRise: null };
        return;
      }
      const d = this.drop; d.lastValid = t;
      if (this.state === 'drop') {
        if (cur < d.min) { d.min = cur; d.tMin = t; }
        const kmhNow = this.speedAt(t);
        const rising = cur >= d.min * 1.03 && t - d.tMin >= 0.1;
        const gpsSteady = kmhNow != null && d.kmhStart != null && kmhNow >= d.kmhStart * 0.9 && t - d.tMin >= 0.45;
        if (rising || gpsSteady) { this.state = 'settle'; d.tRise = t; return; }
        if (t - d.tPeak > 3.5) this.state = 'track';
        return;
      }
      if (this.state === 'settle' && t - d.tRise >= 0.3) this.finish(t, cur);
    }
    finish(t, after) {
      const d = this.drop; this.state = 'track'; this.refractUntil = t + 0.8;
      const kmhNow = this.speedAt(t);
      if (after < 950) return;
      if (after >= d.peak * 0.95) return;
      if (after < d.peak * 0.54) return; // ירידה של חצי = טעות אוקטבה, לא העברה
      if (d.kmhStart != null && kmhNow != null && kmhNow < d.kmhStart * 0.85) return;
      let from = null, to = null;
      if (d.kmhStart != null && kmhNow != null) {
        const gf = this.gears.classify(d.peak, d.kmhStart), gt = this.gears.classify(after, kmhNow);
        from = gf ? gf.n : null; to = gt ? gt.n : null;
        if (from && to && to <= from) return;
      }
      const g = gradeShift(d.peak, after, this.th);
      const ev = {
        id: this.events.length + 1, t: d.tPeak - (this.startT || 0), from, to,
        before: Math.round(d.peak), after: Math.round(after), mode: this.th.mode,
        grade: g.grade, note: g.note, score: GRADES[g.grade].score,
        jerk: null, smooth: null, kmh: kmhNow != null ? Math.round(kmhNow) : null,
        // התאמת סל"ד: כמה הסל"ד צנח מתחת לסל"ד של ההילוך החדש לפני שהקלאץ' נתפס
        revDrop: Math.round(100 * Math.max(0, after - d.min) / after),
        duration: Math.round((d.tRise - d.tPeak) * 100) / 100, smoothSrc: null
      };
      if (!this.hasMotion) { ev.smooth = audioSmooth(ev.revDrop, ev.duration); ev.smoothSrc = 'sound'; }
      this.events.push(ev);
      if (this.hasMotion) this.pending.push({ ev, t0: d.tPeak - 0.3, t1: t + 0.9 });
      if (this.onEvent) this.onEvent(ev);
    }
    flushPending(t) {
      if (!this.pending.length) return;
      this.pending = this.pending.filter(p => {
        if (t < p.t1) return true;
        const j = this.maxJerk(p.t0, p.t1);
        p.ev.jerk = j != null ? Math.round(j * 10) / 10 : null;
        p.ev.smooth = j != null ? smoothLabel(j) : audioSmooth(p.ev.revDrop, p.ev.duration);
        p.ev.smoothSrc = j != null ? 'motion' : 'sound';
        if (this.onEventUpdate) this.onEventUpdate(p.ev);
        return false;
      });
    }

    // --- מצב חי לתצוגה ---
    live(t) {
      const h = this.hist, last = h[h.length - 1];
      const rpm = last && t - last.t < 0.6 ? last.rpm : null;
      const kmh = this.speedAt(t);
      const gearObj = rpm && kmh != null ? this.gears.classify(rpm, kmh) : null;
      const gear = gearObj ? gearObj.n : null;
      const th = this.th;
      const top = gear != null && gear === this.s.nGears;
      let state = 'ok';
      if (rpm == null) state = 'nosignal';
      else if (!top && rpm > th.goodHi) state = 'late';
      else if (!top && rpm >= th.prompt) state = 'shift';
      else if (!top && rpm >= th.near) state = 'near';
      const lowCond = rpm != null && rpm < th.lug && rpm > 950 && (kmh == null || kmh > 8) && !(gear === 1);
      if (lowCond) { if (this.lowSince == null) this.lowSince = t; if (t - this.lowSince > 1.2) state = 'low'; }
      else this.lowSince = null;
      return { rpm, kmh, gear, top, state, th, gearsFound: this.gears.gears.length, gearsComplete: this.gears.complete };
    }
    summary() {
      const ev = this.events;
      const counts = { good: 0, slight: 0, late: 0, early: 0 };
      for (const e of ev) counts[e.grade]++;
      const score = ev.length ? Math.round(ev.reduce((a, e) => a + e.score, 0) / ev.length) : null;
      const sm = ev.filter(e => e.smooth);
      const smooth = sm.length ? Math.round(100 * sm.filter(e => e.smooth === 'smooth').length / sm.length) : null;
      const dur = this.trace.length ? this.trace[this.trace.length - 1].t : 0;
      return { count: ev.length, counts, score, smooth, duration: dur };
    }
  }

  // ---------- הדמיית נסיעה (למצב הדגמה ולבדיקות) ----------
  // כל העברה מקבלת "סגנון נהג": חלק / סביר / קופצני (שחרור גז ושחרור קלאץ').
  const STYLES = {
    smooth: { liftTau: 0.22, dropBelow: 60, engage: 0.28, kick: 0.15 },
    ok: { liftTau: 0.1, dropBelow: 220, engage: 0.14, kick: 0.45 },
    harsh: { liftTau: 0.03, dropBelow: 600, engage: 0.05, kick: 1.1 }
  };
  const STYLE_ORDER = ['smooth', 'harsh', 'ok', 'smooth', 'ok', 'smooth', 'harsh'];

  class DriveSim {
    constructor(th, o) {
      o = o || {};
      this.ratios = o.ratios || [118, 68, 47, 36, 29];
      this.idle = 850; this.th = th;
      this.sport = th.mode === 'sport';
      this.acc = (this.sport ? [3.6, 2.8, 2.1, 1.5, 1.1] : [2.4, 1.9, 1.4, 1.0, 0.75]);
      this.lap = 0; this.t = 0; this.nShift = 0;
      this.shifts = [];
      this.accel = 0; this.accTarget = 0; this.tau = 0.15;
      this.jolt = 0; this.joltT = 0;
      this.startLap();
    }
    plan() {
      const th = this.th, n = this.ratios.length - 1;
      const good = (th.goodLo + th.goodHi) / 2, slight = (th.goodHi + th.slightHi) / 2, late = th.slightHi + 250, early = th.goodLo - 250;
      const pats = [
        [good, late, early, good],
        [slight, good, good, late],
        [good, early, slight, good]
      ];
      const p = pats[this.lap % pats.length];
      const out = []; for (let i = 0; i < n; i++) out.push(p[i % p.length]);
      return out;
    }
    startLap() {
      this.targets = this.plan();
      this.phase = 'idle'; this.phaseT = 0; this.gear = 0; this.kmh = 0; this.rpm = this.idle; this.load = 0.1;
    }
    // תאוצה אורכית כפי שהטלפון ירגיש אותה (כולל נדנוד אחרי שחרור קלאץ')
    longAccel() {
      const dt = this.t - this.joltT;
      const osc = this.jolt * Math.exp(-dt / 0.35) * Math.sin(2 * Math.PI * 2.2 * dt);
      return this.accel + osc;
    }
    step(dt) {
      this.t += dt; this.phaseT += dt;
      const R = this.ratios, ph = this.phase;
      this.accel += (this.accTarget - this.accel) * Math.min(1, dt / this.tau);
      if (ph === 'idle') {
        this.kmh = 0; this.rpm = this.idle + 15 * Math.sin(this.t * 3); this.accTarget = 0; this.load = 0.1;
        if (this.phaseT > 2.5) { this.phase = 'launch'; this.phaseT = 0; this.gear = 1; this.tau = 0.3; }
      } else if (ph === 'launch') {
        this.accTarget = 1.6; this.load = 0.6;
        this.kmh += this.accel * 3.6 * dt;
        const slip = 1600 + 200 * this.phaseT;
        this.rpm = Math.max(slip, this.kmh * R[0]);
        if (this.kmh * R[0] >= slip) { this.phase = 'accel'; this.phaseT = 0; }
      } else if (ph === 'accel') {
        const g = this.gear;
        this.accTarget = this.acc[g - 1]; this.load = 0.8;
        this.kmh += this.accel * 3.6 * dt;
        this.rpm = this.kmh * R[g - 1];
        if (g < R.length && this.rpm >= this.targets[g - 1]) {
          this.style = STYLE_ORDER[this.nShift % STYLE_ORDER.length]; this.nShift++;
          const st = STYLES[this.style];
          this.phase = 'clutch'; this.phaseT = 0; this.tau = st.liftTau;
          this.shiftFrom = { gear: g, rpm: this.rpm, t: this.t, kmh: this.kmh };
          this.clutchStart = this.rpm;
        } else if (g === R.length && this.phaseT > 6) { this.phase = 'cruise'; this.phaseT = 0; this.tau = 0.4; }
      } else if (ph === 'clutch') {
        const st = STYLES[this.style];
        this.accTarget = -0.3; this.load = 0.05;
        this.kmh += this.accel * 3.6 * dt;
        const target = this.kmh * R[this.gear] - st.dropBelow;
        this.rpm = target + (this.clutchStart - target) * Math.exp(-this.phaseT / 0.18);
        if (this.phaseT >= 0.5) { this.phase = 'engage'; this.phaseT = 0; this.engageFrom = this.rpm; this.gear++; this.tau = st.engage; }
      } else if (ph === 'engage') {
        const st = STYLES[this.style];
        const target = this.kmh * R[this.gear - 1];
        const f = Math.min(1, this.phaseT / st.engage);
        this.rpm = this.engageFrom + (target - this.engageFrom) * f;
        this.accTarget = this.acc[this.gear - 1]; this.load = 0.6;
        this.kmh += this.accel * 3.6 * dt;
        if (f >= 1) {
          const mismatch = Math.abs(target - this.engageFrom) / target;
          this.jolt = st.kick + 3 * mismatch; this.joltT = this.t;
          this.shifts.push({ t: this.shiftFrom.t, from: this.shiftFrom.gear, to: this.gear, before: this.shiftFrom.rpm, after: target, style: this.style });
          this.phase = 'accel'; this.phaseT = 0; this.tau = 0.25;
        }
      } else if (ph === 'cruise') {
        this.accTarget = 0; this.load = 0.35; this.rpm = this.kmh * R[this.gear - 1];
        if (this.phaseT > 4) { this.phase = 'brake'; this.phaseT = 0; this.tau = 0.4; }
      } else if (ph === 'brake') {
        this.accTarget = -3.0; this.load = 0.05;
        this.kmh = Math.max(0, this.kmh + this.accel * 3.6 * dt);
        const inGear = this.kmh * R[this.gear - 1];
        if (inGear > 1300) this.rpm = inGear;
        else this.rpm += (this.idle - this.rpm) * Math.min(1, dt / 0.3);
        if (this.kmh <= 0) { this.lap++; this.accel = 0; this.accTarget = 0; this.startLap(); }
      }
      return this;
    }
  }

  // סינתזת צליל מנוע עם רעש כביש — לבדיקה ולהדגמה
  class EngineSynth {
    constructor(sampleRate, o) {
      o = o || {};
      this.sr = sampleRate; this.cyl = o.cylinders || 4;
      this.noise = o.noise != null ? o.noise : 1;
      this.phase = 0; this.rpm = 850; this.brown = 0; this.seed = 12345;
      const fp = this.cyl / 2;
      // סדרים (ביחס לסיבוב גל ארכובה) ועוצמות
      this.orders = [
        [0.5, 0.06], [1, 0.22], [1.5, 0.07], [fp, 1.0], [fp + 0.5, 0.06], [fp * 1.5, 0.28],
        [fp * 2, 0.55], [fp * 2.5, 0.12], [fp * 3, 0.32], [fp * 4, 0.18], [fp * 5, 0.08]
      ];
      this.ph = this.orders.map((_, i) => i * 1.7);
      this.jit = this.orders.map(() => 1);
    }
    rand() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
    render(out, rpmTarget, load, kmh) {
      const n = out.length, sr = this.sr, r0 = this.rpm, nz = this.noise;
      const leak = 1 - 30 / sr;
      for (let i = 0; i < n; i++) {
        const rpm = r0 + (rpmTarget - r0) * (i / n);
        const fc = rpm / 60;
        this.phase += 2 * Math.PI * fc / sr;
        if (this.phase > 1e6) this.phase -= 2 * Math.PI * 1e5;
        let v = 0;
        const amp = (0.55 + 0.45 * load) * (0.6 + rpm / 5000);
        for (let k = 0; k < this.orders.length; k++) {
          const o = this.orders[k][0], f = o * fc;
          if (f > sr / 2) continue;
          const hp = (f * f) / (f * f + 3600);
          v += this.orders[k][1] * this.jit[k] * hp * Math.sin(o * this.phase + this.ph[k]);
        }
        if ((i & 255) === 0) for (let k = 0; k < this.jit.length; k++) this.jit[k] = 0.75 + 0.5 * this.rand();
        const w = this.rand() * 2 - 1;
        this.brown = this.brown * leak + w * 0.02;
        const road = (0.25 + 0.012 * (kmh || 0)) * nz;
        v = v * amp * 0.25 + road * this.brown * 2.2 + 0.05 * nz * w;
        out[i] = v;
      }
      this.rpm = rpmTarget;
      return out;
    }
  }

  const api = { makeFFT, Spectrum, RpmTracker, GearModel, Coach, DriveSim, EngineSynth, thresholds, gradeShift, GRADES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShiftEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
