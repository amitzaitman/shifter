// הרצה חוזרת של הקלטת נסיעה (קובץ ה-JSON שהאפליקציה משתפת) דרך המנוע.
// node tests/replay.js drive.json [--mode eco|sport] [--target 2500] [--redline 6500]
//                                 [--nogps] [--nomotion] [--fresh-gears] [--offset S] [--csv out.csv] [-v]
// צריך ffmpeg כדי לפענח את הקול.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const E = require(path.join(__dirname, '..', 'engine.js'));

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('-') && /\.json$/i.test(a));
if (!file) { console.error('usage: node tests/replay.js drive.json [--mode eco|sport] [--nogps] [--nomotion] [--offset S] [--csv out.csv] [-v]'); process.exit(1); }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);

const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
if (rec.format !== 'shift-coach-recording') { console.error('not a shift-coach recording'); process.exit(1); }

// --- decode the audio with ffmpeg to mono float32 ---
const SR = 48000;
function decode(b64, mime) {
  const ext = /mp4|aac|m4a/.test(mime) ? '.m4a' : /webm/.test(mime) ? '.webm' : /ogg/.test(mime) ? '.ogg' : '.bin';
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-')), 'audio' + ext);
  fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 'f32le', '-ac', '1', '-ar', String(SR), 'pipe:1'], { maxBuffer: 1 << 30 });
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  return new Float32Array(out.buffer, out.byteOffset, out.length / 4);
}
// v2 files keep the audio in segments, each with its start time on the sensor clock; gaps stay silent
const segs = rec.audio.segments || [{ t0: 0, base64: rec.audio.base64 }];
const parts = segs.map(sg => ({ t0: sg.t0 || 0, pcm: decode(sg.base64, rec.audio.mime || '') }));
const pcm = new Float32Array(Math.max(...parts.map(p => Math.round(p.t0 * SR) + p.pcm.length)));
for (const p of parts) pcm.set(p.pcm, Math.round(p.t0 * SR));
if (parts.length > 1) console.log(`segments    ${parts.map(p => `${p.t0.toFixed(1)}s+${(p.pcm.length / SR).toFixed(0)}s`).join(', ')}`);

const settings = {};
if (opt('--mode')) settings.mode = opt('--mode');
if (opt('--target')) settings.ecoTarget = +opt('--target');
if (opt('--redline')) settings.redline = +opt('--redline');
const base = { settings, gps: !flag('--nogps'), motion: !flag('--nomotion'), freshGears: flag('--fresh-gears') };

function runWith(offset) {
  const rp = new E.Replayer(rec, pcm, SR, Object.assign({ offset }, base));
  rp.step();
  return rp;
}

// --- 1st pass with no offset, align against the rpm logged live, rerun if needed ---
let offset = opt('--offset') != null ? +opt('--offset') : 0;
let rp = runWith(offset);
const al = E.alignOffset(rec.live || [], rp.rpm);
if (opt('--offset') == null && Math.abs(al.offset) >= 0.04) { offset = al.offset; rp = runWith(offset); }

