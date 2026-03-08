// App.js
import React, { useEffect, useState } from 'react';
import { StatusBar, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Screens
import HomeScreen from './screens/HomeScreen';
import ComposePostScreen from './screens/ComposePostScreen';
import ProfileScreen from './screens/ProfileScreen';
import TaskSafetyScreen from './screens/TaskSafetyScreen';
import ReportHazardScreen from './screens/ReportHazardScreen';
import AssessmentScreen from './screens/AssessmentScreen';

// ✅ Existing NEW screen
import CreateAssessmentScreen from './screens/CreateAssessmentScreen';

// ✅ NEW: SKP Hub + Matrix screens
import SkpAdminHubScreen from './screens/SkpAdminHubScreen';
import SkpMatrixScreen from './screens/SkpMatrixScreen';

// ✅ NEW: Submitted Assessments (admin marking + best team)
import SubmittedAssessmentsScreen from './screens/SubmittedAssessmentsScreen';

// Local profile helper (no login – just alias / company)
import { loadProfile } from './storage';

const Stack = createNativeStackNavigator();

// Theme colours (keeping your existing dark theme setup)
const BG = '#0B0F14';
const TEXT = '#E7EEF5';
const PRIMARY = '#00C853';
const BORDER = '#1E2530';

const theme = {
  ...DarkTheme,
  dark: true,
  colors: {
    ...DarkTheme.colors,
    background: BG,
    card: BG,
    text: TEXT,
    border: BORDER,
    primary: PRIMARY,
    notification: PRIMARY,
  },
};

export default function App() {
  const [initialRoute, setInitialRoute] = useState('Home');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        // We prefer local profile so it works offline from day one
        const p = await loadProfile({ preferServer: false }).catch(() => null);
        const name = (p?.fullName || p?.name || '').trim();

        if (!isMounted) return;

        // If user has never set a name/alias, send them to Profile first
        if (!name) {
          setInitialRoute('Profile');
        } else {
          setInitialRoute('Home');
        }
      } catch {
        if (isMounted) setInitialRoute('Home');
      } finally {
        if (isMounted) setReady(true);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  // Simple splash while we decide where to start
  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: BG }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: BG }}>
      <NavigationContainer theme={theme}>
        {/* Default status bar (dark screens like Home) */}
        <StatusBar barStyle="light-content" backgroundColor={BG} />

        <Stack.Navigator
          initialRouteName={initialRoute}
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: BG },
            animation: 'fade',
            statusBarStyle: 'light',
            statusBarColor: BG,
          }}
        >
          {/* Main feed */}
          <Stack.Screen name="Home" component={HomeScreen} />

          {/* Create a post (your blue header inside screen, so keep header hidden) */}
          <Stack.Screen
            name="ComposePost"
            component={ComposePostScreen}
            options={{
              headerShown: false,
              contentStyle: { backgroundColor: '#F7F4F6' }, // match your new white/pink background
            }}
          />

          {/* ✅ NEW: SKP Admin Hub */}
          <Stack.Screen
            name="SkpAdminHub"
            component={SkpAdminHubScreen}
            options={{
              headerShown: false,
              contentStyle: { backgroundColor: '#F7F4F6' },
            }}
          />

          {/* ✅ NEW: Submitted Assessments (Admin marking + best team) */}
          <Stack.Screen
            name="SubmittedAssessments"
            component={SubmittedAssessmentsScreen}
            options={{
              headerShown: false,
              contentStyle: { backgroundColor: '#F7F4F6' },
            }}
          />

          {/* ✅ NEW: SKP Matrix / Stats */}
          <Stack.Screen
            name="SkpMatrix"
            component={SkpMatrixScreen}
            options={{
              headerShown: false,
              contentStyle: { backgroundColor: '#F7F4F6' },
            }}
          />

          {/* ✅ Existing: SKP creates an assessment here */}
          <Stack.Screen
            name="CreateAssessment"
            component={CreateAssessmentScreen}
            options={{
              headerShown: false, // blue header is inside the screen
              contentStyle: { backgroundColor: '#F7F4F6' },
            }}
          />

          {/* Profile = where they choose/change their name/alias & company */}
          <Stack.Screen
            name="Profile"
            component={ProfileScreen}
            options={{
              headerShown: true,
              title: 'Profile / Alias',
              headerStyle: { backgroundColor: BG },
              headerTintColor: TEXT,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: BG },
            }}
          />

          {/* ✅ Task safety checklist (CUSTOM BLUE HEADER INSIDE SCREEN) */}
          <Stack.Screen
            name="TaskSafety"
            component={TaskSafetyScreen}
            options={{
              headerShown: false,
              contentStyle: { backgroundColor: '#F7F4F6' },
            }}
          />

          {/* Hazard reporting */}
          <Stack.Screen
            name="ReportHazard"
            component={ReportHazardScreen}
            options={{
              headerShown: true,
              title: 'Report Hazard',
              headerStyle: { backgroundColor: BG },
              headerTintColor: TEXT,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: BG },
            }}
          />

          {/* Assessment answering screen */}
          <Stack.Screen
            name="Assessment"
            component={AssessmentScreen}
            options={{
              headerShown: false,
              contentStyle: { backgroundColor: '#F7F4F6' },
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}




