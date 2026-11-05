// Run the current engine over every recording and report how well it agrees with the truth in them.
//   node tests/evaluate.js data/                  (all *.json in a folder)
//   node tests/evaluate.js a.json b.json [--until 280] [--mode sport]
// Per file: events by kind, rpm found, mount shake, and, where there are labels or driver tags: how many labelled
// changes were found, how many events had no label, the label × grade table, and the separation (AUC) of the
// two smoothness measures (peak jerk above road, VDV above road) between 'smooth' and 'ok/harsh' labels.
// The totals at the end pool all files: compare them before and after an engine change.
const fs = require('fs'), path = require('path');
const L = require('./lib.js');
const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
let files = args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a) && !['eco', 'sport'].includes(a));
files = files.flatMap(f => fs.statSync(f).isDirectory() ? fs.readdirSync(f).filter(x => x.endsWith('.json') && !/\.(narration|labels)\.json$/.test(x)).map(x => path.join(f, x)) : [f]);
if (!files.length) { console.error('usage: node tests/evaluate.js <folder|files…> [--until S] [--mode eco|sport]'); process.exit(1); }
const until = opt('--until') ? +opt('--until') : null, settings = opt('--mode') ? { mode: opt('--mode') } : {};
const K = ['smooth', 'ok', 'harsh'], pool = { found: 0, labels: 0, unl: 0, conf: {}, j: [], v: [], none: 0, noneFlagged: 0 };
K.concat('none').forEach(a => { pool.conf[a] = { smooth: 0, ok: 0, harsh: 0, '-': 0 }; });
const auc = (pairs) => { const pos = pairs.filter(p => p.y).map(p => p.x), neg = pairs.filter(p => !p.y).map(p => p.x); if (!pos.length || !neg.length) return null; let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (pos.length * neg.length); };
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (rec.format !== 'shift-coach-recording') { console.log(`skip ${f}: not a recording`); continue; }
  // narrated drives: ignore rpm while the driver talks, and use the labels written from the transcript
  const nar = L.narrationOf(f), mask = nar ? nar.segments.map(s => [s.t0, s.t1]) : null;
  const { coach, offset, align, seconds, rp } = L.replay(rec, { until, settings, mask });
  const truth = L.truthOf(rec, offset, until ? until : null, L.labelsOf(f));
  const kinds = coach.events.reduce((a, e) => (a[e.kind || 'up'] = (a[e.kind || 'up'] || 0) + 1, a), {});
  const rpmPct = Math.round(100 * rp.rpm.filter(p => p[1]).length / (rp.rpm.length || 1));
  if (nar) console.log(`\n(narration: ${nar.segments.length} spoken segments masked from the rpm${L.labelsOf(f) ? `, ${L.labelsOf(f).length} labels from it` : ', no labels written yet'})`);
  console.log(`\n${path.basename(f)}  ${(seconds / 60).toFixed(1)} min  build ${rec.meta && rec.meta.build || '-'}  offset ${offset.toFixed(2)} s (agree ${align.agree != null ? Math.round(align.agree * 100) + '%' : '-'})`);
  console.log(`  events ${coach.events.length} ${JSON.stringify(kinds)}  candidates ${coach.candidates.length}  rpm on ${rpmPct}% of frames  mount shake ${coach.mountShake() != null ? coach.mountShake().toFixed(2) : '-'}  re-mounts ${coach.remounts}`);
  if (!truth.length) { console.log('  no labels or driver tags in this file'); continue; }
  const { rows, unlabelled } = L.matchEvents(truth, coach.events, coach.startT);
  const real = rows.filter(r => r.l.k !== 'none'), found = real.filter(r => r.e).length;
  console.log(`  truth ${truth.length} (${truth.filter(x => x.src === 'passenger').length} passenger, ${truth.filter(x => x.src === 'driver').length} driver)  found ${found}/${real.length}  engine events with no label ${unlabelled.length}`);
  pool.found += found; pool.labels += real.length; pool.unl += unlabelled.length;
  for (const r of rows) {
    pool.conf[r.l.k][r.e ? (r.e.smooth || '-') : '-']++;
    if (r.l.k === 'none') { pool.none++; if (r.e) pool.noneFlagged++; continue; }
    if (r.e && L.excess(r.e) != null) pool.j.push({ x: L.excess(r.e), y: r.l.k !== 'smooth' });
    if (r.e && L.vdvExcess(r.e) != null) pool.v.push({ x: L.vdvExcess(r.e), y: r.l.k !== 'smooth' });
  }
}
console.log('\n=== all files ===');
console.log(`labelled changes found ${pool.found}/${pool.labels}${pool.labels ? ` (${Math.round(100 * pool.found / pool.labels)}%)` : ''}; engine events with no label ${pool.unl}; 'no change here' tags ${pool.none} (of them the engine had an event at ${pool.noneFlagged})`);
console.log('label × engine grade (rows = label):        smooth     ok  harsh   none');
for (const k of K.concat('none')) { const c = pool.conf[k]; console.log(`  ${k.padEnd(7)}${String(c.smooth).padStart(34)}${String(c.ok).padStart(7)}${String(c.harsh).padStart(7)}${String(c['-']).padStart(7)}`); }
const aj = auc(pool.j), av = auc(pool.v);
console.log(`separation of 'smooth' vs 'ok/harsh' (AUC, 0.5 = chance): peak jerk ${aj != null ? aj.toFixed(2) : '-'} (n ${pool.j.length}), VDV ${av != null ? av.toFixed(2) : '-'} (n ${pool.v.length})`);
