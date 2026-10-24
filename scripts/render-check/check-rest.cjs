// Usage: node check-rest.cjs <outDir>
// Compares the rest text the working tree's screens rendered (<outDir>/out-new-rest.txt)
// against the web's own src/lib/rest.ts, compiled straight from the web repo
// ($PEAK65_WEB, default ~/Documents/peak65).
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { transform } = require(path.resolve(__dirname, '../../node_modules/sucrase'));
const dir = process.argv[2];
if (!dir) { console.error('usage: node check-rest.cjs <outDir>'); process.exit(1); }
const webRepo = process.env.PEAK65_WEB || path.join(os.homedir(), 'Documents/peak65');
const webSrc = fs.readFileSync(path.join(webRepo, 'src/lib/rest.ts'), 'utf8');
const m = new Module('web-rest');
m._compile(transform(webSrc, { transforms: ['typescript', 'imports'] }).code, 'web-rest.ts');
const web = m.exports;

const fixtures = JSON.parse(fs.readFileSync(dir + '/rest.json', 'utf8'));
const out = fs.readFileSync(dir + '/out-new-rest.txt', 'utf8').split('\n');

// Collect each fixture's section per screen.
const sections = {};
let cur = null;
for (const line of out) {
  const h = line.match(/^=== (.*) :: (program|coach-athlete)\.tsx/);
  if (h) { cur = h[1] + '|' + h[2]; sections[cur] = []; continue; }
  if (cur) sections[cur].push(line);
}
const q = s => { const mm = s.match(/> (".*")$/); return mm ? JSON.parse(mm[1]) : null; };

let bad = 0;
for (const fx of fixtures) {
  const sq = fx.day.sessions[0].blocks[0].exercises[0];
  const first = fx.day.sessions[0].blocks[0].exercises[1];
  const expEx = web.restText(sq);
  const expCirc = web.circuitRestText(first);
  for (const screen of ['program', 'coach-athlete']) {
    const lines = sections[fx.id + '|' + screen];
    if (lines.some(l => l.includes('THREW'))) { console.log('THREW', fx.id, screen); bad++; continue; }
    const texts = lines.map(q).filter(t => t != null);
    // Squat's detail line is the text right after its name line.
    const nameIdx = texts.findIndex(t => /Squat$/.test(t));
    const detail = texts[nameIdx + 1];
    const base = screen === 'program' ? '3 × 10' : '3×10';
    const gotEx = detail === base ? null : detail.startsWith(base + ' · ') ? detail.slice(base.length + 3) : '??' + detail;
    const circLine = texts.find(t => / between rounds$/.test(t)) ?? null;
    const gotCirc = circLine == null ? null : (screen === 'program' ? circLine.replace(/^  /, '') : circLine);
    // Nothing else in the section may mention rest.
    const stray = texts.filter(t => /rest/i.test(t) && t !== detail && t !== circLine);
    const ok = gotEx === expEx && gotCirc === expCirc && stray.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'BAD'} ${screen.padEnd(13)} how=${JSON.stringify(fx.how)} what=${JSON.stringify(fx.what)}\n` +
      `      exercise: ${JSON.stringify(gotEx)}  web: ${JSON.stringify(expEx)}\n` +
      `      circuit : ${JSON.stringify(circLine)}  web: ${JSON.stringify(expCirc)}` + (stray.length ? `\n      STRAY: ${JSON.stringify(stray)}` : ''));
  }
}
console.log(bad ? `${bad} MISMATCHES` : 'ALL MATCH THE WEB FORMATTER');
process.exit(bad ? 1 : 0);
