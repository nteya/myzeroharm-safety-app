import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, Image, ScrollView, Alert, Linking, ActivityIndicator,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import {
  collection, addDoc, serverTimestamp, query, orderBy, onSnapshot,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { db, storage } from '../firebase';
import { loadProfile } from '../storage';

const colors = { bg:'#0B0F14', surface:'#131A22', text:'#E7EEF5', muted:'#A7B4C2', primary:'#00C853', border:'#1E2530' };
const spacing = (n=1)=>8*n;

const HAZARDS_KEY = 'HAZARD_REPORTS_V1';
const TYPES = ['Hazard','Incident','Near Miss','Leak'];
const CATEGORIES = [
  'Housekeeping','Electrical','Working at Height','Vehicle / Traffic','Hot Work',
  'Chemical','Lifting / Rigging','Confined Space','Excavation / Trenching','Other'
];
const SEVERITIES = ['Low','Medium','High'];

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const dateKeyOf = (d=new Date())=>{
  const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};

// simple haversine distance in km
function distanceKm(a, b){
  if(!a || !b) return Infinity;
  const toRad = (x)=>x*Math.PI/180;
  const R=6371;
  const dLat=toRad((b.latitude||0)-(a.latitude||0));
  const dLon=toRad((b.longitude||0)-(a.longitude||0));
  const lat1=toRad(a.latitude||0);
  const lat2=toRad(b.latitude||0);
  const s1=Math.sin(dLat/2)**2 + Math.sin(dLon/2)**2 * Math.cos(lat1)*Math.cos(lat2);
  return 2*R*Math.asin(Math.sqrt(s1));
}

async function addHazardLocal(report){
  try {
    const raw = await AsyncStorage.getItem(HAZARDS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = [{ ...report, id: report.id || uid() }, ...list];
    await AsyncStorage.setItem(HAZARDS_KEY, JSON.stringify(next));
    return next;
  } catch { return []; }
}

export default function ReportHazardScreen(){
  // form visibility
  const [showForm, setShowForm] = useState(false);

  // ---- form state
  const [title, setTitle] = useState('');
  const [type, setType] = useState(TYPES[0]);
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [description, setDescription] = useState('');
  const [imageUri, setImageUri] = useState('');

  // pin location (for the *form*)
  const [coords, setCoords] = useState(null);   // { latitude, longitude }
  const [locLabel, setLocLabel] = useState(''); // human text (optional)

  // feed + busy
  const [reports, setReports] = useState([]);
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef(null);

  // ---- search/filter state (for the feed)
  const [searchText, setSearchText] = useState('');
  const [searchCoords, setSearchCoords] = useState(null); // { latitude, longitude }
  const [radiusKm, setRadiusKm] = useState(0); // 0 = off, 1/2/5 = km

  // permissions (media)
  useEffect(()=>{ (async()=>{ try{ await ImagePicker.requestMediaLibraryPermissionsAsync(); }catch{} })(); },[]);

  // realtime feed from Firestore (fallback to local if offline)
  useEffect(() => {
    try {
      const qRef = query(collection(db, 'hazards'), orderBy('createdAt', 'desc'));
      const unsub = onSnapshot(qRef, async (snap) => {
        const arr = snap.docs.map((d) => {
          const data = d.data() || {};
          const createdAtMs =
            (data.createdAt?.toMillis && data.createdAt.toMillis()) ||
            data.createdAtMs ||
            Date.now();
          return {
            id: data.id || d.id,
            firestoreId: d.id,
            title: data.title || '',
            type: data.type || 'Hazard',
            category: data.category || '',
            severity: data.severity || 'Low',
            description: data.description || '',
            imageUrl: data.imageUrl || '',
            imageUri: data.imageUri || '',
            locationText: data.locationText || '',
            coords: data.coords || null,
            // all reports are anonymous by design now
            anonymous: true,
            dateKey: data.dateKey || dateKeyOf(new Date(createdAtMs)),
            createdAtMs,
          };
        });
        setReports(arr);
        await AsyncStorage.setItem(HAZARDS_KEY, JSON.stringify(arr));
      }, async () => {
        const raw = await AsyncStorage.getItem(HAZARDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        setReports(arr);
      });
      unsubRef.current = unsub;
      return () => { try { unsub && unsub(); } catch {} };
    } catch {
      (async () => {
        const raw = await AsyncStorage.getItem(HAZARDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        setReports(arr);
      })();
    }
  }, []);

  // ---- search helpers
  const clearSearch = () => { setSearchText(''); setSearchCoords(null); setRadiusKm(0); };

  const useMyLocationForSearch = async () => {
    try{
      const { status } = await Location.requestForegroundPermissionsAsync();
      if(status!=='granted') return Alert.alert('Permission needed','Location permission is required.');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setSearchCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      // default radius if not set
      setRadiusKm((r)=> r>0 ? r : 2);
    }catch(e){
      Alert.alert('Location error', String(e?.message || e));
    }
  };

  // apply filters (text + optional distance)
  const filteredReports = useMemo(() => {
    const q = (searchText || '').trim().toLowerCase();
    const byText = (r) => {
      if (!q) return true;
      const hay = [
        r.title || '', r.description || '', r.category || '', r.type || '', r.locationText || ''
      ].join(' ').toLowerCase();
      return hay.includes(q);
    };
    const byDistance = (r) => {
      if (!searchCoords || !radiusKm || !r?.coords) return true;
      const d = distanceKm(searchCoords, r.coords);
      return d <= radiusKm;
    };
    return (reports || []).filter((r)=> byText(r) && byDistance(r));
  }, [reports, searchText, searchCoords, radiusKm]);

  const pickImage = async ()=> {
    if (busy) return;
    try{
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if(status!=='granted') return Alert.alert('Permission needed','Media library access is required.');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality:0.85 });
      if(!res.canceled) setImageUri(res.assets[0].uri);
    }catch(e){ Alert.alert('Image error', String(e?.message || e)); }
  };
  const removeImage = ()=> !busy && setImageUri('');

  // location for the *form*
  const pinLocation = async ()=>{
    if (busy) return;
    try{
      const { status } = await Location.requestForegroundPermissionsAsync();
      if(status!=='granted') return Alert.alert('Permission needed','Location permission is required.');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords || {};
      setCoords({ latitude, longitude });
      try{
        const rg = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (rg && rg[0]) {
          const r = rg[0];
          const text = [r.name, r.street, r.city, r.region].filter(Boolean).join(', ');
          if (text) setLocLabel(text);
        }
      }catch{}
    }catch(e){ Alert.alert('Location error', String(e?.message || e)); }
  };

  const openInMaps = (lat, lon) => {
    const url = `https://www.google.com/maps?q=${lat},${lon}`;
    Linking.openURL(url).catch(()=>{});
  };

  const uploadImageIfAny = async (uri, id) => {
    if (!uri) return '';
    try{
      const resp = await fetch(uri);
      const blob = await resp.blob();
      const imgRef = storageRef(storage, `hazards/${id}.jpg`);
      const metadata = { contentType: blob.type || 'image/jpeg' };
      await uploadBytes(imgRef, blob, metadata);
      const url = await getDownloadURL(imgRef);
      return url;
    }catch{
      return '';
    }
  };

  const canSubmit = title.trim().length>0 && category && severity;

  const submit = async ()=> {
    if (busy) return;
    if(!canSubmit){
      return Alert.alert('Missing info','Title, category and severity are required.');
    }
    try{
      setBusy(true);

      const id = uid();
      const nowMs = Date.now();
      const dayKey = dateKeyOf(new Date(nowMs));

      // still reading profile in case we later want to tag company (not stored now)
      await loadProfile({ preferServer: true });
      const imageUrl = await uploadImageIfAny(imageUri, id);

      const payload = {
        id,
        title: title.trim(),
        type,
        category,
        severity,
        description: description.trim(),
        imageUrl,
        imageUri: imageUrl ? '' : (imageUri || ''),
        locationText: locLabel.trim(),
        coords: coords ? { latitude: coords.latitude, longitude: coords.longitude } : null,
        anonymous: true,               // <- forced anonymous
        reporter: null,
        reporterUid: null,
        reporterCompany: '',
        dateKey: dayKey,
        createdAt: serverTimestamp(),
        createdAtMs: nowMs,
      };

      await addDoc(collection(db, 'hazards'), payload);
      await addHazardLocal({ ...payload });

      Alert.alert('Reported','Thanks — hazard logged.', [
        { text:'OK', onPress: ()=> {
          setShowForm(false);
          // reset form
          setTitle(''); setCategory(''); setSeverity(''); setDescription('');
          setImageUri(''); setCoords(null); setLocLabel('');
        } }
      ]);
    }catch(e){
      Alert.alert('Save error', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const Pill = ({ label, active, onPress }) => (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} disabled={busy}
      style={[styles.pill, active ? styles.pillOn : styles.pillOff, busy && { opacity:0.6 }]}>
      <Text style={[styles.pillText, active ? styles.pillTextOn : styles.pillTextOff]}>{label}</Text>
    </TouchableOpacity>
  );

  const badgeColor = (sev) => {
    switch (sev) {
      case 'High': return { bg: '#8B0000', text: '#fff' };
      case 'Medium': return { bg: '#8B6500', text: '#fff' };
      default: return { bg: '#0F4D32', text: '#fff' };
    }
  };

  const ReportCard = ({ item }) => {
    const hasCoords = item?.coords && typeof item.coords.latitude === 'number' && typeof item.coords.longitude === 'number';
    const sev = badgeColor(item.severity || 'Low');
    return (
      <View style={styles.reportCard}>
        <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'center' }}>
          <Text style={styles.reportTitle}>{item.title}</Text>
          <View style={[styles.sevBadge, { backgroundColor: sev.bg }]}>
            <Text style={[styles.sevBadgeText, { color: sev.text }]}>{item.severity}</Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          {!!item.type && <Text style={styles.metaText}>• {item.type}</Text>}
          {!!item.category && <Text style={styles.metaText}>• {item.category}</Text>}
          <Text style={styles.metaText}>• Anonymous</Text>
        </View>

        {!!item.description && <Text style={styles.reportDesc}>{item.description}</Text>}

        {!!item.imageUrl && (
          <Image source={{ uri:item.imageUrl }} style={styles.reportImage} resizeMode="cover" />
        )}
        {!item.imageUrl && !!item.imageUri && (
          <Image source={{ uri:item.imageUri }} style={styles.reportImage} resizeMode="cover" />
        )}

        {(item.locationText || hasCoords) && (
          <View style={styles.locRow}>
            <Text style={styles.locLabel}>📍 {item.locationText || `${item.coords.latitude.toFixed(5)}, ${item.coords.longitude.toFixed(5)}`}</Text>
            {hasCoords && (
              <TouchableOpacity style={styles.mapBtn} onPress={()=>openInMaps(item.coords.latitude, item.coords.longitude)} activeOpacity={0.7}>
                <Text style={styles.mapBtnText}>Open in Maps</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  // --- compact form component (revealed only when showForm === true)
  const Form = useMemo(()=> showForm ? (
    <View style={styles.card}>
      <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom: spacing(0.5) }}>
        <Text style={{ color: colors.text, fontWeight:'900', fontSize: 15 }}>New hazard report</Text>
        <TouchableOpacity onPress={()=>!busy && setShowForm(false)} hitSlop={8} style={[styles.smallBtn, styles.outlineBtn, { paddingVertical:6 }]}>
          <Text style={styles.outlineBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Title</Text>
      <TextInput
        value={title} onChangeText={setTitle} editable={!busy}
        placeholder="e.g., Oil spill on walkway near Pit 3"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />

      <Text style={styles.label}>Type</Text>
      <View style={styles.pillRow}>
        {TYPES.map((t)=>(<Pill key={t} label={t} active={type===t} onPress={()=>setType(t)} />))}
      </View>

      <Text style={styles.label}>Category</Text>
      <View style={styles.pillRow}>
        {CATEGORIES.map((c)=>(<Pill key={c} label={c} active={category===c} onPress={()=>setCategory(c)} />))}
      </View>

      <Text style={styles.label}>Severity</Text>
      <View style={styles.pillRow}>
        {SEVERITIES.map((s)=>(<Pill key={s} label={s} active={severity===s} onPress={()=>setSeverity(s)} />))}
      </View>

      <Text style={styles.label}>Description (optional)</Text>
      <TextInput
        value={description} onChangeText={setDescription} editable={!busy} multiline
        placeholder="What happened and what control(s) did you apply (barrier, clean-up, isolate…)?"
        placeholderTextColor={colors.muted}
        style={[styles.input, { minHeight: 110, textAlignVertical:'top' }]}
      />

      <Text style={styles.label}>Location (optional)</Text>
      <View style={{ flexDirection:'row', gap:8 }}>
        <TouchableOpacity onPress={pinLocation} style={[styles.smallBtn, styles.primaryBtn]} activeOpacity={0.7} disabled={busy}>
          <Text style={styles.primaryBtnText}>{coords ? 'Pinned' : 'Pin GPS'}</Text>
        </TouchableOpacity>
        <TextInput
          value={locLabel} onChangeText={setLocLabel} editable={!busy}
          placeholder="Add a location note (e.g., Workshop Bay 2)"
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex:1 }]}
        />
      </View>

      <Text style={styles.label}>Photo (optional)</Text>
      {imageUri ? (
        <View style={{ alignItems:'flex-start' }}>
          <Image source={{ uri:imageUri }} style={styles.preview} resizeMode="cover" />
          <TouchableOpacity onPress={removeImage} style={[styles.smallBtn, styles.outlineBtn]} activeOpacity={0.7} disabled={busy}>
            <Text style={styles.outlineBtnText}>Remove photo</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity onPress={pickImage} style={[styles.smallBtn, styles.primaryBtn]} activeOpacity={0.7} disabled={busy}>
          <Text style={styles.primaryBtnText}>Choose photo</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity onPress={submit} activeOpacity={0.8} disabled={!canSubmit || busy}
        style={[styles.submitBtn, (!canSubmit || busy) && { opacity:0.6 }]}>
        {busy ? <ActivityIndicator color="#06130A" /> : <Text style={styles.submitText}>Submit hazard</Text>}
      </TouchableOpacity>
    </View>
  ) : null, [showForm, title, type, category, severity, description, imageUri, coords, locLabel, busy]);

  return (
    <SafeAreaView style={styles.root} edges={['top','right','bottom','left']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(8) }}
        keyboardShouldPersistTaps="always"
      >
        {/* Primary call to action */}
        {!showForm && (
          <TouchableOpacity
            onPress={()=>setShowForm(true)}
            activeOpacity={0.85}
            style={styles.bigCta}
          >
            <Text style={styles.bigCtaTitle}>Report a hazard</Text>
            <Text style={styles.bigCtaSub}>Anonymous • Photo & GPS optional</Text>
          </TouchableOpacity>
        )}

        {/* Search / filter bar */}
        <View style={styles.searchCard}>
          <Text style={styles.searchTitle}>Find hazards by area</Text>
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Type area, workshop, pit, bay…"
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
          />
          <View style={styles.filterRow}>
            <TouchableOpacity onPress={useMyLocationForSearch} style={[styles.smallBtn, styles.primaryBtn]} activeOpacity={0.8}>
              <Text style={styles.primaryBtnText}>{searchCoords ? 'Using my location' : 'Use my location'}</Text>
            </TouchableOpacity>

            <View style={{ flexDirection:'row', gap:6, flexWrap:'wrap', flex:1, justifyContent:'flex-end' }}>
              {[0,1,2,5].map(km => (
                <TouchableOpacity
                  key={km}
                  onPress={()=>setRadiusKm(km)}
                  style={[
                    styles.radiusChip,
                    (radiusKm===km) && styles.radiusChipOn
                  ]}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.radiusChipText, (radiusKm===km)&&styles.radiusChipTextOn]}>
                    {km===0 ? 'Any distance' : `${km} km`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {(searchText || searchCoords) ? (
            <TouchableOpacity onPress={clearSearch} style={[styles.smallBtn, styles.outlineBtn, { marginTop: 8 }]} activeOpacity={0.8}>
              <Text style={styles.outlineBtnText}>Clear filters</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Form (collapsed by default) */}
        {Form}

        {/* Feed */}
        <Text style={styles.sectionTitle}>
          {searchText || (searchCoords && radiusKm)
            ? `Matching reports (${filteredReports.length})`
            : `Recent reports`}
        </Text>
        {filteredReports.length === 0 ? (
          <Text style={{ color: colors.muted, fontStyle:'italic' }}>No reports found.</Text>
        ) : (
          <View style={{ gap: spacing(1) }}>
            {filteredReports.map((r) => <ReportCard key={r.id} item={r} />)}
          </View>
        )}
      </ScrollView>

      {/* Floating action button as a second entry to the form */}
      {!showForm && (
        <TouchableOpacity
          onPress={()=>setShowForm(true)}
          activeOpacity={0.9}
          style={styles.fab}
          accessibilityLabel="Report a hazard"
        >
          <Text style={styles.fabText}>+</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:{ flex:1, backgroundColor: colors.bg },

  sectionTitle:{ color: colors.text, fontSize:16, fontWeight:'800', marginTop: spacing(2), marginBottom: spacing(1) },

  // CTA card
  bigCta:{
    backgroundColor: colors.surface, borderWidth:1, borderColor: colors.border,
    borderRadius:14, padding: spacing(1.75), marginBottom: spacing(1.5)
  },
  bigCtaTitle:{ color: colors.text, fontSize:16, fontWeight:'900' },
  bigCtaSub:{ color: colors.muted, fontSize:12, marginTop: 4 },

  // search card
  searchCard:{
    backgroundColor: colors.surface, borderWidth:1, borderColor: colors.border,
    borderRadius:14, padding: spacing(1.5), marginBottom: spacing(1.5)
  },
  searchTitle:{ color: colors.text, fontSize:14, fontWeight:'900', marginBottom: 6 },
  searchInput:{
    backgroundColor:'#0F151C', borderWidth:1, borderColor: colors.border, color: colors.text,
    padding: spacing(1.25), borderRadius:10
  },
  filterRow:{ flexDirection:'row', alignItems:'center', justifyContent:'space-between', gap: 8, marginTop: 8 },
  radiusChip:{
    paddingVertical:6, paddingHorizontal:10, borderRadius:999, borderWidth:1, borderColor: colors.muted,
    backgroundColor:'transparent'
  },
  radiusChipOn:{ backgroundColor: colors.primary, borderColor:'rgba(0,0,0,0.25)' },
  radiusChipText:{ color: colors.text, fontWeight:'800', fontSize:12 },
  radiusChipTextOn:{ color:'#06130A' },

  // form card
  card:{
    backgroundColor: colors.surface, borderWidth:1, borderColor: colors.border,
    borderRadius:12, padding: spacing(1.5), marginBottom: spacing(1.5),
  },
  label:{ color: colors.text, fontSize:13, fontWeight:'700', marginTop: spacing(1), marginBottom: spacing(0.5) },
  input:{
    backgroundColor:'#0F151C', borderWidth:1, borderColor: colors.border, color: colors.text,
    padding: spacing(1.25), borderRadius:10
  },
  pillRow:{ flexDirection:'row', flexWrap:'wrap', gap:8 },
  pill:{ paddingVertical:8, paddingHorizontal:12, borderRadius:999, borderWidth:1, marginBottom:8 },
  pillOn:{ backgroundColor: colors.primary, borderColor:'rgba(0,0,0,0.25)' },
  pillOff:{ backgroundColor:'transparent', borderColor: colors.muted },
  pillText:{ fontWeight:'800' },
  pillTextOn:{ color:'#06130A' },
  pillTextOff:{ color: colors.text },

  preview:{
    width:'100%', height:200, borderRadius:10, marginBottom:8,
    borderWidth:1, borderColor: colors.border, marginTop:4
  },
  smallBtn:{ paddingVertical:10, paddingHorizontal:14, borderRadius:10, borderWidth:1, alignItems:'center' },
  primaryBtn:{ backgroundColor: colors.primary, borderColor:'rgba(0,0,0,0.2)' },
  primaryBtnText:{ color:'#06130A', fontWeight:'900' },
  outlineBtn:{ backgroundColor:'transparent', borderColor: colors.muted },
  outlineBtnText:{ color: colors.text, fontWeight:'800' },
  submitBtn:{
    marginTop: spacing(2), backgroundColor: colors.primary, paddingVertical:12,
    borderRadius:12, alignItems:'center'
  },
  submitText:{ color:'#06130A', fontWeight:'900' },

  // feed
  reportCard:{
    backgroundColor: colors.surface, borderWidth:1, borderColor: colors.border,
    borderRadius:12, padding: spacing(1.5)
  },
  reportTitle:{ color: colors.text, fontWeight:'900', fontSize:15, flex:1, paddingRight: 8 },
  sevBadge:{ paddingVertical:4, paddingHorizontal:8, borderRadius:999 },
  sevBadgeText:{ fontWeight:'900', fontSize:12 },
  metaRow:{ flexDirection:'row', flexWrap:'wrap', gap:10, marginTop:6 },
  metaText:{ color: colors.muted, fontSize:12 },
  reportDesc:{ color: colors.text, fontSize:14, lineHeight:20, marginTop:6 },
  reportImage:{
    width:'100%', height:200, borderRadius:10, marginTop:8,
    borderWidth:1, borderColor: colors.border
  },
  locRow:{ flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginTop:8 },
  locLabel:{ color: colors.muted, fontSize:12, flex:1, paddingRight: 8 },
  mapBtn:{ paddingVertical:6, paddingHorizontal:10, borderRadius:999, borderWidth:1, borderColor: colors.border, backgroundColor:'#0F1720' },
  mapBtnText:{ color: colors.muted, fontSize:12, fontWeight:'800' },

  // FAB
  fab:{
    position:'absolute', right: spacing(2), bottom: spacing(2),
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)',
  },
  fabText:{ color:'#06130A', fontWeight:'900', fontSize:28, lineHeight:28 },
});


