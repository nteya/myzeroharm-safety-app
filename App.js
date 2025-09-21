// App.js
import React, { useEffect, useState } from 'react';
import { StatusBar, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { onAuthStateChanged } from 'firebase/auth';

import HomeScreen from './screens/HomeScreen';
import ComposePostScreen from './screens/ComposePostScreen';
import ProfileScreen from './screens/ProfileScreen';
import TaskSafetyScreen from './screens/TaskSafetyScreen';
import ReportHazardScreen from './screens/ReportHazardScreen';
import AuthScreen from './screens/AuthScreen';
import AssessmentScreen from './screens/AssessmentScreen'; // ⬅️ NEW

import { auth } from './firebase';

const Stack = createNativeStackNavigator();
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
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u || null);
      setReady(true);
    });
    return () => unsub();
  }, []);

  if (!ready) {
    // Minimal dark placeholder while checking auth
    return <View style={{ flex: 1, backgroundColor: BG }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: BG }}>
      <NavigationContainer theme={theme}>
        <StatusBar barStyle="light-content" backgroundColor={BG} />
        <Stack.Navigator
          initialRouteName={user ? 'Home' : 'Auth'}
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: BG },
            animation: 'fade',
            statusBarStyle: 'light',
            statusBarColor: BG,
          }}
        >
          {!user ? (
            <Stack.Screen name="Auth" component={AuthScreen} />
          ) : (
            <>
              <Stack.Screen name="Home" component={HomeScreen} />

              <Stack.Screen
                name="ComposePost"
                component={ComposePostScreen}
                options={{
                  headerShown: true,
                  title: 'New Post',
                  headerStyle: { backgroundColor: BG },
                  headerTintColor: TEXT,
                  headerShadowVisible: false,
                  contentStyle: { backgroundColor: BG },
                }}
              />

              <Stack.Screen
                name="Profile"
                component={ProfileScreen}
                options={{
                  headerShown: true,
                  title: 'Profile',
                  headerStyle: { backgroundColor: BG },
                  headerTintColor: TEXT,
                  headerShadowVisible: false,
                  contentStyle: { backgroundColor: BG },
                }}
              />

              <Stack.Screen
                name="TaskSafety"
                component={TaskSafetyScreen}
                options={{
                  headerShown: true,
                  title: 'Task Safety',
                  headerStyle: { backgroundColor: BG },
                  headerTintColor: TEXT,
                  headerShadowVisible: false,
                  contentStyle: { backgroundColor: BG },
                }}
              />

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

              {/* NEW: Weekly Assessment */}
              <Stack.Screen
                name="Assessment"
                component={AssessmentScreen}
                options={{
                  headerShown: true,
                  title: 'Weekly Assessment',
                  headerStyle: { backgroundColor: BG },
                  headerTintColor: TEXT,
                  headerShadowVisible: false,
                  contentStyle: { backgroundColor: BG },
                }}
              />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}
