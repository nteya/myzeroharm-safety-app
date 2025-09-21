// screens/ComposePostScreen.js
import React, { useRef, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, Image, ScrollView, Alert, Keyboard, ActivityIndicator,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { loadProfile } from '../storage';
import { db, auth, storage } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { ref as sRef, uploadBytes, getDownloadURL } from 'firebase/storage';

const colors = { bg:'#0B0F14', surface:'#131A22', text:'#E7EEF5', muted:'#A7B4C2', primary:'#00C853', border:'#1E2530' };
const spacing = (n=1)=>8*n;

const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;

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

// Normalize any profile shape into what we need
async function getNormalizedProfile() {
  const p = (await loadProfile({ preferServer: true })) || {};
  const name = (p.fullName || p.name || '').trim();
  const role = (p.role || p.designation || '').trim();
  const company = (p.company || '').trim();
  const avatar = p.avatar || p.avatarUri || p.photoURL || p.photo || '';
  return { name, role, company, avatar };
}

export default function ComposePostScreen(){
  const navigation = useNavigation();

  const [desc, setDesc] = useState('');
  const [selectedPreset, setSelectedPreset] = useState(''); // new
  const [imageUri, setImageUri] = useState('');
  const [audioUri, setAudioUri] = useState('');
  const [audioDurationMs, setAudioDurationMs] = useState(0); // new
  const [isRecording, setIsRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const recordingRef = useRef(null);

  useEffect(()=>{ const sub=Keyboard.addListener('keyboardDidHide',()=>{}); return ()=>sub.remove(); },[]);
  useEffect(()=>()=>{(async()=>{ try{ if(isRecording&&recordingRef.current){await recordingRef.current.stopAndUnloadAsync();}}catch{} try{await Audio.setAudioModeAsync({allowsRecordingIOS:false});}catch{} })();},[isRecording]);

  const pickImage = async ()=>{
    try{
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if(status!=='granted') return Alert.alert('Permission needed','Media library access is required.');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality:0.85 });
      if(!res.canceled) setImageUri(res.assets[0].uri);
    }catch(e){ Alert.alert('Image error', String(e?.message || e)); }
  };

  const takePhoto = async ()=>{
    try{
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if(status!=='granted') return Alert.alert('Permission needed','Camera access is required.');
      const res = await ImagePicker.launchCameraAsync({ quality:0.85 });
      if(!res.canceled) setImageUri(res.assets[0].uri);
    }catch(e){ Alert.alert('Camera error', String(e?.message || e)); }
  };

  const startRecording = async ()=>{
    try{
      const { status } = await Audio.requestPermissionsAsync();
      if(status!=='granted') return Alert.alert('Permission needed','Microphone access is required.');
      await Audio.setAudioModeAsync({ allowsRecordingIOS:true, playsInSilentModeIOS:true });
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
    }catch(e){ Alert.alert('Recording error', String(e?.message || e)); }
  };

  const stopRecording = async ()=>{
    try{
      const rec = recordingRef.current; if(!rec) return;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI() || '';
      setAudioUri(uri);
      setIsRecording(false);
      recordingRef.current = null;

      // 👉 derive duration for Home screen display
      if (uri) {
        try {
          const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false });
          const st = await sound.getStatusAsync();
          const dur = (st?.durationMillis && Number.isFinite(st.durationMillis)) ? st.durationMillis : 0;
          setAudioDurationMs(dur || 0);
          await sound.unloadAsync();
        } catch {}
      }
    }catch(e){
      Alert.alert('Stop error', String(e?.message || e));
    } finally {
      try { await Audio.setAudioModeAsync({ allowsRecordingIOS:false }); } catch {}
    }
  };

  async function uploadIfAny(localUri, pathPrefix) {
    if (!localUri) return '';
    try{
      const resp = await fetch(localUri);
      const blob = await resp.blob();
      const ext = (blob.type || '').includes('audio') ? 'm4a' : 'jpg';
      const path = `${pathPrefix}/${generateId()}.${ext}`;
      const ref = sRef(storage, path);
      await uploadBytes(ref, blob, { contentType: blob.type || (ext==='m4a' ? 'audio/mp4' : 'image/jpeg') });
      return await getDownloadURL(ref);
    }catch(e){
      console.log('Upload error', e?.message || e);
      // If upload fails, we still create a text-only post; media will be omitted
      return '';
    }
  }

  const mustHaveCaption = !!imageUri || !!audioUri;
  const effectiveCaption = (desc.trim() || '').length ? desc.trim() : (selectedPreset || '');

  const onTogglePreset = (cap) => {
    setSelectedPreset((prev) => (prev === cap ? '' : cap));
  };

  const postNow = async ()=>{
    // Enforce a caption if media exists
    if (mustHaveCaption && !effectiveCaption) {
      return Alert.alert(
        'Caption required',
        'Please type a caption or pick one of the safety captions for your photo/voice note.'
      );
    }
    // Also prevent empty “nothing at all” post
    if (!mustHaveCaption && !effectiveCaption) {
      return Alert.alert('Empty post','Please add a description, photo, or voice note.');
    }

    try {
      setBusy(true);

      const prof = await getNormalizedProfile();
      const uid = auth.currentUser?.uid || null;

      // Upload media first (if any)
      const [imageUrl, audioUrl] = await Promise.all([
        uploadIfAny(imageUri, `posts/${uid || 'anon'}/images`),
        uploadIfAny(audioUri, `posts/${uid || 'anon'}/audio`),
      ]);

      // Compose payload for Firestore
      const payload = {
        id: generateId(),
        uid,
        authorName: prof.name || 'You',
        role: prof.role || 'SHE Rep',
        company: prof.company || '',
        avatar: prof.avatar || '',
        text: effectiveCaption,          // use typed if present, else selected preset
        imageUrl: imageUrl || '',        // durable URLs only
        audioUrl: audioUrl || '',
        audioDurationMs: audioDurationMs || null, // for HomeScreen progress/time
        thanks: 0,
        createdAt: serverTimestamp(),
      };

      await addDoc(collection(db, 'posts'), payload);

      // Navigate back; HomeScreen onSnapshot will pick it up
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.navigate('Home');

      // Reset local state
      setDesc('');
      setSelectedPreset('');
      setImageUri('');
      setAudioUri('');
      setAudioDurationMs(0);
    } catch (e) {
      Alert.alert('Post error', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const isEmptyText = !(desc.trim().length || selectedPreset.length);

  return (
    <SafeAreaView style={styles.root} edges={['top','right','bottom','left']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(4) }}
        keyboardShouldPersistTaps="always"
      >
        <TextInput
          placeholder={mustHaveCaption ? 'Add a caption (required for media)…' : 'Share an update…'}
          placeholderTextColor={colors.muted}
          value={desc}
          onChangeText={setDesc}
          editable={!busy}
          multiline
          style={styles.input}
        />

        {/* Preset caption chips (shown always; but especially helpful when media is present) */}
        <Text style={styles.captionHeader}>Quick safety captions</Text>
        <View style={styles.chipsWrap}>
          {PRESET_CAPTIONS.map((cap) => {
            const on = selectedPreset === cap && !desc.trim(); // if user typed, typed > preset
            return (
              <TouchableOpacity
                key={cap}
                style={[styles.chip, on && styles.chipOn, busy && { opacity:0.6 }]}
                onPress={busy ? undefined : () => onTogglePreset(cap)}
                activeOpacity={0.8}
                disabled={busy}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  {cap}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {!!imageUri && (<Image source={{ uri:imageUri }} style={styles.previewImage} resizeMode="cover" />)}

        <View style={styles.actionsRow}>
          <TouchableOpacity style={[styles.iconBtn, busy && { opacity:0.6 }]} onPress={busy ? undefined : takePhoto} activeOpacity={0.7} hitSlop={12} disabled={busy}>
            <Text style={styles.iconText}>📷</Text>
          </TouchableOpacity>

          <View style={{ width: spacing(0.5) }} />

          <TouchableOpacity style={[styles.iconBtn, busy && { opacity:0.6 }]} onPress={busy ? undefined : pickImage} activeOpacity={0.7} hitSlop={12} disabled={busy}>
            <Text style={styles.iconText}>🖼️</Text>
          </TouchableOpacity>

          <View style={{ width: spacing(0.5) }} />

          <TouchableOpacity
            style={[styles.iconBtn, (isRecording ? { backgroundColor:'#E53935' } : null), busy && { opacity:0.6 }]}
            onPress={busy ? undefined : (isRecording ? stopRecording : startRecording)}
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
              Voice note attached{audioDurationMs ? ` • ${Math.round(audioDurationMs/1000)}s` : ''}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.postBtn, ((isEmptyText && (imageUri || audioUri)) || busy) && { opacity:0.6 }]}
          onPress={busy ? undefined : postNow}
          activeOpacity={0.7}
          hitSlop={12}
          disabled={busy}
        >
          {busy ? <ActivityIndicator color="#06130A" /> : <Text style={styles.postBtnText}>Post</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:{ flex:1, backgroundColor: colors.bg },
  input:{
    backgroundColor: colors.surface, borderWidth:1, borderColor: colors.border, color: colors.text,
    padding: spacing(1.5), borderRadius:12, minHeight:120, textAlignVertical:'top',
  },

  captionHeader:{ color: colors.muted, fontSize: 12, marginTop: spacing(1), marginBottom: spacing(0.5), fontWeight:'800' },
  chipsWrap:{
    flexDirection:'row', flexWrap:'wrap', gap: spacing(1),
    paddingVertical: spacing(0.5), marginBottom: spacing(1),
  },
  chip:{
    borderWidth:1, borderColor: colors.muted, paddingVertical:6, paddingHorizontal:10,
    borderRadius:999, backgroundColor:'transparent',
  },
  chipOn:{
    backgroundColor: colors.primary, borderColor:'rgba(0,0,0,0.25)',
  },
  chipText:{ color: colors.muted, fontWeight:'700', fontSize:12 },
  chipTextOn:{ color:'#06130A' },

  previewImage:{
    width:'100%', height:240, marginTop: spacing(1),
    borderRadius:12, borderWidth:1, borderColor: colors.border,
  },
  actionsRow:{ flexDirection:'row', marginTop: spacing(1), alignItems:'center' },
  iconBtn:{
    backgroundColor:'#0F151C', borderWidth:1, borderColor: colors.border,
    paddingVertical:10, paddingHorizontal:12, borderRadius:10,
  },
  iconText:{ color: colors.text, fontSize:16 },

  audioBadge:{
    marginTop: spacing(1), alignSelf:'flex-start',
    paddingVertical:6, paddingHorizontal:10, borderRadius:999,
    borderWidth:1, borderColor: colors.border, backgroundColor:'#0F1720',
  },
  audioBadgeText:{ color: colors.muted, fontSize:12, fontWeight:'700' },

  postBtn:{
    marginTop: spacing(2), backgroundColor: colors.primary,
    paddingVertical:12, borderRadius:12, alignItems:'center',
  },
  postBtnText:{ color:'#06130A', fontWeight:'900' },
});


