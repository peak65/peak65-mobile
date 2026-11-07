# render-check

Renders the real screen components at HEAD (or any ref) and in the working tree,
and compares what they print. It is the check that a display change moved only
what it meant to move.

```sh
scripts/render-check/run.sh          # HEAD vs working tree
scripts/render-check/run.sh <ref>    # <ref> vs working tree
```

It exits 0 and ends `RENDER CHECK: CLEAN` when all five checks pass. Otherwise it
exits non-zero and ends `RENDER CHECK: FAILED`. The full output lands in a temp
directory, and the last lines print its path.

## What it renders

The actual components, not copies of them:

- `app/(main)/program.tsx` `SessionDocument`, the Program tab
- `app/(main)/coach-athlete.tsx` `SessionDetail`, the coach view

For the day fixtures only (a day's own title and note, `lib/dayText.ts` and
`components/DayText.tsx`), it also renders:

- `program.tsx` `DayIntro`, the section under a Program tab day header
- `home.tsx` `TodayDayText` and `RestDayCard`, the pieces Home's today card uses
- `coach-athlete.tsx` `weekListLabel` and `overviewLabel`, the coach view's one-line
  day labels, and `SessionDetail` again for the coach day detail

`run.sh` snapshots `app/`, `lib/` and `components/` from the ref with
`git archive` and from the working tree with `cp`, and renders both the same way.
`harness.cjs` compiles each tree with sucrase and loads it in Node. React Native
host components (`View`, `Text`) become plain named elements, and `StyleSheet`
styles become their names. It prints every element with its style and every
`Text` with its full content, JSON-quoted so whitespace shows.

Every `Text` is printed, every exercise name included. The run fails
(`MISSING NAME …`) if any exercise that isn't a rest row has no name line on
either screen. A missing name has already gone unnoticed for two builds, so
this check is not optional.

## The five checks

1. **Structure, no rest fields** (`structure.json`): must be byte-identical
   between the ref and the working tree. It covers ladders, drop sets (after reps
   and after a duration), For Time, circuits, time-capped circuits, EMOMs,
   AMRAPs, supersets, every kind of Part, rest rows, a lone circuit member,
   cardio with distance, zone, pace and load, unnamed blocks, and three sessions
   for the session labels.
2. **The same structure with a rest on every exercise** (`structure-rest.json`):
   identical unless the build changes how rest prints. If it does, the differing
   lines are listed, and each one should be a rest change and nothing else.
3. **Nothing throws** in the working tree. Throws at the ref are counted for
   comparison.
4. **Rest text matches the web**: for every case in `gen.cjs` `RESTS`,
   `check-rest.cjs` compares the exercise line and the circuit line on both
   screens with the web's own `src/lib/rest.ts`, compiled from the web repo.
   The web repo is `$PEAK65_WEB`, default `~/Documents/peak65`.

5. **Day title and note match the expectations** (`day.json`): `check-day.cjs`
   compares each day piece, line for line, with the result written by hand in
   `gen.cjs` `dayFixtures()`. It covers no fields, title only, note only, both,
   a multi-paragraph note, non-string and blank values, and rest, race and
   training days. The coach `SessionDetail` is also compared with the ref: with
   the day text block taken out, it must match what the ref printed, so a day
   without title or note renders identically.

## Files

- `run.sh`: snapshots, runs everything, reports.
- `gen.cjs <outDir>`: writes the four fixture files.
- `harness.cjs <root> <fixtures.json>`: renders one tree.
- `check-rest.cjs <outDir>`: check 4.
- `check-day.cjs <outDir>`: check 5.

## Keeping it honest

- **Only listed modules are real.** The screens and the libs they render through
  (`exerciseNotes`, `programGrouping`, `roundReps`, `sessionOrder`, `dayText`,
  `components/DayText`, `theme`) are listed
  in `REAL` in `harness.cjs`. Every other import is a stub. If a screen starts
  rendering through a new lib, add the lib to `REAL`. Otherwise both trees render
  the same stub and compare equal. The stubbed project files print first on
  every run, so check that list when a build touches a new lib.
- **Add fixtures with the feature.** When a build adds a new kind of
  prescription, add it to `structure()` in `gen.cjs` in the same commit.
- **Home is not rendered, and neither is the Program tab's `DayCard`.** Both live
  inside screens built on hooks. Only the module-level pieces they call are
  rendered (`TodayDayText`, `RestDayCard`, `DayIntro`). The choices around them
  (which card Home shows, whether a day header opens, whether it starts open)
  are not checked here. When a build touches those, check them on a device.
