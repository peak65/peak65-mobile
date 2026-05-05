// Mifflin-St Jeor BMR calculation
export function calculateBMR(params: {
  weightKg: number;
  heightCm: number;
  age: number;
  sex: 'male' | 'female';
}): number {
  const { weightKg, heightCm, age, sex } = params;
  const base = (10 * weightKg) + (6.25 * heightCm) - (5 * age);
  return sex === 'male' ? base + 5 : base - 161;
}

// Activity multiplier based on training days per week.
// Lower than typical Harris-Benedict multipliers because we add wearable active
// calories on top — this covers only BMR + NEAT (non-exercise movement).
export function getActivityMultiplier(trainingDaysPerWeek: number): number {
  if (trainingDaysPerWeek <= 1) return 1.2;
  if (trainingDaysPerWeek <= 3) return 1.25;
  if (trainingDaysPerWeek <= 5) return 1.3;
  return 1.35;
}

// BMR × activity multiplier — excludes workout active calories (added from wearable).
export function calculateTDEEBase(params: {
  weightKg: number;
  heightCm: number;
  age: number;
  sex: 'male' | 'female';
  trainingDaysPerWeek: number;
}): number {
  const bmr = calculateBMR(params);
  const multiplier = getActivityMultiplier(params.trainingDaysPerWeek);
  return Math.round(bmr * multiplier);
}

// Generic profile shape accepted by computeTDEEFromProfile.
// Covers both new columns (height_cm/weight_kg) and legacy text fields.
export type TDEEProfile = {
  weight_kg?: number | null;
  weight?: string | null;
  units?: string | null;
  preferred_units?: string | null;
  body_weight?: number | null;
  weight_unit?: string | null;
  height_cm?: number | null;
  height?: string | null;
  age?: number | null;
  gender?: string | null;
  current_training_days?: string | null;
  rest_days?: number | null;
};

export type TDEEResult =
  | { ok: true; value: number }
  | { ok: false; missing: string[] };

export function computeTDEEFromProfile(p: TDEEProfile): TDEEResult {
  const missing: string[] = [];

  let weightKg: number | null = p.weight_kg ?? null;
  if (weightKg == null && p.weight && !isNaN(parseFloat(p.weight))) {
    const w = parseFloat(p.weight);
    const units = p.preferred_units ?? p.units;
    weightKg = units === 'metric' ? w : w * 0.453592;
  }
  if (weightKg == null && p.body_weight != null) {
    weightKg = p.weight_unit === 'lbs' ? p.body_weight * 0.453592 : p.body_weight;
  }
  if (weightKg == null) missing.push('weight');

  let heightCm: number | null = p.height_cm ?? null;
  if (heightCm == null && p.height) {
    const units = p.preferred_units ?? p.units;
    if (units === 'metric' || !units) {
      heightCm = parseFloat(p.height) || null;
    } else {
      const match = p.height.match(/^(\d+)'(\d+)"?$/);
      if (match) heightCm = parseInt(match[1], 10) * 30.48 + parseInt(match[2], 10) * 2.54;
    }
  }
  if (heightCm == null) missing.push('height');

  if (!p.age) missing.push('age');

  const genderLower = p.gender?.toLowerCase();
  const sex = genderLower === 'male' || genderLower === 'female' ? genderLower : null;
  if (!sex) missing.push('sex');

  let trainingDaysPerWeek: number | null = null;
  if (p.current_training_days != null) {
    const n = parseInt(p.current_training_days, 10);
    if (!isNaN(n)) trainingDaysPerWeek = n;
  }
  if (trainingDaysPerWeek == null && p.rest_days != null) {
    trainingDaysPerWeek = Math.max(0, 7 - p.rest_days);
  }
  if (trainingDaysPerWeek == null) missing.push('training_days');

  if (missing.length > 0) {
    console.log('[tdee] computeTDEEFromProfile missing:', missing);
    return { ok: false, missing };
  }

  return {
    ok: true,
    value: calculateTDEEBase({
      weightKg: weightKg!,
      heightCm: heightCm!,
      age: p.age!,
      sex: sex!,
      trainingDaysPerWeek: trainingDaysPerWeek!,
    }),
  };
}
