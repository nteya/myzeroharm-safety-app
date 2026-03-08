// screens/ProfileScreen.js
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TextInput,
  ScrollView,
  Alert,
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadProfile, saveProfile, clearLegacyProfileKeys } from '../storage';

const colors = {
  bg: '#0B0F14',
  surface: '#131A22',
  text: '#E7EEF5',
  muted: '#A7B4C2',
  primary: '#00C853',
  border: '#1E2530',
};

const spacing = (n = 1) => 8 * n;

function initialsFromName(name = '') {
  const i = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => (s[0] || '').toUpperCase())
    .join('');
  return i || '•';
}

function friendlyError(err, context = 'Action') {
  const code = err && err.code ? String(err.code) : '';
  if (code === 'auth/network-request-failed' || code === 'unavailable') {
    return "You're offline or the service is busy. Please try again.";
  }
  if (code === 'deadline-exceeded') return 'The request timed out. Please try again.';
  if (code === 'permission-denied') return "You don't have permission for that action.";
  if (code === 'resource-exhausted' || code === 'quota-exceeded')
    return 'Usage limit reached temporarily. Try again later.';
  return `${context} failed. Please try again.`;
}

// ✅ Only these roles are allowed to SHOW role/designation on HomeScreen posts
const DESIGNATION_ROLES = ['Supervisor', 'Safety Officer', 'SHE Rep'];

