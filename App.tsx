import { enableScreens } from 'react-native-screens';
import RootLayout from './app/_layout';

// Enable native screen optimisation for React Navigation
enableScreens();

export default function App() {
  return <RootLayout />;
}
