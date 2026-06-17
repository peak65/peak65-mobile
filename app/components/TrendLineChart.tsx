import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  LayoutChangeEvent,
  GestureResponderEvent,
} from 'react-native';
import Svg, { Polyline, Polygon, Circle, Line, Text as SvgText } from 'react-native-svg';

// ─── Local style constants (match coach-athlete.tsx) ───────────────────────────
const GREY       = '#8a877f';
const OFF_WHITE  = '#f0ede8';
const TOOLTIP_BG = '#1a1a1a';

export type TrendPoint = { date: string; value: number | null };

type Props = {
  data: TrendPoint[];          // 30 days, ascending; values may be null
  color: string;               // line + fill + dot color
  unit: string;                // e.g. ' ms', ' bpm', ' h'
  label: string;               // e.g. 'HRV' (used in latest readout)
  height?: number;             // default 120
  formatValue?: (v: number) => string; // default rounds to integer
};

// Drawing padding inside the SVG canvas.
const PAD_L = 30; // left gutter for min/max scale labels
const PAD_R = 12;
const PAD_T = 16;
const PAD_B = 18; // room for the date row of the selected point

// 'YYYY-MM-DD' → integer day number (for date-faithful x spacing, so gaps widen).
function dayNum(dateStr: string): number {
  return Math.round(new Date(`${dateStr}T00:00:00`).getTime() / 86_400_000);
}

function fmtTooltipDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export default function TrendLineChart({
  data,
  color,
  unit,
  label,
  height = 120,
  formatValue,
}: Props) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null); // index into `valid`

  const fmt = formatValue ?? ((v: number) => String(Math.round(v)));

  // Gap-tolerant: only points with a real numeric value are drawn.
  const valid = useMemo(
    () => data.filter(d => d.value != null && Number.isFinite(d.value)) as { date: string; value: number }[],
    [data],
  );

  const geometry = useMemo(() => {
    if (width <= 0 || valid.length < 2) return null;

    const values = valid.map(v => v.value);
    let yMin = Math.min(...values);
    let yMax = Math.max(...values);
    if (yMin === yMax) {
      // Flat line — center it with an arbitrary band so it doesn't hug an edge.
      yMin -= 1;
      yMax += 1;
    } else {
      const pad = (yMax - yMin) * 0.12;
      yMin -= pad;
      yMax += pad;
    }

    const days = valid.map(v => dayNum(v.date));
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const daySpan = lastDay - firstDay || 1;

    const plotLeft = PAD_L;
    const plotRight = width - PAD_R;
    const plotW = Math.max(1, plotRight - plotLeft);
    const plotTop = PAD_T;
    const plotBottom = height - PAD_B;
    const plotH = Math.max(1, plotBottom - plotTop);

    const pts = valid.map((v, i) => {
      const xFrac = (days[i] - firstDay) / daySpan;
      const yFrac = (v.value - yMin) / (yMax - yMin);
      return {
        x: plotLeft + xFrac * plotW,
        y: plotBottom - yFrac * plotH,
        value: v.value,
        date: v.date,
      };
    });

    return { pts, yMin, yMax, plotBottom, rawMin: Math.min(...values), rawMax: Math.max(...values) };
  }, [width, valid, height]);

  function onLayout(e: LayoutChangeEvent) {
    setWidth(e.nativeEvent.layout.width);
  }

  // Tap anywhere → select nearest point by x. Tapping the same point clears it.
  function handleTouch(e: GestureResponderEvent) {
    if (!geometry) return;
    const x = e.nativeEvent.locationX;
    let nearest = 0;
    let best = Infinity;
    geometry.pts.forEach((p, i) => {
      const d = Math.abs(p.x - x);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setSelected(prev => (prev === nearest ? null : nearest));
  }

  const latest = valid.length > 0 ? valid[valid.length - 1].value : null;

  // ── Not enough data ───────────────────────────────────────────────────────
  if (valid.length < 2) {
    return (
      <View style={[styles.emptyWrap, { height }]} onLayout={onLayout}>
        <Text style={styles.emptyText}>Not enough data yet</Text>
      </View>
    );
  }

  const polyPoints = geometry ? geometry.pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') : '';
  const areaPoints = geometry
    ? `${polyPoints} ${geometry.pts[geometry.pts.length - 1].x.toFixed(1)},${geometry.plotBottom.toFixed(1)} ${geometry.pts[0].x.toFixed(1)},${geometry.plotBottom.toFixed(1)}`
    : '';

  const sel = selected != null && geometry ? geometry.pts[selected] : null;

  return (
    <View
      style={{ height }}
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onResponderGrant={handleTouch}
      onResponderMove={handleTouch}
    >
      {/* Latest value readout (visible without tapping) */}
      {latest != null && (
        <View style={styles.latestWrap} pointerEvents="none">
          <Text style={[styles.latestValue, { color }]}>{fmt(latest)}<Text style={styles.latestUnit}>{unit}</Text></Text>
        </View>
      )}

      {geometry && width > 0 && (
        <Svg width={width} height={height}>
          {/* Min / max scale labels */}
          <SvgText x={4} y={PAD_T + 4} fontSize={9} fill={GREY} textAnchor="start">
            {fmt(geometry.rawMax)}
          </SvgText>
          <SvgText x={4} y={geometry.plotBottom + 4} fontSize={9} fill={GREY} textAnchor="start">
            {fmt(geometry.rawMin)}
          </SvgText>

          {/* Area fill under the line */}
          <Polygon points={areaPoints} fill={`${color}1F`} stroke="none" />

          {/* The trend line */}
          <Polyline points={polyPoints} fill="none" stroke={color} strokeWidth={2} />

          {/* Selected vertical guide */}
          {sel && (
            <Line x1={sel.x} y1={PAD_T} x2={sel.x} y2={geometry.plotBottom} stroke={GREY} strokeWidth={1} strokeDasharray="3,3" />
          )}

          {/* Dots */}
          {geometry.pts.map((p, i) => (
            <Circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={selected === i ? 4.5 : 2.5}
              fill={color}
              stroke={selected === i ? OFF_WHITE : 'none'}
              strokeWidth={selected === i ? 1.5 : 0}
            />
          ))}
        </Svg>
      )}

      {/* Tooltip for the selected point */}
      {sel && (
        <View
          style={[
            styles.tooltip,
            { left: Math.min(Math.max(sel.x - 55, 2), Math.max(2, width - 112)) },
          ]}
          pointerEvents="none"
        >
          <Text style={styles.tooltipText}>
            {fmtTooltipDate(sel.date)} · {fmt(sel.value)}{unit}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: GREY,
    fontSize: 13,
  },
  latestWrap: {
    position: 'absolute',
    top: 0,
    right: 4,
    zIndex: 2,
  },
  latestValue: {
    fontSize: 20,
    fontWeight: '700',
  },
  latestUnit: {
    fontSize: 12,
    fontWeight: '600',
    color: GREY,
  },
  tooltip: {
    position: 'absolute',
    top: 0,
    backgroundColor: TOOLTIP_BG,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minWidth: 96,
    zIndex: 3,
  },
  tooltipText: {
    color: OFF_WHITE,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
});
