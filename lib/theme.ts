export const Colors = {
  background:    '#080808',
  card:          '#111111',
  nested:        '#1a1a1a',
  border:        'rgba(255,255,255,0.08)',
  textPrimary:   '#f0ede8',
  textSecondary: '#8a877f',
  accent:        '#e8ff47',
  green:         '#00d4aa',
  yellow:        '#e8ff47',
  red:           '#ff3b3b',
} as const;

export const Fonts = {
  metric:      'BarlowCondensed_700Bold',
  metricHeavy: 'BarlowCondensed_900Black',
} as const;

export function scoreColor(score: number): string {
  if (score >= 70) return Colors.green;
  if (score >= 40) return Colors.yellow;
  return Colors.red;
}
