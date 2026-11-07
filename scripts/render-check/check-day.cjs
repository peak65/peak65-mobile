// Usage: node check-day.cjs <outDir>
// Checks a day's own title and note (lib/dayText.ts, components/DayText.tsx) on every
// screen piece the harness can render, against the expectations written by hand in
// gen.cjs dayFixtures(). Each piece must print exactly the expected lines - styles,
// order and text - and nothing at all when the day has neither field.
//
// The coach day detail (SessionDetail) is also compared with the ref: with the day
// text block taken out, it must be line-for-line what the ref printed, so the
// sessions under it are untouched; a day without title or note must be identical.
const fs = require('fs');
const dir = process.argv[2];
if (!dir) { console.error('usage: node check-day.cjs <outDir>'); process.exit(1); }

const fixtures = JSON.parse(fs.readFileSync(dir + '/day.json', 'utf8'));
function sections(file) {
  const s = {};
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const h = line.match(/^=== (.*) :: (.*)$/);
    if (h) { cur = h[1] + '|' + h[2]; s[cur] = []; continue; }
    if (cur && line !== '') s[cur].push(line);
  }
  return s;
}
const nw = sections(dir + '/out-new-day.txt');
const base = sections(dir + '/out-base-day.txt');

const q = JSON.stringify;
const t = (pad, style, text) => `${pad}<Text style=${q(style)}> ${q(text)}`;
const TEXT_PRIMARY = '#f0ede8';

function expected(piece, e) {
  const has = e.title != null || e.notes.length > 0;
  switch (piece) {
    case 'program.tsx DayIntro':
      if (e.race) return ['<View style="sessionDoc">', t('  ', ['sessionDesc', { marginBottom: 0 }], 'Race day')];
      if (!has) return [];
      return [
        '<View style="sessionDoc">',
        ...(e.title != null ? ['  <View style="sessionHeader">', t('    ', 'sessionName', e.title)] : []),
        ...e.notes.map((p, i) => t('  ', i === e.notes.length - 1 ? ['sessionDesc', { marginBottom: 0 }] : 'sessionDesc', p)),
      ];
    case 'home.tsx TodayDayText':
      if (e.race) return ['<View style="todayDayRow">', t('  ', 'sessionDesc', 'Race day')];
      if (!has) return [];
      return [
        '<View style="sessionBlock">',
        ...(e.title != null ? [t('  ', 'sessionName', e.title)] : []),
        ...e.notes.map(p => t('  ', 'sessionDesc', p)),
      ];
    case 'home.tsx RestDayCard':
      // The Moon is a stubbed icon; its line is matched by shape below.
      return [
        '<View style="restCard">',
        '  ?? MOON',
        t('  ', 'restTitle', 'REST DAY'),
        e.title != null ? t('  ', ['restSub', { color: TEXT_PRIMARY }], e.title) : t('  ', 'restSub', e.genericRest),
        ...e.notes.map(p => t('  ', 'restSub', p)),
      ];
    case 'coach-athlete.tsx SessionDetail':
      // Only the day text block; the rest is compared with the ref.
      if (e.race) return ['  <View style="detailSession">', t('    ', 'detailRest', 'Race day')];
      if (!has) return [];
      return [
        '  <View style="detailSession">',
        ...(e.title != null ? [t('    ', 'detailSessionName', e.title)] : []),
        ...e.notes.map(p => t('    ', 'detailRest', p)),
      ];
    case 'coach-athlete.tsx weekListLabel': return ['#label ' + q(e.list)];
    case 'coach-athlete.tsx overviewLabel': return ['#label ' + q(e.overview)];
  }
  throw new Error('unknown piece ' + piece);
}

const PIECES = ['program.tsx DayIntro', 'home.tsx TodayDayText', 'home.tsx RestDayCard',
  'coach-athlete.tsx SessionDetail', 'coach-athlete.tsx weekListLabel', 'coach-athlete.tsx overviewLabel'];

let bad = 0;
const report = (ok, id, piece, msg) => { if (!ok) bad++; console.log(`${ok ? 'OK ' : 'BAD'} ${id} :: ${piece}${msg ? '\n' + msg : ''}`); };

for (const fx of fixtures) {
  for (const piece of PIECES) {
    const got = nw[fx.id + '|' + piece];
    if (!got) { report(false, fx.id, piece, '      not rendered'); continue; }
    if (got.some(l => l.includes('THREW') || l.includes('(absent at this ref)'))) { report(false, fx.id, piece, '      ' + got.join('\n      ')); continue; }
    const exp = expected(piece, fx.expect);

    let block = got;
    let restMsg = '';
    if (piece === 'coach-athlete.tsx SessionDetail') {
      // new = ref[0] + day block + ref[1..]
      const ref = base[fx.id + '|' + piece] ?? [];
      const k = got.length - ref.length;
      block = got.slice(1, 1 + k);
      const outer = [got[0], ...got.slice(1 + k)];
      if (k < 0 || outer.length !== ref.length || outer.some((l, i) => l !== ref[i])) {
        restMsg = '      the detail outside the day text differs from the ref:\n      ref: ' + q(ref) + '\n      new: ' + q(got);
      }
    }
    const norm = piece === 'home.tsx RestDayCard' ? block.map(l => (/^  \?\? .*Moon/.test(l) ? '  ?? MOON' : l)) : block;
    const same = norm.length === exp.length && norm.every((l, i) => l === exp[i]);
    const ok = same && !restMsg;
    report(ok, fx.id, piece, ok ? '' : (same ? '' : '      expected: ' + q(exp) + '\n      got:      ' + q(norm)) + (restMsg ? '\n' + restMsg : ''));
  }
}
console.log(bad ? `${bad} DAY TEXT MISMATCHES` : `ALL ${fixtures.length} DAY FIXTURES MATCH ON ${PIECES.length} PIECES`);
process.exit(bad ? 1 : 0);
