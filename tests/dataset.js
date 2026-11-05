// Export one CSV row per candidate moment (the engine's wider net) from every recording, with its features, the
// event the engine made of it (if any) and the truth label (if any). For fitting a detector or thresholds.
//   node tests/dataset.js data/ > candidates.csv
const fs = require('fs'), path = require('path');
const L = require('./lib.js');
let files = process.argv.slice(2);
files = files.flatMap(f => fs.statSync(f).isDirectory() ? fs.readdirSync(f).filter(x => x.endsWith('.json') && !/\.(narration|labels)\.json$/.test(x)).map(x => path.join(f, x)) : [f]);
if (!files.length) { console.error('usage: node tests/dataset.js <folder|files…> > out.csv'); process.exit(1); }
const cols = ['file', 't', 'why', 'q', 'rB', 'rA', 'pre', 'dip', 'rec', 'jx', 'conf', 'kmh', 'axis', 'event_kind', 'event_smooth', 'event_jerk_excess', 'event_vdv', 'label', 'label_src', 'mount_shake'];
console.log(cols.join(','));
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (rec.format !== 'shift-coach-recording') continue;
  const nar = L.narrationOf(f);
  const { coach, offset } = L.replay(rec, { mask: nar ? nar.segments.map(x => [x.t0, x.t1]) : null });
  const truth = L.truthOf(rec, offset, null, L.labelsOf(f)), cands = L.labelCandidates(truth, coach.candidates, coach.startT);
  const shake = coach.mountShake();
  for (const c of cands) {
    const ev = coach.events.find(e => Math.abs(e.t - c.t) < 1.5);
    const row = { file: path.basename(f), t: c.t, why: c.why, q: c.q, rB: c.rB, rA: c.rA, pre: c.pre, dip: c.dip, rec: c.rec, jx: c.jx, conf: c.conf, kmh: c.kmh, axis: c.axis,
      event_kind: ev ? ev.kind || 'up' : '', event_smooth: ev ? ev.smooth || '' : '', event_jerk_excess: ev && L.excess(ev) != null ? L.excess(ev).toFixed(2) : '', event_vdv: ev && L.vdvExcess(ev) != null ? L.vdvExcess(ev).toFixed(2) : '',
      label: c.label || '', label_src: c.labelSrc || '', mount_shake: shake != null ? shake.toFixed(2) : '' };
    console.log(cols.map(k => row[k] == null ? '' : String(row[k])).join(','));
  }
}
