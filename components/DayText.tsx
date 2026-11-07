import React from 'react';
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { dayTitle, dayNoteParagraphs, showsRaceDayLine, RACE_DAY_LINE, type DayTextSource } from '../lib/dayText';

// A day's title and note, or nothing. Every screen that shows them renders this, with
// its own existing styles: the title in the screen's session-name style, each note
// paragraph as its own Text in the screen's description style, so that style's own
// margin is the gap between paragraphs. Presence is decided in lib/dayText.ts alone.
export type DayTextStyles = {
  /** Wraps the title and note; rendered only when there is something to show. */
  container?: StyleProp<ViewStyle>;
  /** Wraps the title alone, as a session's name is wrapped in its header row. */
  titleWrap?: StyleProp<ViewStyle>;
  title: StyleProp<TextStyle>;
  note: StyleProp<TextStyle>;
  /** Added to the last paragraph only, e.g. to drop a margin the container already gives. */
  lastNote?: StyleProp<TextStyle>;
  /** Given: a race day with no sessions, title or note shows "Race day" in this style. */
  raceLine?: StyleProp<TextStyle>;
  /** Wraps the "Race day" line; defaults to `container`. */
  raceContainer?: StyleProp<ViewStyle>;
};

export default function DayText({ day, styles }: { day: DayTextSource | null | undefined; styles: DayTextStyles }) {
  const title = dayTitle(day);
  const paragraphs = dayNoteParagraphs(day);

  if (title == null && paragraphs.length === 0) {
    if (styles.raceLine == null || !showsRaceDayLine(day)) return null;
    const line = <Text style={styles.raceLine}>{RACE_DAY_LINE}</Text>;
    const wrap = styles.raceContainer ?? styles.container;
    return wrap == null ? line : <View style={wrap}>{line}</View>;
  }

  const titleEl = title == null ? null
    : styles.titleWrap == null ? <Text style={styles.title}>{title}</Text>
    : <View style={styles.titleWrap}><Text style={styles.title}>{title}</Text></View>;
  const notes = paragraphs.map((p, i) => (
    <Text key={i} style={i === paragraphs.length - 1 && styles.lastNote != null ? [styles.note, styles.lastNote] : styles.note}>{p}</Text>
  ));

  if (styles.container == null) return <>{titleEl}{notes}</>;
  return <View style={styles.container}>{titleEl}{notes}</View>;
}