// --- report ---
const c = rp.coach, dur = pcm.length / SR;
const fmt = (v) => v == null ? '-' : String(v);
const valid = rp.rpm.filter(p => p[1]).length;
console.log(`file        ${path.basename(file)}  (${rec.startedAt || '?'})`);
console.log(`audio       ${dur.toFixed(1)} s, ${rec.audio.mime}, ${(rec.audio.bytes / 1048576).toFixed(2)} MB`);
console.log(`sensors     gps ${(rec.gps || []).length} fixes, motion ${(rec.motion || []).length} samples (${rec.motionSrc || '-'})`);
console.log(`settings    ${JSON.stringify(Object.assign({}, rec.settings, settings))}`);
console.log(`alignment   offset ${offset.toFixed(2)} s, live vs replay rpm within 5%: ${al.agree != null ? Math.round(al.agree * 100) + '%' : '-'} of ${al.n} frames`);
console.log(`rpm found   ${Math.round(100 * valid / (rp.rpm.length || 1))}% of frames`);
console.log(`gears       ${c.gears.gears.map(g => `${g.n}:${g.ratio.toFixed(1)}`).join(' ') || '-'}  (gps lag ${c.lag} s)`);
const s = c.summary();
console.log(`mount       shake at standstill ${c.mountShake() != null ? c.mountShake().toFixed(2) + ' m/s² RMS' : '-'}; phone moved in its mount ${c.remounts}×; axis quality ${c.axisQuality().toFixed(2)}`);
console.log(`events      ${s.count} (up ${s.kinds.up}, down ${s.kinds.down}, launch ${s.kinds.launch}); smooth ${fmt(s.smooth)}%; timing score ${fmt(s.score)}`);
console.log(`live had    ${(rec.events || []).length} events`);
console.log('');
console.log('  t(s)   kind    gears  before→after  timing  smooth  jerk  revDrop  dur  src');
for (const e of c.events) {
  console.log('  ' + [
    e.t.toFixed(1).padStart(6), (e.kind || 'up').padEnd(6), `${fmt(e.from)}→${fmt(e.to)}`.padEnd(5),
    (e.before != null ? `${e.before}→${e.after}` : '-').padEnd(12), fmt(e.grade).padEnd(6), fmt(e.smooth).padEnd(6),
    fmt(e.jerk).padStart(5), fmt(e.revDrop).padStart(7), fmt(e.duration).padStart(5), fmt(e.smoothSrc)
  ].join('  '));
}

// --- per-frame CSV for calibration: replay rpm, live rpm, speed, max jerk around the frame ---
const csv = opt('--csv');
if (csv) {
  const live = (rec.live || []).filter(p => p[1]);
  let li = 0;
  const rows = ['t,rpm_replay,rpm_live,kmh,jerk'];
  for (const [t, r] of rp.rpm) {
    while (li < live.length - 1 && live[li + 1][0] <= t - offset) li++;
    const l = live[li] && Math.abs(live[li][0] - (t - offset)) < 0.12 ? live[li][1] : '';
    rows.push([t.toFixed(3), r ? Math.round(r) : '', l, '', ''].join(','));
  }
  // speed and jerk come from a second light pass over the sensor logs
  const mot = rec.motion || [], gps = rec.gps || [];
  let gi = 0, mi = 0, lp = null, lastT = null, jWin = [];
  for (let i = 1; i < rows.length; i++) {
    const t = +rows[i].split(',')[0];
    while (gi < gps.length - 1 && gps[gi + 1][0] + offset <= t) gi++;
    while (mi < mot.length && mot[mi][0] + offset <= t + 0.05) {
      const [mt, x, y, z] = mot[mi++];
      if (lp) { const dt = mt - lastT, a = Math.min(1, dt / 0.12); const n = [lp[0] + a * (x - lp[0]), lp[1] + a * (y - lp[1]), lp[2] + a * (z - lp[2])]; if (dt > 0) jWin.push([mt + offset, Math.hypot(n[0] - lp[0], n[1] - lp[1], n[2] - lp[2]) / dt]); lp = n; } else lp = [x, y, z];
      lastT = mt;
    }
    jWin = jWin.filter(j => j[0] >= t - 0.1);
    const j = jWin.length ? Math.max(...jWin.map(q => q[1])) : '';
    const k = gps[gi] ? gps[gi][1] : '';
    const parts = rows[i].split(','); parts[3] = k; parts[4] = j !== '' ? j.toFixed(2) : '';
    rows[i] = parts.join(',');
  }
  fs.writeFileSync(csv, rows.join('\n') + '\n');
  console.log(`\nwrote ${csv} (${rows.length - 1} frames)`);
}
if (flag('-v')) console.log('\nlive events:', JSON.stringify(rec.events || [], null, 0));

