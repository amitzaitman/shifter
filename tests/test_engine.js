const E = require(require('path').join(__dirname, '..', 'engine.js'));

// phone: טלפון מוטה ומסובב במעמד (הכבידה מועברת ל-coach). turns: פניות חדות. road: עוצמת רעש הכביש (m/s²). passG: להעביר כבידה.
function run({ noise = 1, mode = 'eco', seconds = 130, useGps = true, useMotion = true, n = 8192, verbose = false, to = {}, phone = false, turns = false, road = 0, passG = true, cs = {} }) {
  const settings = Object.assign({ mode, ecoTarget: 2500, redline: 6500, nGears: 5, cylinders: 4 }, cs);
  const coach = new E.Coach(settings, new E.GearModel(5));
  const sim = new E.DriveSim(coach.th);
  const sr = 48000, hop = 4000, sub = 400;
  const synth = new E.EngineSynth(sr, { noise });
  const spec = new E.Spectrum(n);
  const tracker = new E.RpmTracker({ sampleRate: sr, n, ...to });
  const buf = new Float32Array(n);
  const block = new Float32Array(sub);
  const truth = []; // {t, rpm}
  let t = 0, nextGps = 1.0, nextMot = 0, roadN = [0, 0, 0];
  // מסגרת הטלפון: מוטה 35° אחורה ומסובב 25° סביב הציר האנכי
  const PH = (() => {
    const p = 35 * Math.PI / 180, y = 25 * Math.PI / 180;
    const up = [0, Math.sin(p), Math.cos(p)], fwd0 = [0, Math.cos(p), -Math.sin(p)], lat0 = [1, 0, 0];
    const rot = (v, w) => v.map((_, i) => v[i] * Math.cos(y) + w[i] * Math.sin(y));
    return { up, fwd: rot(fwd0, lat0), lat: rot(lat0, fwd0.map(v => -v)) };
  })();
  const err = []; let nulls = 0, frames = 0;
  const events = [];
  const allEvents = [];
  coach.onEvent = (e) => { allEvents.push(e); if ((e.kind || 'up') === 'up') events.push(e); };
  while (t < seconds) {
    for (let k = 0; k < hop / sub; k++) {
      const dt = sub / sr;
      sim.step(dt); t += dt;
      truth.push({ t, rpm: sim.rpm, kmh: sim.kmh });
      synth.render(block, sim.rpm, sim.load, sim.kmh);
      buf.copyWithin(0, sub); buf.set(block, n - sub);
      if (useMotion) while (nextMot <= t) {
        if (!phone) coach.motion(nextMot, 0.05 * (Math.random() - 0.5), sim.longAccel() + 0.1 * (Math.random() - 0.5), 0.05 * (Math.random() - 0.5));
        else {
          const tm = nextMot;
          // פנייה חדה כל 9 שניות: תאוצה צידית של 3 m/s² שנבנית תוך 0.4 שנ' (jerk של בערך 12)
          let lat = 0;
          if (turns) { const ph = (tm + 3) % 9; if (ph < 2.4) lat = 3 * Math.sin(Math.PI * Math.min(1, ph / 0.8, (2.4 - ph) / 0.8) / 2) ** 2; }
          roadN = roadN.map(v => v * 0.9 + (Math.random() - 0.5) * road * 0.9);
          const lon = sim.longAccel() + roadN[0], la = lat + roadN[1], up = roadN[2] * 3;
          const a = [0, 1, 2].map(i => PH.fwd[i] * lon + PH.lat[i] * la + PH.up[i] * up + 0.03 * (Math.random() - 0.5));
          if (passG) coach.motion(tm, a[0], a[1], a[2], PH.up[0] * 9.81, PH.up[1] * 9.81, PH.up[2] * 9.81); else coach.motion(tm, a[0], a[1], a[2]);
        }
        nextMot += 1 / 60;
      }
      if (useGps && t >= nextGps) {
        const lagT = t - 0.4; const tr = truth.find(x => x.t >= lagT) || truth[truth.length - 1];
        coach.gpsFix(t, Math.max(0, tr.kmh + (Math.random() - 0.5) * 0.6));
        nextGps += 1.0;
      }
    }
    if (t < n / sr) continue;
    const tc = t - (n / 2) / sr;
    const mag = spec.compute(buf);
    const priors = coach.gears.complete ? coach.gears.predict(coach.speedAt(tc)) : null;
    const r = tracker.update(mag, tc, priors);
    coach.audio(tc, r);
    const tr = truth.find(x => x.t >= tc);
    if (tr && sim.phase !== 'x') {
      frames++;
      if (r.rpm == null) nulls++;
      else err.push(Math.abs(r.rpm - tr.rpm) / tr.rpm);
    }
  }
  err.sort((a, b) => a - b);
  const within = (p) => err.filter(e => e <= p).length / frames;
  const res = {
    noise, mode, frames,
    nullRate: +(nulls / frames).toFixed(3),
    within5: +within(0.05).toFixed(3), within10: +within(0.10).toFixed(3),
    medianErr: +(err[err.length >> 1] * 100).toFixed(2) + '%',
    gears: coach.gears.gears.map(g => `${g.n}:${g.ratio.toFixed(1)}`).join(' '),
    trueShifts: sim.shifts.length, detected: events.length
  };
  // match events to truth shifts
  const truthGrades = sim.shifts.map(s => ({ ...s, g: E.gradeShift(s.before, s.after, coach.th).grade }));
  let matched = 0, gradeOk = 0, fp = 0, smoothOk = 0;
  const used = new Set();
  for (const e of events) {
    const et = e.t + coach.startT;
    let bi = -1, bd = 1.2;
    truthGrades.forEach((s, i) => { const d = Math.abs(s.t - et); if (d < bd && !used.has(i)) { bd = d; bi = i; } });
    if (bi < 0) { fp++; if (verbose) console.log('  FP', e); continue; }
    used.add(bi); matched++;
    const s = truthGrades[bi];
    if (s.g === e.grade) gradeOk++;
    if (s.style === e.smooth) smoothOk++;
    if (verbose) console.log(`  shift ${s.from}->${s.to} true ${Math.round(s.before)}/${Math.round(s.after)} ${s.g} ${s.style} | det ${e.from}->${e.to} ${e.before}/${e.after} ${e.grade} smooth=${e.smooth} j=${e.jerk}`);
  }
  if (verbose) truthGrades.forEach((s, i) => { if (!used.has(i)) console.log(`  MISSED ${s.from}->${s.to} ${Math.round(s.before)}/${Math.round(s.after)} at ${s.t.toFixed(1)}`); });
  Object.assign(res, { matched, gradeOk, smoothOk, falsePos: fp });
  if (phone) { const f = coach.forwardAxis(); res.axisErr = f ? Math.round(Math.acos(Math.min(1, Math.abs(f[0] * PH.fwd[0] + f[1] * PH.fwd[1] + f[2] * PH.fwd[2]))) * 180 / Math.PI) + '°' : 'none'; }
  // הורדות הילוך וזינוקים: התאמה לפי זמן, ובדיקת ציון החלקות
  const other = (kind, truthList, tol) => {
    const evs = allEvents.filter(e => e.kind === kind), used = new Set(); let m = 0, ok = 0, fpo = 0;
    for (const e of evs) {
      const et = e.t + coach.startT; let bi = -1, bd = tol;
      truthList.forEach((s, i) => { const d = Math.abs(s.t - et); if (d < bd && !used.has(i)) { bd = d; bi = i; } });
      if (bi < 0) { fpo++; if (verbose) console.log('  FP ' + kind, e); continue; }
      used.add(bi); m++; if (truthList[bi].style === e.smooth) ok++;
      if (verbose) console.log(`  ${kind} true ${truthList[bi].style} | det smooth=${e.smooth} j=${e.jerk} revDrop=${e.revDrop} dur=${e.duration} ${e.from}->${e.to}`);
    }
    if (verbose) truthList.forEach((s, i) => { if (!used.has(i)) console.log(`  MISSED ${kind} ${s.style} at ${s.t.toFixed(1)}`); });
    return `${m}/${truthList.length} ok${ok} fp${fpo}`;
  };
  res.down = other('down', sim.downs, 2.0);
  res.launch = other('launch', sim.launches, 2.5);
  return res;
}

