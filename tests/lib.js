// Shared helpers for the offline tools (evaluate.js, dataset.js): decode a recording, replay it through the engine
// with the audio↔sensor offset found automatically, and match the truth (passenger labels, driver tags) to what
// the engine produced. Needs ffmpeg.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const E = require(path.join(__dirname, '..', 'engine.js'));
const SR = 48000;

function decodeB64(b64, mime) {
  const ext = /mp4|aac|m4a/.test(mime || '') ? '.m4a' : /webm/.test(mime || '') ? '.webm' : /ogg/.test(mime || '') ? '.ogg' : '.bin';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), f = path.join(dir, 'a' + ext);
  fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '1', '-ar', String(SR), 'pipe:1'], { maxBuffer: 1 << 30 });
  fs.rmSync(dir, { recursive: true, force: true });
  return new Float32Array(out.buffer, out.byteOffset, out.length / 4);
}
// all audio segments laid out on the recording clock (gaps silent)
function audioOf(rec) {
  const segs = rec.audio.segments || [{ t0: 0, base64: rec.audio.base64 }];
  const parts = segs.map(sg => ({ t0: sg.t0 || 0, pcm: decodeB64(sg.base64, rec.audio.mime) }));
  const pcm = new Float32Array(Math.max(...parts.map(p => Math.round(p.t0 * SR) + p.pcm.length)));
  for (const p of parts) pcm.set(p.pcm, Math.round(p.t0 * SR));
  return pcm;
}
// replay with the offset that best matches the rpm logged live; opt.until limits the audio (seconds)
// narration sidecar (tests/transcribe.py): data/x.json -> data/x.narration.json
function narrationOf(file) {
  const f = file.replace(/\.json$/, '.narration.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
// labels written from the narration (by reading the transcript): data/x.labels.json = [[t, 'smooth'|'ok'|'harsh'|'none', kind?, note?], …]
function labelsOf(file) {
  const f = file.replace(/\.json$/, '.labels.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function replay(rec, opt) {
  opt = opt || {};
  let pcm = audioOf(rec);
  if (opt.until) pcm = pcm.subarray(0, Math.min(pcm.length, Math.round(opt.until * SR)));
  const base = Object.assign({ settings: opt.settings || {} }, opt.replay || {});
  // opt.mask: speech segments on the recording clock; shifted to the audio clock with the offset below
  const withMask = (off) => opt.mask ? Object.assign({}, base, { mask: opt.mask.map(([a, b]) => [a + off, b + off]) }) : base;
  let rp = new E.Replayer(rec, pcm, SR, Object.assign({ offset: 0 }, withMask(0))); rp.step();
  const al = E.alignOffset(rec.live || [], rp.rpm);
  let offset = 0;
  if (opt.offset != null) offset = opt.offset; else if (Math.abs(al.offset) >= 0.04) offset = al.offset;
  if (offset !== 0 || opt.mask) { rp = new E.Replayer(rec, pcm, SR, Object.assign({ offset }, withMask(offset))); rp.step(); }
  return { rp, coach: rp.coach, offset, align: al, seconds: pcm.length / SR };
}
// truth on the replay clock. Passenger labels are taps right after a change; driver tags sit at the event time.
function truthOf(rec, offset, until, extraLabels) {
  const out = [];
  // labels from the narration: said right after the change, like a passenger's tap (look back up to 4 s)
  for (const l of extraLabels || []) out.push({ t: l[0] + offset, k: l[1], src: 'passenger', kind: l[2], note: l[3] });
  for (const [t, k] of rec.labels || []) out.push({ t: t + offset, k, src: 'passenger' });
  for (const f of rec.feel || []) out.push({ t: f[0] + offset, k: f[1], src: 'driver', kind: f[2] });
  return out.filter(x => !until || x.t < until).sort((a, b) => a.t - b.t);
}
// match each truth item to one engine event: a passenger tap looks back up to 4 s, a driver tag ±1.5 s
function matchEvents(truth, events, startT) {
  const evs = events.map(e => ({ e, t: e.t + (startT || 0), used: false })), rows = [];
  for (const l of truth) {
    let best = null;
    for (const v of evs) {
      const d = l.t - v.t, ok = l.src === 'passenger' ? d > -1 && d < 4 : Math.abs(d) < 1.5;
      if (!v.used && ok && (!best || Math.abs(d - (l.src === 'passenger' ? 1 : 0)) < Math.abs(l.t - best.t - (l.src === 'passenger' ? 1 : 0)))) best = v;
    }
    if (best) best.used = true;
    rows.push({ l, e: best ? best.e : null });
  }
  return { rows, unlabelled: evs.filter(v => !v.used).map(v => v.e) };
}
// match truth to candidates (the engine's wider net), same windows; returns per-candidate labels
function labelCandidates(truth, cands, startT) {
  return cands.map(c => {
    const t = c.t + (startT || 0);
    const l = truth.find(x => { const d = x.t - t; return x.src === 'passenger' ? d > -1 && d < 4 : Math.abs(d) < 1.5; });
    return Object.assign({}, c, { label: l ? l.k : null, labelSrc: l ? l.src : null });
  });
}
const excess = (e) => e && e.jerk != null ? Math.max(0, e.jerk - (e.jerkBase || 0)) : null;
const vdvExcess = (e) => e && e.vdv != null ? (e.vdvBase ? Math.max(0, e.vdv ** 4 - e.vdvBase ** 4) ** 0.25 : e.vdv) : null;
module.exports = { E, SR, audioOf, narrationOf, labelsOf, replay, truthOf, matchEvents, labelCandidates, excess, vdvExcess };
