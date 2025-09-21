// screens/ProfileScreen.js
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TextInput, Image, ScrollView,
  Alert, ActivityIndicator, Linking
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useNavigation } from '@react-navigation/native';
import { loadProfile, saveProfile, clearLegacyProfileKeys } from '../storage';

// Firebase
import { auth, storage, db } from '../firebase';
import { ref as sRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';

const colors = { bg:'#0B0F14', surface:'#131A22', text:'#E7EEF5', muted:'#A7B4C2', primary:'#00C853', border:'#1E2530' };
const spacing = (n=1)=>8*n;

const isHttp = (u='') => /^https?:\/\//i.test(u);
const isFile = (u='') => /^file:\/\//i.test(u);

function initialsFromName(name='') {
  const i = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(s => (s[0] || '').toUpperCase())
    .join('');
  return i || '•';
}

async function uploadAvatarToStorage(localUri) {
  if (!localUri) return '';
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in — cannot upload avatar.');

  const ts = Date.now();
  const path = `profiles/${user.uid}/avatar_${ts}.jpg`;

  const resp = await fetch(localUri);
  const blob = await resp.blob();
  const contentType = blob.type || 'image/jpeg';

  const ref = sRef(storage, path);
  const task = uploadBytesResumable(ref, blob, { contentType });

  await new Promise((resolve, reject) => {
    task.on('state_changed', () => {}, reject, resolve);
  });

  return await getDownloadURL(ref);
}

/* --------- Weekly PDF helpers ---------- */

function weekLabel(date = new Date()) {
  // ISO week-style label (YYYY-WW)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const weekNo = Math.ceil((((d - start) / 86400000) + 1) / 7);
  return `${year}-${String(weekNo).padStart(2, '0')}`;
}
function last7Window() {
  const end = new Date(); // now
  const start = new Date(end.getTime() - 7*24*60*60*1000);
  return { start, end };
}
async function fetchWindow(collectionName, start, end) {
  // Firestore will convert JS Date to Timestamp in range queries
  const qy = query(
    collection(db, collectionName),
    where('createdAt', '>=', start),
    where('createdAt', '<', end),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(qy);
  return snap.docs.map(d => {
    const data = d.data() || {};
    const ms = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
    return { id: d.id, ...data, createdAtMs: ms };
  });
}
function htmlEscape(s=''){ return String(s).replace(/[&<>"']/g, (m)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function buildHtml({ week, posts, hazards }) {
  const postItem = (p) => `
    <div class="post">
      <div class="row">
        <div class="left"><strong>${htmlEscape(p.author||'Unknown')}</strong></div>
        <div class="right small">${new Date(p.createdAtMs).toLocaleString()}</div>
      </div>
      <div class="muted small">${htmlEscape(p.role || 'Role not specified')}${p.company ? ' • ' + htmlEscape(p.company) : ''}</div>
      ${p.text ? `<div class="body">${htmlEscape(p.text)}</div>` : ''}
      <div class="small muted">Thanks: ${p.thanks || 0}</div>
    </div>
  `;
  const hazardItem = (h) => `
    <div class="hz">
      <div class="row">
        <div class="left"><strong>${htmlEscape(h.title || 'Untitled')}</strong></div>
        <div class="right small">${new Date(h.createdAtMs).toLocaleString()}</div>
      </div>
      <div class="muted small">${[h.severity, h.type, h.category, h.locationText].filter(Boolean).map(htmlEscape).join(' • ')}</div>
      ${h.description ? `<div class="body">${htmlEscape(h.description)}</div>` : ''}
    </div>
  `;
  return `
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      body{ font-family: -apple-system, Segoe UI, Roboto, Arial; color:#111; padding:16px; }
      h1{ font-size: 20px; margin: 0 0 8px; }
      h2{ font-size: 16px; margin: 18px 0 8px; border-bottom:1px solid #ddd; padding-bottom:4px; }
      .muted{ color:#666; }
      .small{ font-size: 12px; }
      .row{ display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .post, .hz{ border:1px solid #eee; border-radius:8px; padding:10px; margin:8px 0; }
      .body{ margin-top:6px; white-space:pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Weekly Safety Report – ${week}</h1>
    <div class="small muted">Generated: ${new Date().toLocaleString()}</div>

    <h2>Posts (last 7 days)</h2>
    ${posts.map(postItem).join('') || '<div class="muted small">No posts.</div>'}

    <h2>Hazard Reports (last 7 days)</h2>
    ${hazards.map(hazardItem).join('') || '<div class="muted small">No hazards.</div>'}
  </body>
  </html>`;
}
async function generateAndUploadWeeklyPdf({ uid }) {
  const { start, end } = last7Window();
  const [posts, hazards] = await Promise.all([
    fetchWindow('posts', start, end),
    fetchWindow('hazards', start, end),
  ]);

  const week = weekLabel(end);
  const html = buildHtml({ week, posts, hazards });

  // 1) Create PDF locally
  const { uri: tmpUri } = await Print.printToFileAsync({ html });
  const localName = `weekly_report_${week}.pdf`;
  const dest = FileSystem.documentDirectory + localName;
  await FileSystem.moveAsync({ from: tmpUri, to: dest });

  // 2) Upload to Firebase Storage
  const blob = await (await fetch(dest)).blob();
  const ref = sRef(storage, `archives/${uid}/${localName}`);
  await new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref, blob, { contentType: 'application/pdf' });
    task.on('state_changed', () => {}, reject, resolve);
  });
  const url = await getDownloadURL(ref);

  return { localPath: dest, downloadURL: url, week };
}
/* --------- /Weekly PDF helpers ---------- */

export default function ProfileScreen() {
  const navigation = useNavigation();

  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [avatar, setAvatar] = useState('');         // may be http(s) or file:
  const [imgOk, setImgOk] = useState(true);         // image load fallback
  const [uploading, setUploading] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Load newest profile (server vs local) + purge legacy keys
  useEffect(() => {
    (async () => {
      try { await ImagePicker.requestMediaLibraryPermissionsAsync(); } catch {}
      try {
        await clearLegacyProfileKeys();
        const p = await loadProfile({ preferServer: true, purgeLegacy: false });
        setName(p.name || '');
        setRole(p.role || '');
        setCompany(p.company || '');
        setPhone(p.phone || '');
        setAvatar(p.avatar || '');
        setImgOk(true);
      } catch (e) {
        console.log('Load profile error:', e?.message || e);
      }
    })();
  }, []);

  const pickAvatar = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') return Alert.alert('Permission needed', 'Media library access is required.');

      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
      });
      if (res.canceled) return;

      const localUri = res.assets?.[0]?.uri;
      if (!localUri) return;

      // Show preview immediately
      setAvatar(localUri);
      setImgOk(true);

      // Upload then swap to download URL and persist
      setUploading(true);
      const downloadURL = await uploadAvatarToStorage(localUri);
      setAvatar(downloadURL);
      setImgOk(true);

      await saveProfile({
        name: name.trim(),
        role: role.trim(),
        company: company.trim(),
        phone: phone.trim(),
        avatar: downloadURL,
      });

      try { await auth.currentUser?.updateProfile?.({ photoURL: downloadURL }); } catch {}
    } catch (e) {
      console.log('Avatar upload error:', e?.message || e);
      Alert.alert('Upload error', String(e?.message || e));
    } finally {
      setUploading(false);
    }
  };

  const removeAvatar = async () => {
    setAvatar('');
    setImgOk(true);
    try {
      await saveProfile({
        name: name.trim(),
        role: role.trim(),
        company: company.trim(),
        phone: phone.trim(),
        avatar: '',
      });
    } catch {}
  };

  const onSave = async () => {
    if (!name.trim()) return Alert.alert('Name required', 'Please enter your name.');
    try {
      let toSave = avatar || '';

      // If user somehow has a local file here, try to upload now
      if (toSave && !isHttp(toSave) && isFile(toSave)) {
        try {
          setUploading(true);
          toSave = await uploadAvatarToStorage(toSave);
          setAvatar(toSave);
          setImgOk(true);
        } catch (e) {
          console.log('Late avatar upload error:', e?.message || e);
        } finally {
          setUploading(false);
        }
      }

      await saveProfile({
        name: name.trim(),
        role: role.trim(),
        designation: role.trim(),
        company: company.trim(),
        phone: phone.trim(),
        avatar: isHttp(toSave) ? toSave : '', // only persist http(s) URL
      });

      Alert.alert('Saved', 'Profile updated.');
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.navigate('Home');
    } catch (e) {
      Alert.alert('Save error', String(e?.message || e));
    }
  };

  // Render either the image (http/file) or initials fallback
  const showImage = !!avatar && (isHttp(avatar) || isFile(avatar)) && imgOk;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(4) }}
        keyboardShouldPersistTaps="always"
      >
        {/* Avatar */}
        <View style={styles.avatarRow}>
          <View style={styles.avatarCircle}>
            {showImage ? (
              <Image
                source={{ uri: avatar }}
                style={styles.avatarImage}
                onError={() => setImgOk(false)}
              />
            ) : (
              <Text style={styles.avatarInitials}>{initialsFromName(name)}</Text>
            )}
            {uploading && (
              <View style={styles.uploadOverlay}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
          </View>
          <View style={{ marginLeft: spacing(1.5), flex: 1 }}>
            <Text style={styles.headerText}>Profile Photo</Text>
            <Text style={styles.subtleText}>Add a clear headshot</Text>
          </View>
        </View>

        <View style={styles.avatarBtnsRow}>
          <TouchableOpacity
            style={[styles.smallBtn, styles.primaryBtn]}
            onPress={pickAvatar}
            activeOpacity={0.7}
            hitSlop={12}
            disabled={uploading}
          >
            <Text style={styles.primaryBtnText}>{uploading ? 'Uploading…' : 'Choose Photo'}</Text>
          </TouchableOpacity>
          <View style={{ width: spacing(1) }} />
          <TouchableOpacity
            style={[styles.smallBtn, styles.outlineBtn]}
            onPress={removeAvatar}
            activeOpacity={0.7}
            hitSlop={12}
            disabled={uploading}
          >
            <Text style={styles.outlineBtnText}>Remove</Text>
          </TouchableOpacity>
        </View>

        {/* Profile fields */}
        <View style={{ marginTop: spacing(2) }}>
          <Text style={styles.label}>Full Name</Text>
          <TextInput
            value={name}
            onChangeText={(t)=>{ setName(t); if (!avatar) setImgOk(true); }}
            placeholder="Your name"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <Text style={styles.label}>Role / Designation</Text>
          <TextInput
            value={role}
            onChangeText={setRole}
            placeholder="e.g., SHE Rep"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <Text style={styles.label}>Company</Text>
          <TextInput
            value={company}
            onChangeText={setCompany}
            placeholder="e.g., ZeroHarm Mining"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <Text style={styles.label}>Phone Number</Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="e.g., +27 82 123 4567"
            placeholderTextColor={colors.muted}
            style={styles.input}
            keyboardType="phone-pad"
          />
        </View>

        <TouchableOpacity
          style={styles.saveBtn}
          onPress={onSave}
          activeOpacity={0.7}
          hitSlop={12}
          disabled={uploading}
        >
          <Text style={styles.saveBtnText}>Save</Text>
        </TouchableOpacity>

        {/* Weekly Report (PDF) */}
        <View style={[styles.card, { marginTop: spacing(2) }]}>
          <Text style={styles.headerText}>Weekly Report (PDF)</Text>
          <Text style={styles.subtleText}>
            Generate last 7 days of posts & hazards. A PDF will be saved on this device and uploaded to cloud storage.
          </Text>

          <View style={{ flexDirection:'row', marginTop: spacing(1) }}>
            <TouchableOpacity
              style={[styles.smallBtn, styles.primaryBtn, pdfBusy && { opacity:0.7 }]}
              activeOpacity={0.7}
              onPress={async () => {
                try {
                  const user = auth.currentUser;
                  if (!user) { Alert.alert('Sign in required', 'Please sign in first.'); return; }
                  setPdfBusy(true);
                  const { localPath, downloadURL, week } = await generateAndUploadWeeklyPdf({ uid: user.uid });
                  Alert.alert(
                    'Weekly PDF ready',
                    `Week ${week}`,
                    [
                      { text: 'Open (local)', onPress: async () => {
                          try {
                            if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(localPath);
                            else Alert.alert('Saved', `File saved to: ${localPath}`);
                          } catch {}
                        }},
                      { text: 'Open (cloud)', onPress: () => Linking.openURL(downloadURL) },
                      { text: 'OK' }
                    ]
                  );
                } catch (e) {
                  Alert.alert('PDF error', String(e?.message || e));
                } finally {
                  setPdfBusy(false);
                }
              }}
              disabled={pdfBusy}
            >
              <Text style={styles.primaryBtnText}>{pdfBusy ? 'Generating…' : 'Generate & Upload'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:{ flex:1, backgroundColor: colors.bg },

  avatarRow:{
    flexDirection:'row',
    alignItems:'center',
    backgroundColor: colors.surface,
    borderWidth:1,
    borderColor: colors.border,
    padding: spacing(1.5),
    borderRadius: 12
  },
  avatarCircle:{
    width:72, height:72, borderRadius:36,
    alignItems:'center', justifyContent:'center',
    backgroundColor:'#0F151C',
    borderWidth:1, borderColor: colors.border,
    overflow:'hidden'
  },
  avatarImage:{ width:70, height:70, borderRadius:35 },
  avatarInitials:{ color:'#fff', fontWeight:'900', fontSize:22, letterSpacing:0.5 },

  uploadOverlay:{
    position:'absolute', top:0, left:0, right:0, bottom:0,
    alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(0,0,0,0.35)'
  },

  headerText:{ color: colors.text, fontWeight:'800', fontSize:16 },
  subtleText:{ color: colors.muted, fontSize:12, marginTop: 2 },

  avatarBtnsRow:{ flexDirection:'row', marginTop: spacing(1) },
  smallBtn:{ paddingVertical:10, paddingHorizontal:14, borderRadius:10, borderWidth:1, alignItems:'center' },
  primaryBtn:{ backgroundColor: colors.primary, borderColor: 'rgba(0,0,0,0.2)' },
  primaryBtnText:{ color:'#06130A', fontWeight:'900' },
  outlineBtn:{ backgroundColor:'transparent', borderColor: colors.muted },
  outlineBtnText:{ color: colors.text, fontWeight:'800' },

  label:{ color: colors.text, fontSize:13, fontWeight:'700', marginTop: spacing(1.5), marginBottom: spacing(0.5) },
  input:{ backgroundColor: colors.surface, borderWidth:1, borderColor: colors.border, color: colors.text, padding: spacing(1.25), borderRadius: 10 },

  saveBtn:{ marginTop: spacing(2), backgroundColor: colors.primary, paddingVertical: 12, borderRadius: 12, alignItems:'center' },
  saveBtnText:{ color:'#06130A', fontWeight:'900' },

  card:{
    backgroundColor: colors.surface,
    borderWidth:1, borderColor: colors.border,
    borderRadius:12, padding: spacing(1.5)
  },
});
