import { NativeModules } from 'react-native';

const { LiveActivityModule } = NativeModules;

export async function startLiveActivity(sessionName: string, state: LiveActivityState): Promise<string | null> {
  if (!LiveActivityModule) return null;
  try {
    return await LiveActivityModule.startActivity(sessionName, state);
  } catch (e) {
    console.log('[LiveActivity] startActivity error:', e);
    return null;
  }
}

export async function updateLiveActivity(state: LiveActivityState): Promise<void> {
  if (!LiveActivityModule) return;
  try {
    await LiveActivityModule.updateActivity(state);
  } catch (e) {
    console.log('[LiveActivity] updateActivity error:', e);
  }
}

export async function endLiveActivity(): Promise<void> {
  if (!LiveActivityModule) return;
  try {
    await LiveActivityModule.endActivity();
  } catch (e) {
    console.log('[LiveActivity] endActivity error:', e);
  }
}

export interface LiveActivityState {
  exerciseName: string;
  targetDisplay: string;
  remainingSecs: number;
  nextExerciseName: string;
  nextTargetDisplay: string;
  elapsedSecs: number;
  stationIndex: number;
  totalStations: number;
  currentPace: string;
  isRest: boolean;
  timerEndDate?: number;
}
