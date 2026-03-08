// screens/ComposePostScreen.js
import React, { useRef, useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Image,
  ScrollView,
  Alert,
  Keyboard,
  ActivityIndicator,
  Pressable,
  Modal,
  StatusBar,
  Switch,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { useNavigation, useRoute } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { loadProfile } from '../storage';
import { db, auth, storage } from '../firebase';
import {
  collection,
  addDoc,
  serverTimestamp,
  query,
  where,
  getDocs,
  updateDoc,
  doc,
} from 'firebase/firestore';
import { ref as sRef, uploadBytes, getDownloadURL } from 'firebase/storage';

const SKP_BLUE = '#003A8F';
const HEADER_BAR_HEIGHT = 64;
const ADMIN_PIN = '200730';

const colors = {
  bg: '#F7F4F6',
  surface: '#FFFFFF',
  text: '#0F172A',
  muted: '#64748B',
  border: '#E6E1E7',
  primary: '#00C853',
  danger: '#DC2626',
  warning: '#F59E0B',
};

const spacing = (n = 1) => 8 * n;
const radius = 16;

const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// 🔖 15 preset safety/health captions
const PRESET_CAPTIONS = [
  'Look out for moving equipment',
  'Hydrate and take regular breaks',
  'Keep walkways clear — housekeeping matters',
  'Use the right PPE for the job',
  'Lock out / tag out before maintenance',
  'Three points of contact on ladders',
  'Set and respect exclusion zones',
  'Shield sparks and keep a fire watch',
  'Test atmosphere before confined space entry',
  'Spot the line-of-fire and step out',
  'Report near-misses — learn and improve',
  'Pre-start checks save injuries',
  'Slow down — no shortcut is worth it',
  'See something unsafe? Speak up',
  'Eyes on path, hands free',
];

/* ---------- Friendly error mapping (no vendor wording) ---------- */
function friendlyError(err, context = 'Action') {
  const code = err?.code ? String(err.code) : '';
  const msg = err?.message ? String(err.message).toLowerCase() : '';

  if (code.includes('network') || msg.includes('network'))
    return "You're offline or the service is busy. Please try again.";
  if (code.includes('unavailable')) return 'The service is temporarily unavailable. Please try again.';
  if (code.includes('deadline') || msg.includes('timeout')) return 'The request timed out. Please try again.';
  if (code.includes('permission') || code.includes('unauthorized'))
    return "You don't have permission for that action.";
  if (code.includes('quota') || code.includes('exceeded') || code.includes('resource-exhausted'))
    return 'Temporary usage limit reached. Try again later.';
  return `${context} failed. Please try again.`;
}
/* --------------------------------------------------------------- */

// ✅ Normalize any profile shape into what we need (name + company + role/designation)
async function getNormalizedProfile() {
  const p = (await loadProfile({ preferServer: true })) || {};
  const name = (p.fullName || p.name || '').trim();
  const company = (p.company || '').trim();

  // IMPORTANT: this is your “designation” saved in profile
  // Depending on your ProfileScreen version, it might be stored as p.role or p.designation.
  const role = (p.role || p.designation || '').trim();

  return { name, company, role };
}

export default function ComposePostScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const insets = useSafeAreaInsets();

  // ✅ Reuse this screen for campaigns via route param:
  // navigation.navigate('ComposePost', { mode: 'campaign' })
  const mode = route?.params?.mode || 'normal';
  const isCampaign = mode === 'campaign';

  const [desc, setDesc] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [imageUri, setImageUri] = useState('');
  const [audioUri, setAudioUri] = useState('');
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  // Campaign-only extras
  const [campaignTitle, setCampaignTitle] = useState('');
  const [pinCampaign, setPinCampaign] = useState(true);

  // SKP PIN modal (for SKP button)
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pin, setPin] = useState('');

  const recordingRef = useRef(null);

  const headerTotalHeight = HEADER_BAR_HEIGHT + insets.top;

  const onBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Home');
  };

  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {});
    return () => sub.remove();
  }, []);

  useEffect(
    () => () => {
      (async () => {
        try {
          if (isRecording && recordingRef.current) {
            await recordingRef.current.stopAndUnloadAsync();
          }
        } catch {}
        try {
          await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
        } catch {}
      })();
    },
    [isRecording]
  );

  const pickImage = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') return Alert.alert('Permission needed', 'Media library access is required.');
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
      });
      if (!res.canceled) setImageUri(res.assets[0].uri);
    } catch (e) {
      Alert.alert('Image error', friendlyError(e, 'Image selection'));
    }
  };

  const takePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') return Alert.alert('Permission needed', 'Camera access is required.');
      const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
      if (!res.canceled) setImageUri(res.assets[0].uri);
    } catch (e) {
      Alert.alert('Camera error', friendlyError(e, 'Camera'));
    }
  };

  const startRecording = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') return Alert.alert('Permission needed', 'Microphone access is required.');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
    } catch (e) {
      Alert.alert('Recording error', friendlyError(e, 'Recording'));
    }
  };

  const stopRecording = async () => {
    try {
      const rec = recordingRef.current;
      if (!rec) return;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI() || '';
      setAudioUri(uri);
      setIsRecording(false);
      recordingRef.current = null;

      // derive duration for display
      if (uri) {
        try {
          const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
          const st = await sound.getStatusAsync();
          const dur =
            st?.durationMillis && Number.isFinite(st.durationMillis) ? st.durationMillis : 0;
          setAudioDurationMs(dur || 0);
          await sound.unloadAsync();
        } catch {}
      }
    } catch (e) {
      Alert.alert('Stop error', friendlyError(e, 'Stop recording'));
    } finally {
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      } catch {}
    }
  };

  async function uploadIfAny(localUri, pathPrefix) {
    if (!localUri) return '';
    try {
      const resp = await fetch(localUri);
      const blob = await resp.blob();
      const ext = (blob.type || '').includes('audio') ? 'm4a' : 'jpg';
      const path = `${pathPrefix}/${generateId()}.${ext}`;
      const ref = sRef(storage, path);
      await uploadBytes(ref, blob, {
        contentType: blob.type || (ext === 'm4a' ? 'audio/mp4' : 'image/jpeg'),
      });
      return await getDownloadURL(ref);
    } catch {
      return '';
    }
  }

  const mustHaveCaption = !!imageUri || !!audioUri;
  const effectiveCaption = (desc.trim() || '').length ? desc.trim() : selectedPreset || '';

  const onTogglePreset = (cap) => {
    setSelectedPreset((prev) => (prev === cap ? '' : cap));
  };

  // ---- SKP button behavior (MAIN FOCUS) ----
  const openPinModal = () => {
    setPin('');
    setPinModalVisible(true);
  };

  const confirmPinAndGo = () => {
    if (pin.trim() !== ADMIN_PIN) {
      return Alert.alert('Wrong PIN', 'Only SKP admins can access this section.');
    }
    setPinModalVisible(false);
    navigation.navigate('SkpAdminHub');
  };
  // -----------------------------------------

  // ✅ ONLY ONE CAMPAIGN AT A TIME:
  // If publishing a pinned campaign, first unpin any existing pinned campaign(s).
  async function unpinExistingPinnedCampaigns() {
    const qy = query(
      collection(db, 'posts'),
      where('type', '==', 'campaign'),
      where('pinned', '==', true)
    );

    const snap = await getDocs(qy);
    if (snap.empty) return;

    await Promise.all(
      snap.docs.map((d) => updateDoc(doc(db, 'posts', d.id), { pinned: false }))
    );
  }

  const postNow = async () => {
    // Normal posts validation (unchanged logic)
    if (!isCampaign) {
      if (mustHaveCaption && !effectiveCaption) {
        return Alert.alert(
          'Caption required',
          'Please type a caption or pick one of the safety captions for your photo/voice note.'
        );
      }
      if (!mustHaveCaption && !effectiveCaption) {
        return Alert.alert('Empty post', 'Please add a description, photo, or voice note.');
      }
    } else {
      const hasSomething = !!(effectiveCaption || imageUri || audioUri || (campaignTitle || '').trim());
      if (!hasSomething) {
        return Alert.alert('Campaign is empty', 'Please add a title, message, photo, or voice note.');
      }
    }

    try {
      setBusy(true);

      const prof = await getNormalizedProfile();
      const uidUser = auth.currentUser?.uid || null;

      const [imageUrl, audioUrl] = await Promise.all([
        uploadIfAny(imageUri, `posts/${uidUser || 'anon'}/images`),
        uploadIfAny(audioUri, `posts/${uidUser || 'anon'}/audio`),
      ]);

      if (isCampaign && pinCampaign) {
        await unpinExistingPinnedCampaigns();
      }

      const finalCampaignTitle = (campaignTitle || '').trim() || 'Campaign of the Week';

      // ✅ THIS IS THE FIX: include prof.role on normal posts
      const payload = {
        id: generateId(),
        uid: uidUser,

        authorName: isCampaign ? 'SKP' : prof.name || 'Anonymous',

        // ✅ campaigns keep SKP role; normal posts store user designation
        role: isCampaign ? 'skp' : (prof.role || ''),

        company: prof.company || '',
        avatar: '',

        type: isCampaign ? 'campaign' : 'normal',
        pinned: isCampaign ? !!pinCampaign : false,
        title: isCampaign ? finalCampaignTitle : '',

        text: isCampaign ? (effectiveCaption || '') : effectiveCaption,
        imageUrl: imageUrl || '',
        audioUrl: audioUrl || '',
        audioDurationMs: audioDurationMs || null,

        thanks: 0,
        createdAt: serverTimestamp(),
      };

      await addDoc(collection(db, 'posts'), payload);

      if (navigation.canGoBack()) navigation.goBack();
      else navigation.navigate('Home');

      // reset
      setDesc('');
      setSelectedPreset('');
      setImageUri('');
      setAudioUri('');
      setAudioDurationMs(0);
      setCampaignTitle('');
      setPinCampaign(true);
    } catch (e) {
      Alert.alert('Post error', friendlyError(e, 'Post'));
    } finally {
      setBusy(false);
    }
  };

  const isEmptyText = useMemo(() => !(desc.trim().length || selectedPreset.length), [desc, selectedPreset]);

  return (
    <SafeAreaView style={styles.root} edges={['left', 'right', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />

      {/* Header */}
      <View style={[styles.stickyHeader, { paddingTop: insets.top, height: headerTotalHeight }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>SKP-ZeroHarm</Text>
          <Text style={styles.headerSub}>{isCampaign ? 'Create Campaign' : 'Create Post'}</Text>
        </View>

        {/* ✅ SKP button stays here (PIN → HUB) */}
        {!isCampaign && (
          <Pressable onPress={openPinModal} hitSlop={12} style={styles.skpBtn}>
            <Text style={styles.skpBtnText}>SKP</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing(2),
          paddingBottom: spacing(4),
          paddingTop: headerTotalHeight + spacing(2),
        }}
        keyboardShouldPersistTaps="always"
      >
        <View style={styles.card}>
          {/* ✅ Campaign options (only if mode=campaign) */}
          {isCampaign && (
            <View style={styles.campaignBox}>
              <Text style={styles.campaignLabel}>Campaign Title</Text>
              <TextInput
                placeholder="e.g. Housekeeping Focus Week"
                placeholderTextColor={colors.muted}
                value={campaignTitle}
                onChangeText={setCampaignTitle}
                editable={!busy}
                style={[styles.inputSingle, busy && { opacity: 0.8 }]}
              />

              <View style={styles.pinRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pinTitle}>Pin this campaign</Text>
                  <Text style={styles.pinSub}>
                    Only one campaign can be pinned at a time (new one replaces the old).
                  </Text>
                </View>
                <Switch value={pinCampaign} onValueChange={setPinCampaign} disabled={busy} />
              </View>
            </View>
          )}

          <TextInput
            placeholder={
              mustHaveCaption
                ? 'Add a caption (required for media)…'
                : isCampaign
                ? 'Add a campaign message (optional)…'
                : 'Share an update…'
            }
            placeholderTextColor={colors.muted}
            value={desc}
            onChangeText={setDesc}
            editable={!busy}
            multiline
            style={styles.input}
          />

          {/* Preset caption chips */}
          <Text style={styles.captionHeader}>Quick safety captions</Text>
          <View style={styles.chipsWrap}>
            {PRESET_CAPTIONS.map((cap) => {
              const on = selectedPreset === cap && !desc.trim();
              return (
                <TouchableOpacity
                  key={cap}
                  style={[styles.chip, on && styles.chipOn, busy && { opacity: 0.6 }]}
                  onPress={busy ? undefined : () => onTogglePreset(cap)}
                  activeOpacity={0.8}
                  disabled={busy}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{cap}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {!!imageUri && <Image source={{ uri: imageUri }} style={styles.previewImage} resizeMode="cover" />}

          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.iconBtn, busy && { opacity: 0.6 }]}
              onPress={busy ? undefined : takePhoto}
              activeOpacity={0.7}
              hitSlop={12}
              disabled={busy}
            >
              <Text style={styles.iconText}>📷</Text>
            </TouchableOpacity>

            <View style={{ width: spacing(0.5) }} />

            <TouchableOpacity
              style={[styles.iconBtn, busy && { opacity: 0.6 }]}
              onPress={busy ? undefined : pickImage}
              activeOpacity={0.7}
              hitSlop={12}
              disabled={busy}
            >
              <Text style={styles.iconText}>🖼️</Text>
            </TouchableOpacity>

            <View style={{ width: spacing(0.5) }} />

            <TouchableOpacity
              style={[
                styles.iconBtn,
                isRecording ? { backgroundColor: colors.danger, borderColor: 'rgba(0,0,0,0.12)' } : null,
                busy && { opacity: 0.6 },
              ]}
              onPress={busy ? undefined : isRecording ? stopRecording : startRecording}
              activeOpacity={0.7}
              hitSlop={12}
              disabled={busy}
            >
              <Text style={styles.iconText}>{isRecording ? '⏹️' : '🎙️'}</Text>
            </TouchableOpacity>
          </View>

          {!!audioUri && (
            <View style={styles.audioBadge}>
              <Text style={styles.audioBadgeText}>
                Voice note attached{audioDurationMs ? ` • ${Math.round(audioDurationMs / 1000)}s` : ''}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[
              styles.postBtn,
              ((isEmptyText && (imageUri || audioUri) && !isCampaign) || busy) && { opacity: 0.6 },
            ]}
            onPress={busy ? undefined : postNow}
            activeOpacity={0.7}
            hitSlop={12}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#06130A" />
            ) : (
              <Text style={styles.postBtnText}>{isCampaign ? 'Publish Campaign' : 'Post'}</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* ✅ PIN modal for SKP */}
      <Modal visible={pinModalVisible} transparent animationType="fade" onRequestClose={() => setPinModalVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPinModalVisible(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>SKP Admin</Text>
            <Text style={styles.modalText}>Enter PIN to access SKP tools.</Text>

            <TextInput
              value={pin}
              onChangeText={setPin}
              placeholder="Enter PIN"
              placeholderTextColor={colors.muted}
              style={[styles.input, { minHeight: 48 }]}
              secureTextEntry
              keyboardType="number-pad"
            />

            <View style={{ flexDirection: 'row', gap: 10, marginTop: spacing(1) }}>
              <Pressable style={styles.modalBtnSecondary} onPress={() => setPinModalVisible(false)}>
                <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalBtnPrimary} onPress={confirmPinAndGo}>
                <Text style={styles.modalBtnPrimaryText}>Continue</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  // Header
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: SKP_BLUE,
    paddingHorizontal: spacing(2),
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.18)',
    zIndex: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing(1.25),
  },
  backText: { color: '#fff', fontSize: 18, fontWeight: '900' },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '900', lineHeight: 24 },
  headerSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 2, fontWeight: '800' },

  skpBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  skpBtnText: { color: '#fff', fontWeight: '900', fontSize: 12, letterSpacing: 0.6 },

  // Card
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    padding: spacing(1.5),
  },

  // Campaign box
  campaignBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.25),
    marginBottom: spacing(1.25),
    backgroundColor: '#FFFFFF',
  },
  campaignLabel: { color: colors.muted, fontWeight: '900', fontSize: 12, marginBottom: 6 },
  inputSingle: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: colors.text,
    fontWeight: '800',
    backgroundColor: '#FFFFFF',
  },
  pinRow: {
    marginTop: spacing(1),
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pinTitle: { color: colors.text, fontWeight: '900' },
  pinSub: { color: colors.muted, fontWeight: '700', fontSize: 12, marginTop: 2 },

  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: spacing(1.5),
    borderRadius: 12,
    minHeight: 120,
    textAlignVertical: 'top',
    fontWeight: '700',
  },

  captionHeader: {
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing(1),
    marginBottom: spacing(0.5),
    fontWeight: '900',
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing(1),
    paddingVertical: spacing(0.5),
    marginBottom: spacing(1),
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
  },
  chipOn: {
    backgroundColor: colors.primary,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  chipText: { color: colors.muted, fontWeight: '800', fontSize: 12 },
  chipTextOn: { color: '#06130A' },

  previewImage: {
    width: '100%',
    height: 240,
    marginTop: spacing(1),
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },

  actionsRow: {
    flexDirection: 'row',
    marginTop: spacing(1),
    alignItems: 'center',
  },
  iconBtn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  iconText: { color: colors.text, fontSize: 16 },

  audioBadge: {
    marginTop: spacing(1),
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  audioBadgeText: { color: colors.muted, fontSize: 12, fontWeight: '800' },

  postBtn: {
    marginTop: spacing(2),
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  postBtnText: { color: '#06130A', fontWeight: '900' },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: spacing(2),
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    padding: spacing(2),
  },
  modalTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },
  modalText: { color: colors.muted, fontWeight: '700', marginTop: 6, marginBottom: spacing(1) },

  modalBtnSecondary: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  modalBtnSecondaryText: { color: colors.text, fontWeight: '900' },

  modalBtnPrimary: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    backgroundColor: colors.primary,
  },
  modalBtnPrimaryText: { color: '#06130A', fontWeight: '900' },
});
