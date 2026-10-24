// Usage: node gen.cjs <outDir>
// Writes fixtures: structure.json (no rest fields), structure-rest.json (same, with
// rests everywhere), rest.json (one day per rest case).
const fs = require('fs');
const dir = process.argv[2];
if (!dir) { console.error('usage: node gen.cjs <outDir>'); process.exit(1); }
const sess = (name, blocks, extra = {}) => ({ name, time: 'AM', duration_minutes: 60, description: 'desc ' + name, blocks, ...extra });
const day = (sessions) => ({ day: 'Monday', type: 'training', sessions });

function structure() {
  const main = [
    { name: 'First Exercise Back Squat', type: 'strength', sets: 4, reps: '8', notes: 'Load: RPE 8 | Pace: 6:30/mi | brace hard' },
    { name: 'Pyramid Bench', sets: 4, reps: '12', round_reps: ['12', '10', '8', '6'] },
    { name: 'Drop Set Curl', sets: 3, reps: '10', extra_segments: [{ reps: '8', load: '10 kg', on: 'all' }] },
    { name: 'Ladder + Drop Row', sets: 4, reps: '12', round_reps: ['12', '10', '8', '6'], extra_segments: [{ reps: '20', load: '60 kg', on: 'last' }] },
    { name: 'Duration Drop Plank', sets: 3, duration: '45 sec', extra_segments: [{ reps: '15 sec', on: 'last' }] },
    { name: 'Rest Row', type: 'rest', duration: '3 min', reps: '3 min', rest: '0 min' },
    { name: 'Superset A', sets: 3, reps: '10', superset_id: 'ss1' },
    { name: 'Superset B', sets: 3, reps: '12', superset_id: 'ss1', distance: '200m', zone: '2' },
    { name: 'Circuit Wall Balls', reps: '30', round_reps: ['30', '40', '50'], circuit_id: 'c1', circuit_rounds: 3 },
    { name: 'Circuit Burpees', reps: '10', circuit_id: 'c1', circuit_rounds: 3 },
    { name: 'Rest Row Reps Only', type: 'rest', reps: '2 min' },
    { name: 'AMRAP circuit A', reps: '10', circuit_id: 'c2', time_cap: 12 },
    { name: 'AMRAP circuit B', reps: '15', circuit_id: 'c2', time_cap: 12 },
    { name: 'EMOM A', reps: '5', emom_id: 'e1', emom_label: 'Strength emom', emom_rounds: 6, time_window: '0:00-1:00', round_reps: ['5', '5', '4', '4', '3', '3'] },
    { name: 'EMOM B', reps: '10 Cal', emom_id: 'e1', emom_rounds: 6, time_window: '1:00-2:00' },
    { name: 'AMRAP A', reps: '8', amrap_id: 'a1', amrap_label: 'Finisher', amrap_time_cap: 10 },
    { name: 'AMRAP B', reps: '12', amrap_id: 'a1', amrap_time_cap: 10 },
    { name: 'FT Thrusters', reps: '21', round_reps: ['21', '15', '9'], for_time_id: 'f1', for_time_label: '21-15-9', for_time_rounds: 3, for_time_cap: 15 },
    { name: 'FT Pull-ups', reps: '21', duration: '', for_time_id: 'f1', for_time_rounds: 3 },
    { name: 'Rest Row Bare', type: 'rest' },
    { name: 'Part single 1', sets: 2, reps: '5', block_id: 'p1', block_name: 'Part A' },
    { name: 'Part single 2', sets: 1, reps: '1', block_id: 'p1', block_name: 'Part A' },
    { name: 'Part circuit 1', reps: '10', block_id: 'p2', block_name: 'Part B', circuit_id: 'pc', circuit_rounds: 5 },
    { name: 'Part circuit 2', reps: '20', block_id: 'p2', block_name: 'Part B', circuit_id: 'pc', circuit_rounds: 5 },
    { name: 'Part ss 1', sets: 3, reps: '6', block_id: 'p3', block_name: 'Part C', superset_id: 'pss' },
    { name: 'Part ss 2', sets: 3, reps: '8', block_id: 'p3', block_name: 'Part C', superset_id: 'pss' },
    { name: 'Part emom 1', reps: '3', block_id: 'p4', block_name: 'Part D', emom_id: 'pe', emom_rounds: 4, time_window: '0-30s' },
    { name: 'Part emom 2', reps: '4', block_id: 'p4', block_name: 'Part D', emom_id: 'pe', emom_rounds: 4 },
    { name: 'Part amrap 1', reps: '3', block_id: 'p5', block_name: 'Part E', amrap_id: 'pa', amrap_time_cap: 8 },
    { name: 'Part amrap 2', reps: '4', block_id: 'p5', block_name: 'Part E', amrap_id: 'pa' },
    { name: 'Part ft 1', reps: '50', block_id: 'p6', block_name: 'Part F', for_time_id: 'pf', for_time_rounds: 1 },
    { name: 'Part ft 2', reps: '40', block_id: 'p6', block_name: 'Part F', for_time_id: 'pf' },
    { name: 'Lone circuit member', reps: '9', circuit_id: 'lone', circuit_rounds: 3 },
    { name: 'Run', type: 'cardio', duration: '30 min', distance: '5k', zone: '2', notes: 'Pace: 5:00/km' },
  ];
  const warm = [
    { name: 'Warm jog', duration: '10 min' },
    { name: 'Warm ss A', sets: 2, reps: '10', superset_id: 'w1' },
    { name: 'Warm ss B', sets: 2, reps: '10', superset_id: 'w1' },
    { name: 'Warm rest row', type: 'rest', duration: '1 min' },
    { name: 'Warm single', reps: '1' },
  ];
  return [
    { id: 'structure', day: day([
      sess('Session One', [{ block_name: 'Warm-up', exercises: warm }, { block_name: 'MAIN', exercises: main }, { block_name: '', exercises: [{ name: 'Cooldown stretch', duration: '5 min' }] }], { time: 'AM' }),
      sess('Session Two', [{ block_name: 'Main Set', exercises: main.slice(0, 10) }], { time: 'PM' }),
      sess('Session Three', [{ block_name: 'Other', exercises: main.slice(10, 20) }], { time: '' }),
    ]) },
  ];
}

