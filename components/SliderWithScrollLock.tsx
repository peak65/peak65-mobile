import React from 'react';
import SliderInput from './SliderInput';

type Props = {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onScrollLockChange?: (locked: boolean) => void;
};

// Wraps SliderInput and notifies the parent when dragging starts/ends so the
// parent ScrollView can disable scrolling during a slide gesture.
export default function SliderWithScrollLock({ value, min, max, onChange, onScrollLockChange }: Props) {
  return (
    <SliderInput
      value={value}
      min={min}
      max={max}
      onChange={onChange}
      onSlidingStart={() => onScrollLockChange?.(true)}
      onSlidingComplete={() => onScrollLockChange?.(false)}
    />
  );
}