export default function ProfileScreen() {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');

  // ✅ designation opt-in
  const [hasDesignation, setHasDesignation] = useState(false);
  const [designation, setDesignation] = useState('');

  const [expandDesignation, setExpandDesignation] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(true);

  // ✅ “Saved” / “Edit” mode
  const [isEditing, setIsEditing] = useState(true);
  const [saving, setSaving] = useState(false);

  // enable LayoutAnimation on Android
  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  const toggleDesignation = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandDesignation((v) => !v);
  }, []);

  // ✅ Load local profile first, then server
  useEffect(() => {
    (async () => {
      try {
        await clearLegacyProfileKeys();

        const [
          localName,
          localCompany,
          localHasDesignation,
          localDesignation,
        ] = await Promise.all([
          AsyncStorage.getItem('profileName'),
          AsyncStorage.getItem('profileCompany'),
          AsyncStorage.getItem('profileHasDesignation'),
          AsyncStorage.getItem('profileDesignation'),
        ]);

        const localHas = localHasDesignation === '1';

        if (localName) setName(localName);
        if (localCompany) setCompany(localCompany);

        if (localHas) {
          setHasDesignation(true);
          setExpandDesignation(true);
          if (localDesignation) setDesignation(localDesignation);
        }

        // edit mode depends on name
        if (localName && localName.trim()) setIsEditing(false);
        else setIsEditing(true);

        // then server
        const p = await loadProfile({ preferServer: true, purgeLegacy: false }).catch(() => null);
        if (p) {
          if (!localName && p.name) setName(p.name || '');
          if (!localCompany && p.company) setCompany(p.company || '');

          // designation (only if local not already set)
          if (!localHasDesignation) {
            const serverHas = !!p.hasDesignation;
            if (serverHas) {
              setHasDesignation(true);
              setDesignation(p.role || p.designation || '');
              setExpandDesignation(true);
            }
          }

          if (!localName && (p.name || '').trim()) setIsEditing(false);
        }
      } finally {
        setLoadingProfile(false);
      }
    })();
  }, []);

  const onSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return Alert.alert('Name required', 'Please enter a name or nickname.');
    }

    const trimmedCompany = company.trim();
    const trimmedDesignation = designation.trim();

    // ✅ If they opted-in, they MUST choose one of the 3 roles
    if (hasDesignation) {
      if (!DESIGNATION_ROLES.includes(trimmedDesignation)) {
        return Alert.alert('Designation required', 'Please choose Supervisor, SHE Rep, or Safety Officer.');
      }
    }

    try {
      setSaving(true);

      // ✅ Save to profile storage (server/local inside storage.js)
      // HomeScreen will use: profile.name + profile.company + profile.role
      await saveProfile({
        name: trimmedName,
        company: trimmedCompany,
        // ✅ keep field names simple and compatible with HomeScreen
        role: hasDesignation ? trimmedDesignation : '',
        hasDesignation: !!hasDesignation,
      });

      // ✅ Persist locally
      await AsyncStorage.setItem('profileName', trimmedName);

      if (trimmedCompany) await AsyncStorage.setItem('profileCompany', trimmedCompany);
      else await AsyncStorage.removeItem('profileCompany');

      if (hasDesignation) {
        await AsyncStorage.setItem('profileHasDesignation', '1');
        await AsyncStorage.setItem('profileDesignation', trimmedDesignation);
      } else {
        await AsyncStorage.removeItem('profileHasDesignation');
        await AsyncStorage.removeItem('profileDesignation');
      }

      setIsEditing(false);
      Alert.alert('Saved', hasDesignation ? 'Profile updated. Your designation will show on your posts.' : 'Profile updated.');
    } catch (e) {
      Alert.alert('Save error', friendlyError(e, 'Save'));
    } finally {
      setSaving(false);
    }
  };

  const onEdit = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsEditing(true);
  };

  const designationSelected = (val) => designation === val;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={{
          padding: spacing(2),
          paddingBottom: spacing(4),
        }}
        keyboardShouldPersistTaps="always"
      >
        {/* Avatar */}
        <View style={styles.avatarRow}>
          <View style={styles.avatarCircle}>
            {loadingProfile ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.avatarInitials}>{initialsFromName(name)}</Text>
            )}
          </View>
          <View style={{ marginLeft: spacing(1.5), flex: 1 }}>
            <Text style={styles.headerText}>Your Profile</Text>
            <Text style={styles.subtleText}>
              Your name and company will show next to your hazards and posts.
            </Text>
          </View>
        </View>

        {/* Basic fields */}
        <View style={{ marginTop: spacing(2) }}>
          <Text style={styles.label}>Name / Nickname</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g., Ntsika Nteya"
            placeholderTextColor={colors.muted}
            style={[styles.input, !isEditing && styles.inputDisabled]}
            editable={isEditing}
          />

          <Text style={styles.label}>Company</Text>
          <TextInput
            value={company}
            onChangeText={setCompany}
            placeholder="e.g., SKP / Sishen"
            placeholderTextColor={colors.muted}
            style={[styles.input, !isEditing && styles.inputDisabled]}
            editable={isEditing}
          />
        </View>

        {/* ✅ Designation (optional, but required if they say yes) */}
        <View style={[styles.card, { marginTop: spacing(2) }]}>
          <TouchableOpacity onPress={toggleDesignation} activeOpacity={0.8} style={styles.cardHeaderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Do you have a designation?</Text>
              <Text style={styles.cardSub}>Supervisors, SHE Reps and Safety Officers can show their role on posts.</Text>
            </View>
            <Text style={styles.chev}>{expandDesignation ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {expandDesignation ? (
            <View style={{ marginTop: spacing(1) }}>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Show my designation</Text>

                <TouchableOpacity
                  onPress={() => {
                    if (!isEditing) return;
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setHasDesignation((v) => {
                      const next = !v;
                      if (!next) setDesignation('');
                      return next;
                    });
                  }}
                  activeOpacity={0.85}
                  style={[
                    styles.togglePill,
                    hasDesignation && { borderColor: colors.primary, backgroundColor: 'rgba(0,200,83,0.12)' },
                    !isEditing && { opacity: 0.55 },
                  ]}
                >
                  <Text style={[styles.togglePillText, hasDesignation && { color: colors.primary }]}>
                    {hasDesignation ? 'ON' : 'OFF'}
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.noteText}>
                If ON, you must choose one designation below so it can appear on your posts in the Home feed.
              </Text>

              <Text style={styles.label}>Designation {hasDesignation ? '(required)' : '(optional)'}</Text>
              <View style={styles.roleRow}>
                {DESIGNATION_ROLES.map((r) => {
                  const selected = designationSelected(r);
                  const disabled = !hasDesignation || !isEditing;
                  return (
                    <TouchableOpacity
                      key={r}
                      onPress={() => {
                        if (disabled) return;
                        setDesignation(selected ? '' : r);
                      }}
                      activeOpacity={0.85}
                      style={[
                        styles.rolePill,
                        selected && { borderColor: colors.primary, backgroundColor: 'rgba(0,200,83,0.10)' },
                        disabled && { opacity: 0.5 },
                      ]}
                    >
                      <Text style={[styles.rolePillText, selected && { color: colors.primary }]}>{r}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.previewBox}>
                <Text style={styles.previewTitle}>Post preview</Text>
                <Text style={styles.previewText}>
                  {name.trim() || 'Your Name'}
                  {'\n'}
                  {hasDesignation && designation
                    ? `${designation}${company.trim() ? ` • ${company.trim()}` : ''}`
                    : `${company.trim() || 'Company (optional)'}`}
                </Text>
              </View>
            </View>
          ) : null}
        </View>

        {/* ✅ Save / Edit button */}
        {isEditing ? (
          <TouchableOpacity
            style={[styles.saveBtn, saving && { opacity: 0.75 }]}
            onPress={saving ? undefined : onSave}
            activeOpacity={0.7}
            hitSlop={12}
            disabled={loadingProfile || saving}
          >
            <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.editBtn}
            onPress={onEdit}
            activeOpacity={0.7}
            hitSlop={12}
          >
            <Text style={styles.editBtnText}>Edit Profile</Text>
          </TouchableOpacity>
        )}

        {!isEditing ? (
          <Text style={styles.footerHint}>
            Your profile is saved. Tap “Edit Profile” if you want to change your details.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing(1.5),
    borderRadius: 12,
  },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F151C',
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatarInitials: { color: '#fff', fontWeight: '900', fontSize: 22 },

  headerText: { color: colors.text, fontWeight: '800', fontSize: 16 },
  subtleText: { color: colors.muted, fontSize: 12, marginTop: 6, lineHeight: 16 },

  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    marginTop: spacing(1.5),
    marginBottom: spacing(0.5),
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: spacing(1.25),
    borderRadius: 10,
  },
  inputDisabled: {
    opacity: 0.65,
  },

  // card
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(1.5),
  },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: colors.text, fontWeight: '900', fontSize: 14 },
  cardSub: { color: colors.muted, fontSize: 12, marginTop: 6, lineHeight: 16 },
  chev: { color: colors.muted, fontWeight: '900', marginLeft: 10 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  toggleLabel: { color: colors.text, fontWeight: '800' },
  togglePill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#0F151C',
  },
  togglePillText: { color: colors.text, fontWeight: '900' },

  noteText: { color: colors.muted, fontSize: 12, marginTop: 10, lineHeight: 16 },

  roleRow: { flexDirection: 'row', gap: 10, marginTop: 6, flexWrap: 'wrap' },
  rolePill: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#0F151C',
  },
  rolePillText: { color: colors.text, fontWeight: '900', fontSize: 13 },

  previewBox: {
    marginTop: spacing(1.5),
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#0F151C',
    borderRadius: 12,
    padding: spacing(1.25),
  },
  previewTitle: { color: colors.text, fontWeight: '900', marginBottom: 6 },
  previewText: { color: colors.muted, fontWeight: '800', lineHeight: 18, fontSize: 12 },

  saveBtn: {
    marginTop: spacing(2),
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveBtnText: { color: '#06130A', fontWeight: '900' },

  editBtn: {
    marginTop: spacing(2),
    backgroundColor: '#0F151C',
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  editBtnText: { color: colors.text, fontWeight: '900' },

  footerHint: {
    marginTop: 10,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
  },
});


