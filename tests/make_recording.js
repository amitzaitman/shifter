// יוצר הקלטת נסיעה מדומה באותו פורמט שהאפליקציה משתפת, כדי לבדוק את tests/replay.js בלי רכב.
// node tests/make_recording.js out.json [seconds] [mode] [audioOffset]
// audioOffset: בכמה שניות הקול מקדים את שעון החיישנים (כמו השהיה של MediaRecorder). replay אמור למצוא אותו.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const E = require(path.join(__dirname, '..', 'engine.js'));

const [out = 'fake-drive.json', secs = '90', mode = 'eco', offS = '0.25'] = process.argv.slice(2);
const seconds = +secs, audioOffset = +offS, sr = 48000, sub = 400;
const settings = { mode, ecoTarget: 2500, redline: 6500, nGears: 5, cylinders: 4, rpmScale: 1 };
const th = E.thresholds(settings);
const sim = new E.DriveSim(th), synth = new E.EngineSynth(sr, { noise: 1 });
const pcm = new Float32Array(Math.ceil(seconds * sr));
const gps = [], motion = [], live = [], block = new Float32Array(sub), lagQ = [];
let t = 0, nextGps = 1, nextMot = 0, idx = 0;
while (t < seconds) {
  const dt = sub / sr;
  sim.step(dt); t += dt;
  synth.render(block, sim.rpm, sim.load, sim.kmh);
  pcm.set(block.subarray(0, Math.min(sub, pcm.length - idx)), idx); idx += sub;
  // sensor clock = audio clock + audioOffset
  lagQ.push([t, sim.kmh]); while (lagQ.length && lagQ[0][0] < t - 2) lagQ.shift();
  while (nextMot <= t) { motion.push([+(nextMot + audioOffset).toFixed(3), +(0.04 * (Math.random() - 0.5)).toFixed(3), +(sim.longAccel() + 0.1 * (Math.random() - 0.5)).toFixed(3), +(0.04 * (Math.random() - 0.5)).toFixed(3), 0, 0, 9.81]); nextMot += 1 / 60; }
  if (t >= nextGps) { const o = lagQ.find(q => q[0] >= t - 0.4) || lagQ[0]; gps.push([+(t + audioOffset).toFixed(3), +Math.max(0, o[1] + (Math.random() - 0.5) * 0.6).toFixed(2), null, null, 5]); nextGps += 1; }
}
// "live" rpm: what the phone's tracker would have logged (same tracker, on the sensor clock)
{
  const n = 8192, hop = Math.round(sr / 12), spec = new E.Spectrum(n), tr = new E.RpmTracker({ sampleRate: sr, n, cylinders: 4 });
  for (let st = 0; st + n <= pcm.length; st += hop) {
    const tc = (st + n / 2) / sr, r = tr.update(spec.compute(pcm, st), tc, null);
    live.push([+(tc + audioOffset).toFixed(3), r.rpm ? Math.round(r.rpm) : null]);
  }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkrec-'));
const raw = path.join(dir, 'a.f32'), m4a = path.join(dir, 'a.m4a');
fs.writeFileSync(raw, Buffer.from(pcm.buffer));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(sr), '-ac', '1', '-i', raw, '-c:a', 'aac', '-b:a', '96k', m4a]);
const bytes = fs.readFileSync(m4a);
fs.rmSync(dir, { recursive: true, force: true });
const rec = {
  format: 'shift-coach-recording', v: 1, startedAt: new Date().toISOString(), userAgent: 'make_recording.js',
  settings, sampleRate: sr, fftN: 8192, motionSrc: 'acceleration', gearsAtStart: null,
  gps, motion, live, events: [],
  audio: { mime: 'audio/mp4', bytes: bytes.length, base64: bytes.toString('base64') },
  truth: { audioOffset, shifts: sim.shifts, downs: sim.downs, launches: sim.launches }
};
fs.writeFileSync(out, JSON.stringify(rec));
console.log(`wrote ${out}: ${seconds}s, ${(bytes.length / 1048576).toFixed(2)} MB audio, ${sim.shifts.length} up / ${sim.downs.length} down / ${sim.launches.length} launch; replay should find offset ${(-audioOffset).toFixed(2)}`);
