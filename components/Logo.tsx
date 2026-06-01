import React from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';

export function Logo({ width = 120, style }: { width?: number; style?: StyleProp<ImageStyle> }) {
  // Intrinsic asset dimensions: 1266 × 650 → aspectRatio 1.95.
  // height is left undefined so it scales proportionally from width via aspectRatio.
  return (
    <Image
      source={require('../assets/peak65-logo.png')}
      style={[{ width, height: undefined, aspectRatio: 1.95, resizeMode: 'contain' }, style]}
    />
  );
}