const args = process.argv.slice(2);
if (args[0] === 'v') {
  console.log(run({ noise: +(args[1] || 1), mode: args[2] || 'eco', verbose: true, useGps: args[3] !== 'nogps' }));
} else if (args[0] === 'motion') {
  // טלפון מוטה 30°: מהמורה אנכית צריכה להיעלם, דחיפה אופקית צריכה להישאר
  const peak = (kind, withG) => {
    const c = new E.Coach({ mode: 'eco', ecoTarget: 2500, redline: 6500, nGears: 5, cylinders: 4 }, new E.GearModel(5));
    const th = Math.PI / 6, up = [0, Math.sin(th), Math.cos(th)], fwd = [0, Math.cos(th), -Math.sin(th)];
    const dir = kind === 'bump' ? up : fwd;
    for (let i = 0; i < 600; i++) {
      const t = i / 60, s = (t > 5 && t < 5.15) ? 4 * Math.sin((t - 5) / 0.15 * Math.PI) : 0;
      const a = dir.map(v => v * s);
      if (withG) c.motion(t, a[0], a[1], a[2], up[0] * 9.81, up[1] * 9.81, up[2] * 9.81); else c.motion(t, a[0], a[1], a[2]);
    }
    return Math.max(...c.jerk.map(e => e.j));
  };
  const r = { bumpNoG: peak('bump', false), bumpG: peak('bump', true), kickG: peak('kick', true) };
  for (const k in r) r[k] = Math.round(r[k] * 100) / 100;
  console.log(r, r.bumpG < 0.1 && r.kickG > 5 ? 'PASS' : 'FAIL');
} else if (args[0] === 'learn') {
  // learning thresholds from the driver's tags (synthetic tags with known boundaries)
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mk = (n, lo, hi, feel, shake = 1.65) => Array.from({ length: n }, () => ({ x: lo + rnd() * (hi - lo), feel, shake }));
  const D = E.SMOOTH_TH, show = (name, r) => console.log(name.padEnd(44), `→ ${r.ok} / ${r.harsh}  (fit ${r.fitted ? r.fitted.ok + ' / ' + r.fitted.harsh : '-'}, n ${r.n}, agree ${r.agreePrior ?? '-'}% → ${r.agree ?? '-'}%)`);
  const cases = {
    'agrees with the defaults (30 tags)': [...mk(12, 0, 1.8, 'smooth'), ...mk(10, 2.2, 4.2, 'ok'), ...mk(8, 5, 9, 'harsh')],
    'tolerant driver: smooth up to 3.5 (30 tags)': [...mk(12, 0, 3.4, 'smooth'), ...mk(10, 3.6, 6.8, 'ok'), ...mk(8, 7.2, 11, 'harsh')],
    'only 2 tags': [...mk(1, 0, 1, 'smooth'), ...mk(1, 6, 7, 'harsh')],
    'only smooth tags, some above 2 (8 tags)': mk(8, 0.5, 3, 'smooth'),
    'defaults + 1 wrong tag (21 tags)': [...mk(10, 0, 1.8, 'smooth'), ...mk(6, 2.2, 4.2, 'ok'), ...mk(4, 5, 9, 'harsh'), { x: 0.6, feel: 'harsh', shake: 1.65 }],
    'steady mount 0.3: same feel, half the jerk': [...mk(12, 0, 0.9, 'smooth', 0.3), ...mk(10, 1.1, 2.1, 'ok', 0.3), ...mk(8, 2.5, 4.5, 'harsh', 0.3)],
  };
  const res = {}; for (const [k, v] of Object.entries(cases)) { res[k] = E.learnThresholds(v, D); show(k, res[k]); }
  const ok = res['agrees with the defaults (30 tags)'], tol = res['tolerant driver: smooth up to 3.5 (30 tags)'];
  const pass = Math.abs(ok.ok - D.ok) < 0.35 && Math.abs(ok.harsh - D.harsh) < 0.6 && tol.ok > 2.6 && tol.harsh > 5.4 && res['only 2 tags'].ok === D.ok
    && res['only smooth tags, some above 2 (8 tags)'].ok > D.ok && Math.abs(res['defaults + 1 wrong tag (21 tags)'].ok - D.ok) < 0.4;
  console.log(`mount factor: shake 0.3 → ×${E.mountFactor(0.3, 1.65).toFixed(2)}, 1.65 → ×${E.mountFactor(1.65, 1.65).toFixed(2)}, 3 → ×${E.mountFactor(3, 1.65).toFixed(2)}`);
  console.log(pass ? 'PASS' : 'FAIL');
} else if (args[0] === 'phone') {
  // טלפון מוטה ומסובב, פניות חדות ורעש כביש: ציר נסיעה + סף יחסי מול jerk בכל הכיוונים
  // החלקות נבדקת על כל האירועים יחד (העברה למעלה, הורדה, זינוק); כל שורה = ממוצע של 3 הרצות
  const score = (o) => {
    let ok = 0, tot = 0, ax = [];
    for (let k = 0; k < 3; k++) {
      const r = run(o), d = r.down.match(/(\d+)\/\d+ ok(\d+)/), l = r.launch.match(/(\d+)\/\d+ ok(\d+)/);
      ok += r.smoothOk + +d[2] + +l[2]; tot += r.matched + +d[1] + +l[1]; if (r.axisErr) ax.push(r.axisErr);
    }
    return `smooth correct ${ok}/${tot} (${Math.round(100 * ok / tot)}%)` + (ax.length ? `  axis error ${ax.join(' ')}` : '');
  };
  const P = { phone: true, turns: true, road: 0.3 };
  for (const mode of ['eco', 'sport']) {
    console.log(mode, 'flat phone, no turns           ', score({ mode }));
    console.log(mode, 'tilted + turns + road: new     ', score({ mode, ...P }));
    console.log(mode, '  without travel axis          ', score({ mode, ...P, cs: { jerkAxis: false } }));
    console.log(mode, '  without road baseline        ', score({ mode, ...P, cs: { jerkBaseline: false } }));
    console.log(mode, '  old (neither)                ', score({ mode, ...P, cs: { jerkAxis: false, jerkBaseline: false } }));
    console.log(mode, '  no GPS (PCA axis, up only)   ', score({ mode, ...P, useGps: false }));
  }
} else if (args[0] === 'grid3') {
  for (const to of [{}, {contFloor:0.15}, {contFloor:0.08}]) for (const mode of ['eco','sport']) for (const noise of [1,2]) {
    const r = run({ noise, mode, to });
    console.log(JSON.stringify(to), mode, noise, 'w5', r.within5, 'null', r.nullRate, 'gears', r.gears, 'm', r.matched+'/'+r.trueShifts, 'ok', r.gradeOk, 'smooth', r.smoothOk, 'fp', r.falsePos);
  }
} else if (args[0] === 'grid2') {
  for (const [nn,to] of [[8192,{}],[16384,{}],[8192,{harmonics:8}],[16384,{harmonics:8}],[16384,{harmonics:8,alpha:0.6}]]) for (const mode of ['eco','sport']) for (const noise of [1,2]) {
    const r = run({ noise, mode, to, n: nn });
    console.log(nn, JSON.stringify(to), mode, noise, 'w5', r.within5, 'null', r.nullRate, 'gears', r.gears, 'm', r.matched+'/'+r.trueShifts, 'ok', r.gradeOk, 'fp', r.falsePos);
  }
} else if (args[0] === 'grid') {
  for (const to of [{}, {linear:true}, {wExp:1.2}, {linear:true,wExp:1.2}, {alpha:0.7}]) for (const mode of ['eco','sport']) for (const noise of [0.5,1,2,4]) {
    const r = run({ noise, mode, to });
    console.log(JSON.stringify(to), mode, noise, 'w5', r.within5, 'null', r.nullRate, 'gears', r.gears, 'm', r.matched+'/'+r.trueShifts, 'ok', r.gradeOk, 'fp', r.falsePos);
  }
} else {
  for (const mode of ['eco', 'sport']) for (const noise of [0.5, 1, 2, 4]) {
    const t0 = Date.now();
    const r = run({ noise, mode });
    console.log(JSON.stringify(r), (Date.now() - t0) + 'ms');
  }
  for (const noise of [1, 2]) console.log('noGPS', JSON.stringify(run({ noise, useGps: false })));
}
