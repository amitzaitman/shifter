const E = require(require('path').join(__dirname, '..', 'engine.js'));

function run({ noise = 1, mode = 'eco', seconds = 130, useGps = true, useMotion = true, n = 8192, verbose = false, to = {} }) {
  const settings = { mode, ecoTarget: 2500, redline: 6500, nGears: 5, cylinders: 4 };
  const coach = new E.Coach(settings, new E.GearModel(5));
  const sim = new E.DriveSim(coach.th);
  const sr = 48000, hop = 4000, sub = 400;
  const synth = new E.EngineSynth(sr, { noise });
  const spec = new E.Spectrum(n);
  const tracker = new E.RpmTracker({ sampleRate: sr, n, ...to });
  const buf = new Float32Array(n);
  const block = new Float32Array(sub);
  const truth = []; // {t, rpm}
  let t = 0, nextGps = 1.0, nextMot = 0;
  const err = []; let nulls = 0, frames = 0;
  const events = [];
  coach.onEvent = (e) => events.push(e);
  while (t < seconds) {
    for (let k = 0; k < hop / sub; k++) {
      const dt = sub / sr;
      sim.step(dt); t += dt;
      truth.push({ t, rpm: sim.rpm, kmh: sim.kmh });
      synth.render(block, sim.rpm, sim.load, sim.kmh);
      buf.copyWithin(0, sub); buf.set(block, n - sub);
      if (useMotion) while (nextMot <= t) {
        coach.motion(nextMot, 0.05 * (Math.random() - 0.5), sim.longAccel() + 0.1 * (Math.random() - 0.5), 0.05 * (Math.random() - 0.5));
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
  return res;
}

const args = process.argv.slice(2);
if (args[0] === 'v') {
  console.log(run({ noise: +(args[1] || 1), mode: args[2] || 'eco', verbose: true, useGps: args[3] !== 'nogps' }));
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
