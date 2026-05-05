import React, { useRef } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';

const YELLOW = '#e8ff47';
const THUMB_RADIUS = 13;

type Props = {
  value: number;         // current integer value in display units
  min: number;
  max: number;
  onChange: (v: number) => void;
  onSlidingStart?: () => void;
  onSlidingComplete?: () => void;
};

// Pure-JS slider — no native modules required.
// Snaps to whole integers. Works in whatever unit system the parent passes.
export default function SliderInput({ value, min, max, onChange, onSlidingStart, onSlidingComplete }: Props) {
  const trackWidth = useRef(300);

  // Keep mutable refs so PanResponder closures always see current values.
  const onChangeRef          = useRef(onChange);
  const onSlidingStartRef    = useRef(onSlidingStart);
  const onSlidingCompleteRef = useRef(onSlidingComplete);
  const minRef               = useRef(min);
  const maxRef               = useRef(max);
  onChangeRef.current          = onChange;
  onSlidingStartRef.current    = onSlidingStart;
  onSlidingCompleteRef.current = onSlidingComplete;
  minRef.current               = min;
  maxRef.current               = max;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: (evt) => {
        onSlidingStartRef.current?.();
        fire(evt.nativeEvent.locationX);
      },
      onPanResponderMove:      (evt) => fire(evt.nativeEvent.locationX),
      onPanResponderRelease:   () => { onSlidingCompleteRef.current?.(); },
      onPanResponderTerminate: () => { onSlidingCompleteRef.current?.(); },
    }),
  ).current;

  function fire(x: number) {
    const ratio = Math.min(Math.max(x / trackWidth.current, 0), 1);
    const v = Math.round(minRef.current + ratio * (maxRef.current - minRef.current));
    onChangeRef.current(v);
  }

  const fillPct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

  return (
    <View
      style={styles.hitArea}
      onLayout={e => { trackWidth.current = e.nativeEvent.layout.width; }}
      {...panResponder.panHandlers}
    >
      {/* Track */}
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${fillPct}%` }]} />
      </View>
      {/* Thumb */}
      <View style={[styles.thumb, { left: `${fillPct}%`, marginLeft: -THUMB_RADIUS }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  hitArea: {
    width: '100%',
    height: 44,
    justifyContent: 'center',
  },
  track: {
    height: 5,
    backgroundColor: '#2a2a2a',
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: YELLOW,
    borderRadius: 3,
  },
  thumb: {
    position: 'absolute',
    width: THUMB_RADIUS * 2,
    height: THUMB_RADIUS * 2,
    borderRadius: THUMB_RADIUS,
    backgroundColor: YELLOW,
  },
});