// --- calibration labels (a passenger tapped smooth / ok / harsh right after each gear change) ---
// calibration truth: the passenger's taps (rec.labels, right after each change) and the driver's tags after the drive
// (rec.feel, at the event's own time). Both are matched the same way.
for (const [name, list] of [['passenger labels', rec.labels], ['driver tags after the drive', (rec.feel || []).map(f => [f[0], f[1]])]]) {
 if (!(list || []).length) continue;
 console.log(`\n=== ${name} ===`);
 {
  const labs = list.map(([t, k]) => ({ t: t + offset, k }));
  const evs = c.events.map(e => ({ e, t: e.t + (c.startT || 0), used: false }));
  const ex = (e) => e.jerk != null ? Math.max(0, e.jerk - (e.jerkBase || 0)) : null;
  console.log(`\nlabels      ${labs.length} (smooth ${labs.filter(l => l.k === 'smooth').length}, ok ${labs.filter(l => l.k === 'ok').length}, harsh ${labs.filter(l => l.k === 'harsh').length})`);
  console.log('  label t   label    engine event (within 4 s before the tap)   jerk above road');
  const rows = [];
  for (const l of labs) {
    // the tap comes after the shift: take the closest event that started up to 4 s before (or 1 s after) the tap
    let best = null;
    for (const v of evs) { const d = l.t - v.t; if (!v.used && d > -1 && d < 4 && (!best || Math.abs(d - 1) < Math.abs(l.t - best.t - 1))) best = v; }
    if (best) best.used = true;
    const e = best && best.e;
    rows.push({ k: l.k, e });
    console.log(`  ${l.t.toFixed(1).padStart(7)}   ${l.k.padEnd(7)}  ${e ? `${(e.kind || 'up').padEnd(6)} ${String(e.smooth).padEnd(7)} at ${best.t.toFixed(1)}` : 'MISSED'.padEnd(29)}   ${e && ex(e) != null ? ex(e).toFixed(1) : '-'}`);
  }
  const hit = rows.filter(x => x.e).length, extra = evs.filter(v => !v.used).length;
  console.log(`detection   ${hit}/${labs.length} labelled changes found; ${extra} engine events with no label (false or unlabelled)`);
  const K = ['smooth', 'ok', 'harsh'];
  console.log('confusion   rows = label, columns = engine grade');
  for (const k of K) console.log(`  ${k.padEnd(7)} ` + K.map(g => String(rows.filter(x => x.k === k && x.e && x.e.smooth === g).length).padStart(4)).join(''));
  // where would the thresholds go? jerk above road per label
  for (const k of K) {
    const v = rows.filter(x => x.k === k && x.e && ex(x.e) != null).map(x => ex(x.e)).sort((a, b) => a - b);
    if (v.length) console.log(`  ${k.padEnd(7)} jerk above road: min ${v[0].toFixed(1)}  median ${v[v.length >> 1].toFixed(1)}  max ${v[v.length - 1].toFixed(1)}  (n ${v.length})`);
  }
  for (const k of K) {
    const v = rows.filter(x => x.k === k && x.e && x.e.vdv != null).map(x => x.e.vdvBase ? Math.max(0, x.e.vdv ** 4 - x.e.vdvBase ** 4) ** 0.25 : x.e.vdv).sort((a, b) => a - b);
    if (v.length) console.log(`  ${k.padEnd(7)} VDV above road (ISO Wd): min ${v[0].toFixed(2)}  median ${v[v.length >> 1].toFixed(2)}  max ${v[v.length - 1].toFixed(2)}  (n ${v.length})`);
  }
  console.log(`current thresholds: smooth < ${E.SMOOTH_TH.ok}, ok < ${E.SMOOTH_TH.harsh}, harsh above`);
  const fit = E.learnThresholds(rows.filter(x => x.e && ex(x.e) != null).map(x => ({ x: ex(x.e), feel: x.k, shake: c.mountShake() })), E.SMOOTH_TH);
  if (fit.fitted) console.log(`learned (what the app would use after these tags): ${fit.ok} / ${fit.harsh} (best fit ${fit.fitted.ok} / ${fit.fitted.harsh}); agreement ${fit.agreePrior}% → ${fit.agree}%`);
 }
}
if ((rec.rot || []).length) console.log(`\ngyro        ${rec.rot.length} samples recorded (not used by the engine yet)`);