// Every structural fixture again, with a rest and circuit rest on every exercise.
function withRests(fx) {
  const c = JSON.parse(JSON.stringify(fx));
  for (const f of c) {
    f.id += '+rest';
    for (const s of f.day.sessions) for (const b of s.blocks) for (const e of b.exercises) {
      e.rest = '90 Seconds';
      e.circuit_rest = '2 min';
    }
  }
  return c;
}

const RESTS = [
  ['60 Second Rest', null], ['3 Minute Float @ 110-130 Watts', null], ['90 Second Recovery @ Z2 Pace', null],
  ['45 Second Standing Rest', null], ['2 Minute Recovery Float @ 10:00/Mile', null], ['90 Seconds', null],
  ['60 sec', 'standing'], ['90 sec', 'float'],
  ['none', null], ['null', null], ['0', null], ['0 min', null], ['0:00', null], ['00:00', null], ['', null], ['   ', null],
  ['NONE', null], ['Null', null], [undefined, null], [null, null], [60, null], [0, null],
  ['none', 'standing'], [undefined, 'standing'], ['60 sec', '   '], ['  60 sec  ', '  standing  '],
];
function restFixtures() {
  return RESTS.map(([how, what], i) => {
    const ex = { name: 'Squat', sets: 3, reps: '10' };
    if (how !== undefined) ex.rest = how;
    if (what !== null) ex.rest_note = what;
    const m1 = { name: 'Row', reps: '10', circuit_id: 'c', circuit_rounds: 3 };
    const m2 = { name: 'Burpee', reps: '5', circuit_id: 'c', circuit_rounds: 3 };
    if (how !== undefined) m1.circuit_rest = how;
    if (what !== null) m1.circuit_rest_note = what;
    return { id: `rest#${i} how=${JSON.stringify(how)} what=${JSON.stringify(what)}`, how, what,
      day: day([sess('R', [{ block_name: 'MAIN', exercises: [ex, m1, m2] }])]) };
  });
}

const st = structure();
fs.writeFileSync(dir + '/structure.json', JSON.stringify(st));
fs.writeFileSync(dir + '/structure-rest.json', JSON.stringify(withRests(st)));
fs.writeFileSync(dir + '/rest.json', JSON.stringify(restFixtures()));
