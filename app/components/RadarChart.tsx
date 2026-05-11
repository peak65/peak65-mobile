import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Svg, { Polygon, Line, Text as SvgText, Circle, G } from 'react-native-svg';

const STATIONS = [
  'ski_erg', 'sled_push', 'sled_pull', 'burpee_broad_jumps',
  'row_erg', 'farmers_carry', 'sandbag_lunges', 'wall_balls',
] as const;

const LABELS = [
  'Ski Erg', 'Sled Push', 'Sled Pull', 'Burpees',
  'Row Erg', 'Farmers Carry', 'Sandbag Lunges', 'Wall Balls',
];

export type StationKey = typeof STATIONS[number];
export type StationValues = Partial<Record<StationKey, number>>;

type Props = {
  size?: number;
  day1: StationValues;
  raceDay?: StationValues;
  day1Color?: string;
  raceDayColor?: string;
};

function getAngle(i: number, n = 8) {
  return (-Math.PI / 2) + (i * 2 * Math.PI / n);
}

function getPoint(cx: number, cy: number, r: number, value: number, i: number): string {
  const angle = getAngle(i);
  const x = cx + r * value * Math.cos(angle);
  const y = cy + r * value * Math.sin(angle);
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}

function polygonPoints(cx: number, cy: number, r: number, values: number[]): string {
  return values.map((v, i) => getPoint(cx, cy, r, v, i)).join(' ');
}

function labelPosition(cx: number, cy: number, r: number, i: number): { x: number; y: number } {
  const angle = getAngle(i);
  const dist = r + 52;
  return { x: cx + dist * Math.cos(angle), y: cy + dist * Math.sin(angle) };
}

function labelAnchor(i: number): 'start' | 'middle' | 'end' {
  const angle = getAngle(i);
  const cos = Math.cos(angle);
  if (cos > 0.3) return 'start';
  if (cos < -0.3) return 'end';
  return 'middle';
}

function toValues(sv: StationValues): number[] {
  return STATIONS.map(s => Math.max(0.05, Math.min(1, sv[s] ?? 0.5)));
}

export default function RadarChart({ size = 320, day1, raceDay, day1Color = '#ff8c00', raceDayColor = '#e8ff47' }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.28;

  const day1Values = toValues(day1);
  const raceDayValues = raceDay ? toValues(raceDay) : null;

  const gridLevels = [0.25, 0.5, 0.75, 1];

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {/* Grid rings */}
        {gridLevels.map(level => (
          <Polygon
            key={level}
            points={polygonPoints(cx, cy, r, Array(8).fill(level))}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
        ))}

        {/* Axis lines */}
        {STATIONS.map((_, i) => {
          const angle = getAngle(i);
          const x2 = cx + r * Math.cos(angle);
          const y2 = cy + r * Math.sin(angle);
          return (
            <Line
              key={i}
              x1={cx}
              y1={cy}
              x2={x2}
              y2={y2}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={1}
            />
          );
        })}

        {/* Race Day projection (drawn first so Day 1 overlays it) */}
        {raceDayValues && (
          <Polygon
            points={polygonPoints(cx, cy, r, raceDayValues)}
            fill={`${raceDayColor}26`}
            stroke={raceDayColor}
            strokeWidth={2}
          />
        )}

        {/* Day 1 shape (orange) */}
        <Polygon
          points={polygonPoints(cx, cy, r, day1Values)}
          fill={`${day1Color}40`}
          stroke={day1Color}
          strokeWidth={2.5}
        />

        {/* Day 1 dots */}
        {day1Values.map((v, i) => {
          const angle = getAngle(i);
          const x = cx + r * v * Math.cos(angle);
          const y = cy + r * v * Math.sin(angle);
          return <Circle key={i} cx={x} cy={y} r={3.5} fill={day1Color} />;
        })}

        {/* Axis labels */}
        {LABELS.map((label, i) => {
          const pos = labelPosition(cx, cy, r, i);
          const anchor = labelAnchor(i);
          return (
            <SvgText
              key={i}
              x={pos.x}
              y={pos.y + 3}
              textAnchor={anchor}
              fontSize={9}
              fill="rgba(240,237,232,0.7)"
              fontWeight="500"
            >
              {label}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}
