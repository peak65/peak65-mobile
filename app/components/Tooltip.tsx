import React, { useState, useEffect, useRef, ReactNode } from 'react';
import { View, Text, TouchableOpacity, Animated } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

type ArrowDirection = 'up' | 'down' | 'left' | 'right';

type Props = {
  id: string;
  text: string;
  arrowDirection?: ArrowDirection;
  children: ReactNode;
  visible?: boolean;
};

const BG = '#111111';

export default function Tooltip({ id, text, arrowDirection = 'down', children, visible: visibleProp }: Props) {
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visibleProp !== undefined) {
      setVisible(visibleProp);
      if (visibleProp) {
        Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
      } else {
        opacity.setValue(0);
      }
      return;
    }
    AsyncStorage.getItem(`peak65_tooltip_${id}`).then(val => {
      if (!val) {
        setVisible(true);
        Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
      }
    }).catch(() => {});
  }, [id, visibleProp]);

  function dismiss() {
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setVisible(false));
    AsyncStorage.setItem(`peak65_tooltip_${id}`, 'true').catch(() => {});
  }

  function getBubblePosition(): object {
    const base: object = { position: 'absolute', width: 260, zIndex: 9999 };
    switch (arrowDirection) {
      case 'down':  return { ...base, bottom: '100%', alignSelf: 'center', left: 0, right: 0 };
      case 'up':    return { ...base, top: '100%', alignSelf: 'center', left: 0, right: 0 };
      case 'left':  return { ...base, right: '100%', top: 0 };
      case 'right': return { ...base, left: '100%', top: 0 };
      default:      return { ...base, bottom: '100%', alignSelf: 'center', left: 0, right: 0 };
    }
  }

  const ArrowUp    = () => <View style={{ width: 0, height: 0, alignSelf: 'center', borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 6, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: BG }} />;
  const ArrowDown  = () => <View style={{ width: 0, height: 0, alignSelf: 'center', borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 6,    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: BG }} />;
  const ArrowLeft  = () => <View style={{ width: 0, height: 0, alignSelf: 'center', borderTopWidth: 5, borderBottomWidth: 5, borderRightWidth: 6,   borderTopColor: 'transparent', borderBottomColor: 'transparent', borderRightColor: BG }} />;
  const ArrowRight = () => <View style={{ width: 0, height: 0, alignSelf: 'center', borderTopWidth: 5, borderBottomWidth: 5, borderLeftWidth: 6,    borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: BG }} />;

  return (
    <View style={{ position: 'relative', overflow: 'visible' }}>
      {children}
      {visible && (
        <Animated.View style={[getBubblePosition(), { opacity }]}>
          {arrowDirection === 'up'    && <ArrowUp />}
          {arrowDirection === 'left'  && <ArrowLeft />}
          <View style={{
            backgroundColor: BG,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: 'rgba(232,255,71,0.4)',
            padding: 16,
            shadowColor: '#e8ff47',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.1,
            shadowRadius: 12,
            elevation: 8,
          }}>
            <Text style={{ color: '#f0ede8', fontSize: 14, lineHeight: 20 }}>{text}</Text>
            <TouchableOpacity onPress={dismiss} style={{ alignSelf: 'flex-end', marginTop: 12 }}>
              <Text style={{ color: '#e8ff47', fontWeight: '700', textDecorationLine: 'underline' }}>Got it</Text>
            </TouchableOpacity>
          </View>
          {arrowDirection === 'down'  && <ArrowDown />}
          {arrowDirection === 'right' && <ArrowRight />}
        </Animated.View>
      )}
    </View>
  );
}
