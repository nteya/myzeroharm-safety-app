// screens/AuthScreen.js
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Alert,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

const colors = {
  bg: '#0B0F14',
  surface: '#131A22',
  text: '#E7EEF5',
  muted: '#A7B4C2',
  primary: '#00C853',
  border: '#1E2530',
};
const spacing = (n = 1) => 8 * n;

export default function AuthScreen({ navigation }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);

  const onContinue = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return Alert.alert(
        'Name required',
        'Please enter your name or nickname. It can be anonymous if you prefer.'
      );
    }

    try {
      setBusy(true);

      await AsyncStorage.setItem('profileName', trimmedName);
      await AsyncStorage.setItem('profileRole', role.trim());

      // After saving, go to Home and prevent going back to this screen
      navigation.reset({
        index: 0,
        routes: [{ name: 'Home' }],
      });
    } catch (e) {
      Alert.alert(
        'Setup failed',
        'We could not save your profile locally. Please try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView
        contentContainerStyle={{
          padding: spacing(2),
          paddingTop: spacing(2),
          paddingBottom: spacing(4),
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.appTitle}>MyZeroHarm</Text>
        <Text style={styles.subtitle}>
          Quick setup — this will appear on your reports.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Name or Nickname</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            editable={!busy}
            placeholder="e.g., Thabo, Shift C Welder, Anonymous"
            placeholderTextColor={colors.muted}
            style={styles.input}
            returnKeyType="done"
          />

          <Text style={styles.label}>Role / Department (optional)</Text>
          <TextInput
            value={role}
            onChangeText={setRole}
            editable={!busy}
            placeholder="e.g., SHE Rep, Operator, Contractor"
            placeholderTextColor={colors.muted}
            style={styles.input}
            returnKeyType="done"
          />

          <Text style={styles.helper}>
            You don’t have to use your real name. Everything you submit will be
            linked to this name on the reports.
          </Text>

          <TouchableOpacity
            onPress={onContinue}
            disabled={busy}
            activeOpacity={0.85}
            style={[styles.submitBtn, busy && { opacity: 0.6 }]}
          >
            <Text style={styles.submitText}>
              {busy ? 'Saving...' : 'Continue'}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footerNote}>
          Your details are stored locally on this device so you can keep
          reporting, even when there is no network.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  appTitle: { color: colors.text, fontSize: 22, fontWeight: '900' },
  subtitle: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
    marginBottom: spacing(1),
  },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(1.5),
    marginTop: spacing(2),
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    marginTop: spacing(1),
    marginBottom: spacing(0.5),
  },
  input: {
    backgroundColor: '#0F151C',
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: spacing(1.25),
    borderRadius: 10,
  },
  helper: {
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing(1),
  },
  submitBtn: {
    marginTop: spacing(2),
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitText: { color: '#06130A', fontWeight: '900' },
  footerNote: {
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing(2),
  },
});
