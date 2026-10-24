// Usage: node harness.cjs <root> <fixtures.json>
// Renders the real program.tsx SessionDocument and coach-athlete.tsx SessionDetail
// from a source tree at <root> (a snapshot of app/, lib/, components/) for every
// fixture day, and prints a text tree: host component, style name, and every Text's
// full content (JSON-quoted, so whitespace is visible). Every Text is printed,
// including each exercise's name line, and the run fails if any non-rest-row
// exercise's name is missing from either screen. See README.md.
const path = require('path');
const fs = require('fs');
const Module = require('module');
const MOBILE = path.resolve(__dirname, '../..');
const { transform } = require(MOBILE + '/node_modules/sucrase');
const React = require(MOBILE + '/node_modules/react');

const root = fs.realpathSync(path.resolve(process.argv[2]));
const fixtures = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

// Real modules: the screens and the libs they render through. Everything else is a
// stub. A screen that starts rendering through a new lib needs it added here, or
// both trees render the stub and compare equal; stubbed project files are listed
// on stderr so that shows.
const REAL = new Set([
  'app/(main)/program.tsx', 'app/(main)/coach-athlete.tsx',
  'lib/exerciseNotes.ts', 'lib/programGrouping.ts', 'lib/roundReps.ts', 'lib/sessionOrder.ts',
]);

function stub(name) {
  const fn = function () { return stub(name); };
  return new Proxy(fn, {
    get(_, k) {
      if (k === '__esModule') return true;
      if (k === 'default') return stub(name + '.default');
      if (k === Symbol.toPrimitive) return () => name;
      if (k === 'then') return undefined;
      return stub(name + '.' + String(k));
    },
    apply() { return stub(name + '()'); },
    construct() { return stub('new ' + name); },
  });
}

const RN = new Proxy({}, {
  get(_, k) {
    if (k === '__esModule') return true;
    if (k === 'StyleSheet') return {
      create: o => Object.fromEntries(Object.keys(o).map(n => [n, n])),
      hairlineWidth: 1, flatten: x => x,
    };
    if (typeof k === 'string' && /^[A-Z]/.test(k)) return k; // host component
    return stub('RN.' + String(k));
  },
});

const stubbed = new Set();
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'react') return React;
  if (req === 'react-native') return RN;
  if (req.startsWith('.') && parent && parent.filename) {
    let base = path.resolve(path.dirname(parent.filename), req);
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const f = base + ext;
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const rel = path.relative(root, f);
        if (REAL.has(rel)) return origLoad(f, parent, isMain);
        stubbed.add(rel);
        return stub(rel);
      }
    }
    return stub(req);
  }
  if (req.startsWith('/')) return origLoad(req, parent, isMain);
  return stub(req);
};

for (const ext of ['.ts', '.tsx']) {
  require.extensions[ext] = (mod, filename) => {
    let src = fs.readFileSync(filename, 'utf8');
    const rel = path.relative(root, filename);
    if (rel === 'app/(main)/program.tsx') src += '\nexport { SessionDocument as __SessionDocument };\n';
    if (rel === 'app/(main)/coach-athlete.tsx') src += '\nexport { SessionDetail as __SessionDetail };\n';
    const out = transform(src, { transforms: ['typescript', 'jsx', 'imports'], filePath: filename, production: true }).code;
    mod._compile(out, filename);
  };
}

const { __SessionDocument } = require(path.join(root, 'app/(main)/program.tsx'));
const { __SessionDetail } = require(path.join(root, 'app/(main)/coach-athlete.tsx'));
const { orderSessions, sessionLabel } = require(path.join(root, 'lib/sessionOrder.ts'));

function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) {
    if (typeof node.type === 'function') return textOf(node.type(node.props));
    return textOf(node.props.children);
  }
  return '';
}

function render(node, depth, out) {
  if (node == null || node === false || node === true) return;
  const pad = '  '.repeat(depth);
  if (typeof node === 'string' || typeof node === 'number') { out.push(pad + '#text ' + JSON.stringify(String(node))); return; }
  if (Array.isArray(node)) { node.forEach(n => render(n, depth, out)); return; }
  if (!React.isValidElement(node)) { out.push(pad + '?? ' + String(node)); return; }
  const t = node.type;
  if (typeof t === 'function') { render(t(node.props), depth, out); return; }
  if (t === React.Fragment) { render(node.props.children, depth, out); return; }
  const style = node.props.style == null ? '' : ' style=' + JSON.stringify(node.props.style);
  if (t === 'Text') { out.push(pad + '<Text' + style + '> ' + JSON.stringify(textOf(node.props.children))); return; }
  out.push(pad + '<' + String(t) + style + '>');
  render(node.props.children, depth + 1, out);
}

const out = [];
for (const fx of fixtures) {
  out.push('=== ' + fx.id + ' :: program.tsx SessionDocument');
  orderSessions(fx.day.sessions).forEach((s, si) => {
    try { render(React.createElement(__SessionDocument, { session: s, label: sessionLabel(si) }), 0, out); }
    catch (e) { out.push('!! THREW ' + e.constructor.name + ': ' + e.message); }
  });
  out.push('=== ' + fx.id + ' :: coach-athlete.tsx SessionDetail');
  try { render(React.createElement(__SessionDetail, { day: fx.day, logs: [] }), 0, out); }
  catch (e) { out.push('!! THREW ' + e.constructor.name + ': ' + e.message); }
}
process.stdout.write(out.join('\n') + '\n');
process.stderr.write('stubbed project files: ' + [...stubbed].sort().join(', ') + '\n');

// Every exercise that isn't a rest row prints its name on both screens.
const sectionsOf = {};
let cur = null;
for (const line of out) {
  if (line.startsWith('=== ')) { cur = line; sectionsOf[cur] = []; continue; }
  sectionsOf[cur].push(line);
}
let missing = 0;
for (const fx of fixtures) {
  const names = fx.day.sessions.flatMap(s => s.blocks.flatMap(b => b.exercises))
    .filter(e => e.type !== 'rest').map(e => e.name);
  for (const screen of ['program.tsx SessionDocument', 'coach-athlete.tsx SessionDetail']) {
    const lines = sectionsOf['=== ' + fx.id + ' :: ' + screen] ?? [];
    for (const n of new Set(names)) {
      // A name line is exerciseName (Program) or detailExercise (coach), possibly
      // with a "1)" / "A)" / time-window prefix in front of the name.
      if (!lines.some(l => /<Text style="(exerciseName|detailExercise)">/.test(l) && l.endsWith(JSON.stringify(n).slice(1)))) {
        process.stderr.write(`MISSING NAME ${JSON.stringify(n)} in ${fx.id} :: ${screen}\n`);
        missing++;
      }
    }
  }
}
if (missing) process.exit(2);
