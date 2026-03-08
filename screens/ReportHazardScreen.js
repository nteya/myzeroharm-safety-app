// screens/ReportHazardScreen.js
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Image,
  ScrollView,
  Alert,
  Linking,
  ActivityIndicator,
  Modal,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import {
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  onSnapshot,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { db, storage } from '../firebase';

const colors = {
  bg: '#0B0F14',
  surface: '#131A22',
  text: '#E7EEF5',
  muted: '#A7B4C2',
  primary: '#00C853',
  border: '#1E2530',
};
const spacing = (n = 1) => 8 * n;

const HAZARDS_KEY = 'HAZARD_REPORTS_V1';
const PENDING_KEY = 'PENDING_HAZARDS_V1';

const TYPES = ['Hazard', 'Incident', 'Near Miss', 'Leak', 'Section 23'];

const CATEGORIES = [
  'Housekeeping',
  'Electrical',
  'Working at Height',
  'Vehicle / Traffic',
  'Hot Work',
  'Chemical',
  'Lifting / Rigging',
  'Confined Space',
  'Excavation / Trenching',
  'Other',
];

const SEVERITIES = ['Low', 'Medium', 'High'];

// Normal hazard statuses
const STATUSES = ['Action needed', 'Solved', 'No action needed'];

// Section 23 statuses (more official)
const S23_STATUSES = ['Open', 'Resolved', 'Escalated'];

// Section 23: resolved toggle labels
const YES_NO = ['No', 'Yes'];

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const dateKeyOf = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const formatDateTime = (ms) => {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
};

async function addHazardLocal(report) {
  try {
    const raw = await AsyncStorage.getItem(HAZARDS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = [{ ...report, id: report.id || uid() }, ...list];
    await AsyncStorage.setItem(HAZARDS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

function friendlyError(err, context = 'Action') {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message).toLowerCase() : '';

  if (code.includes('network') || msg.includes('network'))
    return "You're offline or the service is busy. Please try again.";
  if (code.includes('unavailable'))
    return 'The service is temporarily unavailable. Please try again.';
  if (code.includes('deadline') || msg.includes('timeout'))
    return 'The request timed out. Please try again.';
  if (code.includes('permission') || code.includes('unauthorized'))
    return "You don't have permission for that action.";
  if (
    code.includes('quota') ||
    code.includes('exceeded') ||
    code.includes('resource-exhausted')
  )
    return 'Temporary usage limit reached. Try again later.';
  return `${context} failed. Please try again.`;
}

export default function ReportHazardScreen() {
  const [reporterName, setReporterName] = useState('');
  const [reporterRole, setReporterRole] = useState('');

  const [showForm, setShowForm] = useState(false);

  const [title, setTitle] = useState('');
  const [type, setType] = useState(TYPES[0]);
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [description, setDescription] = useState('');
  const [imageUri, setImageUri] = useState('');

  const [actionSuggestion, setActionSuggestion] = useState('');
  const [supervisorName, setSupervisorName] = useState('');
  const [status, setStatus] = useState(STATUSES[0]);

  // ✅ Location/Area (IMPORTANT)
  const [coords, setCoords] = useState(null);
  const [locLabel, setLocLabel] = useState(''); // human-readable "Area / Location"

  const [reports, setReports] = useState([]);
  const [pendingHazards, setPendingHazards] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [searchText, setSearchText] = useState('');

  const [viewerUri, setViewerUri] = useState('');
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);

  // ✅ Section 23 fields (separate form)
  const [s23IssuedBy, setS23IssuedBy] = useState(''); // person who applied / issued S23
  const [s23Problem, setS23Problem] = useState('');
  const [s23HowApplied, setS23HowApplied] = useState('');
  const [s23Resolved, setS23Resolved] = useState('No'); // Yes/No
  const [s23HowSolved, setS23HowSolved] = useState('');
  const [s23CanBeSolved, setS23CanBeSolved] = useState('');
  const [s23WhatNeeded, setS23WhatNeeded] = useState('');

  const isS23 = type === 'Section 23';

  const openViewer = (uri) => {
    if (!uri) return;
    setViewerUri(uri);
    setViewerVisible(true);
  };

  const loadPendingList = async () => {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : [];
  };

  const savePendingList = async (list) => {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(list));
    setPendingHazards(list);
    setPendingCount(list.length);
  };

  useEffect(() => {
    (async () => {
      try {
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const name = await AsyncStorage.getItem('profileName');
        const role = await AsyncStorage.getItem('profileRole');
        setReporterName(name || '');
        setReporterRole(role || '');

        const list = await loadPendingList();
        setPendingHazards(list);
        setPendingCount(list.length);
      } catch {}
    })();
  }, []);

  // ✅ hazards feed — order by createdAtMs
  useEffect(() => {
    try {
      const qRef = query(collection(db, 'hazards'), orderBy('createdAtMs', 'desc'));

      const unsub = onSnapshot(
        qRef,
        async (snap) => {
          const arr = snap.docs.map((d) => {
            const data = d.data() || {};
            const createdAtMs =
              (typeof data.createdAtMs === 'number' && data.createdAtMs) ||
              (data.createdAt?.toMillis && data.createdAt.toMillis()) ||
              Date.now();

            const occurredAtMs =
              (typeof data.occurredAtMs === 'number' && data.occurredAtMs) || createdAtMs;

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

              // ✅ Location/Area robust reads
              locationText: data.locationText || data.area || data.section || '',
              area: data.area || data.locationText || '',

              coords: data.coords || null,
              reporterName: data.reporterName || '',
              reporterRole: data.reporterRole || '',
              actionSuggestion: data.actionSuggestion || '',
              supervisorName: data.supervisorName || data.supervisor || '',
              status: data.status || 'Action needed',
              dateKey: data.dateKey || dateKeyOf(new Date(createdAtMs)),
              createdAtMs,
              occurredAtMs,
              occurredAtText: data.occurredAtText || formatDateTime(occurredAtMs),

              section23: data.section23 || null,
              isPending: false,
            };
          });

          setReports(arr);
          await AsyncStorage.setItem(HAZARDS_KEY, JSON.stringify(arr));
        },
        async () => {
          const raw = await AsyncStorage.getItem(HAZARDS_KEY);
          const arr = raw ? JSON.parse(raw) : [];
          setReports(arr);
        }
      );

      return () => {
        try {
          unsub && unsub();
        } catch {}
      };
    } catch {
      (async () => {
        const raw = await AsyncStorage.getItem(HAZARDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        setReports(arr);
      })();
    }
  }, []);

  // ✅ This button still helps fill search field (keep it)
  const useMyLocationForSearch = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted')
        return Alert.alert('Permission needed', 'Location permission is required.');

      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const { latitude, longitude } = pos.coords || {};

      try {
        const rg = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (rg && rg[0]) {
          const r = rg[0];
          const text = [r.name, r.street, r.city, r.region].filter(Boolean).join(', ');
          if (text) setSearchText(text);
        } else {
          setSearchText(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
        }
      } catch {
        setSearchText(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
      }
    } catch (e) {
      Alert.alert('Location error', friendlyError(e, 'Location'));
    }
  };

  const pickImage = async () => {
    if (busy) return;
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted')
        return Alert.alert('Permission needed', 'Media library access is required.');

      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
      });

      if (!res.canceled) setImageUri(res.assets[0].uri);
    } catch (e) {
      Alert.alert('Image error', friendlyError(e, 'Image pick'));
    }
  };

  const removeImage = () => !busy && setImageUri('');

  // ✅ Pin GPS for the report (fills coords + tries to auto-fill locLabel)
  const pinLocation = async () => {
    if (busy) return;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted')
        return Alert.alert('Permission needed', 'Location permission is required.');

      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const { latitude, longitude } = pos.coords || {};
      setCoords({ latitude, longitude });

      // Try reverse geocode -> Fill locLabel IF empty or if user wants auto
      try {
        const rg = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (rg && rg[0]) {
          const r = rg[0];
          const text = [r.name, r.street, r.city, r.region].filter(Boolean).join(', ');
          if (text) {
            // Only auto-fill if locLabel is empty (avoid overwriting manual entry)
            setLocLabel((prev) => (prev && prev.trim().length ? prev : text));
          }
        }
      } catch {}
    } catch (e) {
      Alert.alert('Location error', friendlyError(e, 'Location'));
    }
  };

  const openInMaps = (lat, lon) => {
    const url = `https://www.google.com/maps?q=${lat},${lon}`;
    Linking.openURL(url).catch(() => {});
  };

  const uploadImageIfAny = async (uri, id) => {
    if (!uri) return '';
    try {
      const resp = await fetch(uri);
      const blob = await resp.blob();
      const imgRef = storageRef(storage, `hazards/${id}.jpg`);
      const metadata = { contentType: blob.type || 'image/jpeg' };
      await uploadBytes(imgRef, blob, metadata);
      const url = await getDownloadURL(imgRef);
      return url;
    } catch {
      return '';
    }
  };

  // ✅ Validation differs for Section 23 vs others
  // ✅ NOW NORMAL REPORTS ALSO REQUIRE AREA/LOCATION (because you said it’s important)
  const canSubmitNormal =
    title.trim().length > 0 &&
    category &&
    severity &&
    reporterName.trim().length > 0 &&
    locLabel.trim().length > 0;

  const canSubmitS23 =
    title.trim().length > 0 &&
    reporterName.trim().length > 0 &&
    supervisorName.trim().length > 0 &&
    locLabel.trim().length > 0 &&
    s23IssuedBy.trim().length > 0 &&
    s23Problem.trim().length > 0 &&
    s23HowApplied.trim().length > 0;

  const canSubmit = isS23 ? canSubmitS23 : canSubmitNormal;

  const resetSection23 = () => {
    setS23IssuedBy('');
    setS23Problem('');
    setS23HowApplied('');
    setS23Resolved('No');
    setS23HowSolved('');
    setS23CanBeSolved('');
    setS23WhatNeeded('');
  };

  const resetForm = () => {
    setTitle('');
    setType(TYPES[0]);
    setCategory('');
    setSeverity('');
    setDescription('');
    setImageUri('');
    setCoords(null);
    setLocLabel('');
    setActionSuggestion('');
    setSupervisorName('');
    setStatus(STATUSES[0]);
    resetSection23();
  };

  useEffect(() => {
    if (isS23) setStatus(S23_STATUSES[0]);
    else setStatus(STATUSES[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const submit = async () => {
    if (busy) return;
    if (!canSubmit) {
      return Alert.alert(
        'Missing info',
        isS23
          ? 'For Section 23: Title, your name, supervisor, area, issued by, problem, and how it was applied are required.'
          : 'For normal reports: Title, category, severity, your name, and Area/Location are required.'
      );
    }

    try {
      setBusy(true);

      const id = uid();
      const nowMs = Date.now();
      const dayKey = dateKeyOf(new Date(nowMs));

      const occurredAtMs = nowMs;
      const occurredAtText = formatDateTime(occurredAtMs);

      // ✅ Always store area/location properly (this fixes PDF + matrix)
      const locationTextFinal = (locLabel || '').trim();

      const base = {
        id,
        title: title.trim(),
        type,
        category: isS23 ? '' : category,
        severity: isS23 ? '' : severity,
        description: isS23 ? '' : description.trim(),

        // ✅ IMPORTANT: these two make location never disappear
        locationText: locationTextFinal,
        area: locationTextFinal,

        coords: coords ? { latitude: coords.latitude, longitude: coords.longitude } : null,

        reporterName: reporterName || 'Anonymous',
        reporterRole: reporterRole || '',
        actionSuggestion: isS23 ? '' : actionSuggestion.trim(),
        supervisorName: supervisorName.trim(),
        status: status || (isS23 ? 'Open' : 'Action needed'),
        dateKey: dayKey,
        createdAtMs: nowMs,
        occurredAtMs,
        occurredAtText,
      };

      const section23Block = isS23
        ? {
            issuedBy: s23IssuedBy.trim(),
            problem: s23Problem.trim(),
            howApplied: s23HowApplied.trim(),
            resolved: s23Resolved === 'Yes',
            howSolved: s23Resolved === 'Yes' ? s23HowSolved.trim() : '',
            canBeSolved: s23Resolved === 'No' ? s23CanBeSolved.trim() : '',
            whatNeeded: s23Resolved === 'No' ? s23WhatNeeded.trim() : '',
          }
        : null;

      // 1) Save to pending immediately (offline-safe)
      const currentPending = await loadPendingList();
      const newPending = [
        ...currentPending,
        {
          ...base,
          section23: section23Block,
          imageUri: imageUri || '',
          imageUrl: '',
          isPending: true,
        },
      ];
      await savePendingList(newPending);
      setPendingHazards(newPending);

      // 2) Try upload + send to hazards
      try {
        const imageUrl = await uploadImageIfAny(imageUri, id);

        const payloadForRemote = {
          ...base,
          section23: section23Block,
          imageUrl,
          imageUri: imageUrl ? '' : imageUri || '',
          createdAt: serverTimestamp(),
        };

        await addDoc(collection(db, 'hazards'), payloadForRemote);
        await addHazardLocal(payloadForRemote);

        const after = (await loadPendingList()).filter((h) => h.id !== id);
        await savePendingList(after);

        Alert.alert('Reported', isS23 ? 'Section 23 logged.' : 'Thanks — report logged.');
      } catch {
        Alert.alert(
          'Saved offline',
          'No network. Your report is saved on this device and can be synced when you have signal.'
        );
      }

      setShowForm(false);
      resetForm();
    } catch (e) {
      Alert.alert('Save error', friendlyError(e, 'Save'));
    } finally {
      setBusy(false);
    }
  };

  const handleSyncPending = async () => {
    try {
      setSyncing(true);
      const list = await loadPendingList();

      if (!list.length) {
        Alert.alert('Up to date', 'No pending reports to sync.');
        return;
      }

      const stillPending = [];

      for (const hazard of list) {
        try {
          const imageUrl = await uploadImageIfAny(hazard.imageUri || hazard.imageUrl, hazard.id);

          const nowMs = hazard.createdAtMs || Date.now();
          const occurredAtMs = hazard.occurredAtMs || nowMs;

          // ✅ keep locationText + area
          const locationTextFinal = (hazard.locationText || hazard.area || '').trim();

          const payloadForRemote = {
            id: hazard.id,
            title: hazard.title,
            type: hazard.type,
            category: hazard.category || '',
            severity: hazard.severity || '',
            description: hazard.description || '',

            locationText: locationTextFinal,
            area: locationTextFinal,

            coords: hazard.coords || null,
            reporterName: hazard.reporterName || 'Anonymous',
            reporterRole: hazard.reporterRole || '',
            actionSuggestion: hazard.actionSuggestion || '',
            supervisorName: hazard.supervisorName || '',
            status: hazard.status || (hazard.type === 'Section 23' ? 'Open' : 'Action needed'),
            dateKey: hazard.dateKey || dateKeyOf(new Date(nowMs)),
            createdAt: serverTimestamp(),
            createdAtMs: nowMs,
            imageUrl,
            imageUri: imageUrl ? '' : hazard.imageUri || '',
            occurredAtMs,
            occurredAtText: hazard.occurredAtText || formatDateTime(occurredAtMs),
            section23: hazard.section23 || null,
          };

          await addDoc(collection(db, 'hazards'), payloadForRemote);
          await addHazardLocal(payloadForRemote);
        } catch {
          stillPending.push(hazard);
        }
      }

      await savePendingList(stillPending);

      if (stillPending.length === 0) {
        Alert.alert('Sync complete', 'All pending reports were sent.');
      } else {
        Alert.alert(
          'Partial sync',
          `${stillPending.length} report(s) could not be sent. They will stay saved and you can try again.`
        );
      }
    } catch {
      Alert.alert('Sync failed', 'Could not sync reports. Please check your network and try again.');
    } finally {
      setSyncing(false);
    }
  };

  const Pill = ({ label, active, onPress }) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      disabled={busy}
      style={[
        styles.pill,
        active ? styles.pillOn : styles.pillOff,
        busy && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.pillText, active ? styles.pillTextOn : styles.pillTextOff]}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const badgeColor = (sev) => {
    switch (sev) {
      case 'High':
        return { bg: '#8B0000', text: '#fff' };
      case 'Medium':
        return { bg: '#8B6500', text: '#fff' };
      default:
        return { bg: '#0F4D32', text: '#fff' };
    }
  };

  const statusColor = (st, itemType) => {
    if (itemType === 'Section 23') {
      switch (st) {
        case 'Resolved':
          return { bg: '#0F4D32', text: '#E7FBEA' };
        case 'Escalated':
          return { bg: '#7C2D12', text: '#FFF7ED' };
        default:
          return { bg: '#1F2937', text: '#E5E7EB' };
      }
    }

    switch (st) {
      case 'Solved':
        return { bg: '#0F4D32', text: '#E7FBEA' };
      case 'No action needed':
        return { bg: '#374151', text: '#E5E7EB' };
      default:
        return { bg: '#8B6500', text: '#FFF7E6' };
    }
  };

  const filteredReports = useMemo(() => {
    const q = (searchText || '').trim().toLowerCase();

    const combined = [
      ...pendingHazards.map((h) => ({ ...h, isPending: true })),
      ...reports,
    ];

    if (!q) return combined;

    return combined.filter((r) => {
      const s23 = r.section23 || {};
      const hay = [
        r.title || '',
        r.description || '',
        r.category || '',
        r.type || '',
        r.locationText || '',
        r.area || '',
        r.reporterName || '',
        r.actionSuggestion || '',
        r.supervisorName || '',
        r.status || '',
        r.occurredAtText || '',
        s23.issuedBy || '',
        s23.problem || '',
        s23.howApplied || '',
        s23.howSolved || '',
        s23.canBeSolved || '',
        s23.whatNeeded || '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [reports, pendingHazards, searchText]);

  const ReportCard = ({ item }) => {
    const hasCoords =
      item?.coords &&
      typeof item.coords.latitude === 'number' &&
      typeof item.coords.longitude === 'number';

    const uri = item.imageUrl || item.imageUri || '';
    const nameLabel = item.reporterName || 'Anonymous';

    const when =
      item.occurredAtText ||
      formatDateTime(item.occurredAtMs || item.createdAtMs || Date.now());

    const st = statusColor(item.status || 'Open', item.type);

    const isS23Card = item.type === 'Section 23';
    const s23 = item.section23 || null;

    const sev = badgeColor(item.severity || 'Low');

    // ✅ show location/area
    const locText = item.locationText || item.area || '';

    return (
      <View style={styles.reportCard}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.reportTitle}>{item.title}</Text>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={[styles.statusBadge, { backgroundColor: st.bg }]}>
              <Text style={[styles.statusBadgeText, { color: st.text }]}>
                {item.status || (isS23Card ? 'Open' : 'Action needed')}
              </Text>
            </View>

            {!isS23Card && (
              <View style={[styles.sevBadge, { backgroundColor: sev.bg }]}>
                <Text style={[styles.sevBadgeText, { color: sev.text }]}>
                  {item.severity || 'Low'}
                </Text>
              </View>
            )}
          </View>
        </View>

        <View style={styles.metaRow}>
          {!!item.type && <Text style={styles.metaText}>• {item.type}</Text>}
          {!!item.category && !isS23Card && <Text style={styles.metaText}>• {item.category}</Text>}
          <Text style={styles.metaText}>• Reported by {nameLabel}</Text>
          {!!item.supervisorName && <Text style={styles.metaText}>• Supervisor: {item.supervisorName}</Text>}
          <Text style={styles.metaText}>• {when}</Text>
          {item.isPending && (
            <Text style={[styles.metaText, { color: colors.primary }]}>• Pending sync</Text>
          )}
        </View>

        {!!locText && (
          <Text style={[styles.metaText, { marginTop: 6 }]}>📍 {locText}</Text>
        )}

        {isS23Card && s23 ? (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.actionLabel}>Section 23 summary</Text>
            <Text style={styles.actionText}>Issued by: {s23.issuedBy || '-'}</Text>
            <Text style={styles.actionText}>Problem: {s23.problem || '-'}</Text>
            <Text style={styles.actionText}>Resolved: {s23.resolved ? 'Yes' : 'No'}</Text>
          </View>
        ) : (
          <>
            {!!item.description && <Text style={styles.reportDesc}>{item.description}</Text>}

            {!!item.actionSuggestion && (
              <View style={{ marginTop: 6 }}>
                <Text style={styles.actionLabel}>Suggested action:</Text>
                <Text style={styles.actionText}>{item.actionSuggestion}</Text>
              </View>
            )}
          </>
        )}

        {!!uri && (
          <TouchableOpacity onPress={() => openViewer(uri)} activeOpacity={0.9} style={{ marginTop: 8 }}>
            <Image source={{ uri }} style={styles.reportImage} resizeMode="cover" />
            <View style={styles.overlay}>
              <Text style={styles.overlayText}>Tap to view full</Text>
            </View>
          </TouchableOpacity>
        )}

        {hasCoords && (
          <View style={styles.locRow}>
            <Text style={styles.locLabel}>
              {item.coords.latitude.toFixed(5)}, {item.coords.longitude.toFixed(5)}
            </Text>
            <TouchableOpacity
              style={styles.mapBtn}
              onPress={() => openInMaps(item.coords.latitude, item.coords.longitude)}
              activeOpacity={0.7}
            >
              <Text style={styles.mapBtnText}>Open in Maps</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  // ✅ Normal form now includes Area/Location input + Pin GPS
  const NormalForm = (
    <>
      <Text style={styles.label}>Title</Text>
      <TextInput
        value={title}
        onChangeText={setTitle}
        editable={!busy}
        placeholder="e.g., Oil spill on walkway near Pit 3"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />

      <Text style={styles.label}>Type</Text>
      <View style={styles.pillRow}>
        {TYPES.map((t, i) => (
          <Pill key={`${t}-${i}`} label={t} active={type === t} onPress={() => setType(t)} />
        ))}
      </View>

      {/* ✅ NEW: Area / Location for normal hazards */}
      <Text style={styles.label}>Area / Location (required)</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity
          onPress={pinLocation}
          style={[styles.smallBtn, styles.outlineBtn]}
          activeOpacity={0.7}
          disabled={busy}
        >
          <Text style={styles.outlineBtnText}>{coords ? 'GPS pinned' : 'Pin GPS'}</Text>
        </TouchableOpacity>

        <TextInput
          value={locLabel}
          onChangeText={setLocLabel}
          editable={!busy}
          placeholder="e.g., Plant, Workshop Bay 2, Pit 3, Section C"
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 1 }]}
        />
      </View>

      <Text style={styles.label}>Category</Text>
      <View style={styles.pillRow}>
        {CATEGORIES.map((c, i) => (
          <Pill key={`${c}-${i}`} label={c} active={category === c} onPress={() => setCategory(c)} />
        ))}
      </View>

      <Text style={styles.label}>Severity</Text>
      <View style={styles.pillRow}>
        {SEVERITIES.map((s, i) => (
          <Pill key={`${s}-${i}`} label={s} active={severity === s} onPress={() => setSeverity(s)} />
        ))}
      </View>

      <Text style={styles.label}>Status</Text>
      <View style={styles.pillRow}>
        {STATUSES.map((s, i) => (
          <Pill key={`${s}-${i}`} label={s} active={status === s} onPress={() => setStatus(s)} />
        ))}
      </View>

      <Text style={styles.label}>Description (optional)</Text>
      <TextInput
        value={description}
        onChangeText={setDescription}
        editable={!busy}
        multiline
        placeholder="What happened and what control(s) did you apply…"
        placeholderTextColor={colors.muted}
        style={[styles.input, { minHeight: 90, textAlignVertical: 'top' }]}
      />

      <Text style={styles.label}>What do you think should be done?</Text>
      <TextInput
        value={actionSuggestion}
        onChangeText={setActionSuggestion}
        editable={!busy}
        multiline
        placeholder="E.g., Barricade area, clean spill, raise work order…"
        placeholderTextColor={colors.muted}
        style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]}
      />

      <Text style={styles.label}>Supervisor responsible (optional)</Text>
      <TextInput
        value={supervisorName}
        onChangeText={setSupervisorName}
        editable={!busy}
        placeholder="E.g., John Mokoena (Section Supervisor)"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
    </>
  );

  // ✅ Section 23 form already has Area/Location required (kept)
  const Section23Form = (
    <>
      <Text style={styles.label}>Title</Text>
      <TextInput
        value={title}
        onChangeText={setTitle}
        editable={!busy}
        placeholder="e.g., Section 23 applied at Workshop Bay 2"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />

      <Text style={styles.label}>Type</Text>
      <View style={styles.pillRow}>
        {TYPES.map((t, i) => (
          <Pill key={`${t}-${i}`} label={t} active={type === t} onPress={() => setType(t)} />
        ))}
      </View>

      <Text style={styles.label}>Section 23 status</Text>
      <View style={styles.pillRow}>
        {S23_STATUSES.map((s, i) => (
          <Pill key={`${s}-${i}`} label={s} active={status === s} onPress={() => setStatus(s)} />
        ))}
      </View>

      <Text style={styles.label}>Person who applied / issued Section 23</Text>
      <TextInput
        value={s23IssuedBy}
        onChangeText={setS23IssuedBy}
        editable={!busy}
        placeholder="Full name"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />

      <Text style={styles.label}>Supervisor responsible</Text>
      <TextInput
        value={supervisorName}
        onChangeText={setSupervisorName}
        editable={!busy}
        placeholder="Supervisor name"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />

      <Text style={styles.label}>Area / Location (required)</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity
          onPress={pinLocation}
          style={[styles.smallBtn, styles.outlineBtn]}
          activeOpacity={0.7}
          disabled={busy}
        >
          <Text style={styles.outlineBtnText}>{coords ? 'GPS pinned' : 'Pin GPS'}</Text>
        </TouchableOpacity>

        <TextInput
          value={locLabel}
          onChangeText={setLocLabel}
          editable={!busy}
          placeholder="Type the exact area (required)"
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 1 }]}
        />
      </View>

      <Text style={styles.label}>Problem / Reason for Section 23</Text>
      <TextInput
        value={s23Problem}
        onChangeText={setS23Problem}
        editable={!busy}
        multiline
        placeholder="What was unsafe / what triggered the Section 23?"
        placeholderTextColor={colors.muted}
        style={[styles.input, { minHeight: 90, textAlignVertical: 'top' }]}
      />

      <Text style={styles.label}>How was Section 23 applied?</Text>
      <TextInput
        value={s23HowApplied}
        onChangeText={setS23HowApplied}
        editable={!busy}
        multiline
        placeholder="Describe what was stopped, who was informed, what controls were enforced…"
        placeholderTextColor={colors.muted}
        style={[styles.input, { minHeight: 90, textAlignVertical: 'top' }]}
      />

      <Text style={styles.label}>Was it resolved?</Text>
      <View style={styles.pillRow}>
        {YES_NO.map((v) => (
          <Pill key={v} label={v} active={s23Resolved === v} onPress={() => setS23Resolved(v)} />
        ))}
      </View>

      {s23Resolved === 'Yes' ? (
        <>
          <Text style={styles.label}>How was it solved?</Text>
          <TextInput
            value={s23HowSolved}
            onChangeText={setS23HowSolved}
            editable={!busy}
            multiline
            placeholder="Describe how it was fixed and what made it safe again."
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]}
          />
        </>
      ) : (
        <>
          <Text style={styles.label}>Can it be solved?</Text>
          <TextInput
            value={s23CanBeSolved}
            onChangeText={setS23CanBeSolved}
            editable={!busy}
            placeholder="e.g., Yes, if we isolate power / get a fitter / barricade area"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <Text style={styles.label}>What is needed to solve it?</Text>
          <TextInput
            value={s23WhatNeeded}
            onChangeText={setS23WhatNeeded}
            editable={!busy}
            multiline
            placeholder="Tools, spares, lockout, manpower, permit, engineering check, etc."
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]}
          />
        </>
      )}
    </>
  );

  const Form = useMemo(
    () =>
      showForm ? (
        <View style={styles.card}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: spacing(0.5),
            }}
          >
            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 15 }}>
              {isS23 ? 'New Section 23 report' : 'New report'}
            </Text>

            <TouchableOpacity
              onPress={() => !busy && setShowForm(false)}
              hitSlop={8}
              style={[styles.smallBtn, styles.outlineBtn, { paddingVertical: 6 }]}
            >
              <Text style={styles.outlineBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {isS23 ? Section23Form : NormalForm}

          <Text style={styles.label}>Photo (optional)</Text>
          {imageUri ? (
            <View style={{ alignItems: 'flex-start' }}>
              <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" />
              <TouchableOpacity
                onPress={removeImage}
                style={[styles.smallBtn, styles.outlineBtn]}
                activeOpacity={0.7}
                disabled={busy}
              >
                <Text style={styles.outlineBtnText}>Remove photo</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={pickImage}
              style={[styles.smallBtn, styles.primaryBtn]}
              activeOpacity={0.7}
              disabled={busy}
            >
              <Text style={styles.primaryBtnText}>Choose photo</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={submit}
            activeOpacity={0.8}
            disabled={!canSubmit || busy}
            style={[styles.submitBtn, (!canSubmit || busy) && { opacity: 0.6 }]}
          >
            {busy ? (
              <ActivityIndicator color="#06130A" />
            ) : (
              <Text style={styles.submitText}>{isS23 ? 'Submit Section 23' : 'Submit report'}</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : null,
    [
      showForm,
      busy,
      canSubmit,
      isS23,
      title,
      type,
      category,
      severity,
      description,
      imageUri,
      coords,
      locLabel,
      actionSuggestion,
      supervisorName,
      status,
      s23IssuedBy,
      s23Problem,
      s23HowApplied,
      s23Resolved,
      s23HowSolved,
      s23CanBeSolved,
      s23WhatNeeded,
    ]
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(8) }}
        keyboardShouldPersistTaps="always"
      >
        <Text style={styles.pageTitle}>Hazards & observations</Text>

        {reporterName ? (
          <Text style={styles.subHeader}>
            Reporting as <Text style={styles.highlight}>{reporterName}</Text>
            {reporterRole ? ` (${reporterRole})` : ''}
          </Text>
        ) : (
          <Text style={styles.subHeader}>Name not found. Go back to setup to add your name.</Text>
        )}

        {pendingCount > 0 && (
          <View style={styles.pendingBox}>
            <Text style={styles.pendingText}>Pending offline reports: {pendingCount}</Text>
            <TouchableOpacity
              onPress={handleSyncPending}
              disabled={syncing}
              style={[styles.syncBtn, syncing && { opacity: 0.6 }]}
              activeOpacity={0.8}
            >
              <Text style={styles.syncBtnText}>{syncing ? 'Syncing...' : 'Sync pending reports'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {!showForm && (
          <TouchableOpacity
            onPress={() => setShowForm(true)}
            activeOpacity={0.85}
            style={styles.bigCta}
          >
            <Text style={styles.bigCtaTitle}>
              Report (Hazard / Near Miss / Incident / Leak / Section 23)
            </Text>
            <Text style={styles.bigCtaSub}>Auto date & time stamp • Photo & GPS optional</Text>
          </TouchableOpacity>
        )}

        <View style={styles.searchCard}>
          <Text style={styles.searchTitle}>Search by area name</Text>
          <TextInput
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Type an area (workshop, pit, bay, section…)"
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
          />

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TouchableOpacity
              onPress={useMyLocationForSearch}
              style={[styles.smallBtn, styles.primaryBtn, { flex: 1 }]}
              activeOpacity={0.8}
            >
              <Text style={styles.primaryBtnText}>Use my location to fill area</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setSearchText('')}
              style={[styles.smallBtn, styles.outlineBtn]}
              activeOpacity={0.8}
            >
              <Text style={styles.outlineBtnText}>Clear</Text>
            </TouchableOpacity>
          </View>
        </View>

        {Form}

        <Text style={styles.sectionTitle}>
          {searchText ? `Matching reports (${filteredReports.length})` : 'Recent reports'}
        </Text>

        {filteredReports.length === 0 ? (
          <Text style={{ color: colors.muted, fontStyle: 'italic' }}>No reports found.</Text>
        ) : (
          <View style={{ gap: spacing(1) }}>
            {filteredReports.map((r) => (
              <ReportCard key={`${r.id}-${r.isPending ? 'pending' : 'remote'}`} item={r} />
            ))}
          </View>
        )}
      </ScrollView>

      {!showForm && (
        <TouchableOpacity
          onPress={() => setShowForm(true)}
          activeOpacity={0.9}
          style={styles.fab}
          accessibilityLabel="Report"
        >
          <Text style={styles.fabText}>+</Text>
        </TouchableOpacity>
      )}

      <Modal
        visible={viewerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerVisible(false)}
      >
        <TouchableOpacity
          style={styles.fullscreen}
          activeOpacity={1}
          onPress={() => setViewerVisible(false)}
        >
          {viewerUri ? (
            <>
              <Image
                source={{ uri: viewerUri }}
                style={styles.fullImage}
                resizeMode="contain"
                onLoadStart={() => setViewerLoading(true)}
                onLoadEnd={() => setViewerLoading(false)}
              />
              {viewerLoading && (
                <View style={styles.loadingOverlay}>
                  <ActivityIndicator size="large" color="#fff" />
                </View>
              )}
              <View style={styles.fullHint}>
                <Text style={styles.fullHintText}>Tap to close</Text>
              </View>
            </>
          ) : null}
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  pageTitle: { color: colors.text, fontSize: 18, fontWeight: '900', marginBottom: 4 },
  subHeader: { color: colors.muted, fontSize: 13, marginBottom: spacing(1.5) },
  highlight: { color: colors.primary, fontWeight: '900' },

  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    marginTop: spacing(2),
    marginBottom: spacing(1),
  },

  bigCta: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.75),
    marginBottom: spacing(1.5),
  },
  bigCtaTitle: { color: colors.text, fontSize: 15, fontWeight: '900' },
  bigCtaSub: { color: colors.muted, fontSize: 12, marginTop: 4 },

  searchCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.5),
    marginBottom: spacing(1.5),
  },
  searchTitle: { color: colors.text, fontSize: 14, fontWeight: '900', marginBottom: 6 },
  searchInput: {
    backgroundColor: '#0F151C',
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: spacing(1.25),
    borderRadius: 10,
  },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(1.5),
    marginBottom: spacing(1.5),
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

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 8,
  },
  pillOn: { backgroundColor: colors.primary, borderColor: 'rgba(0,0,0,0.25)' },
  pillOff: { backgroundColor: 'transparent', borderColor: colors.muted },
  pillText: { fontWeight: '800' },
  pillTextOn: { color: '#06130A' },
  pillTextOff: { color: colors.text },

  preview: {
    width: '100%',
    height: 200,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 4,
  },

  smallBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  primaryBtn: { backgroundColor: colors.primary, borderColor: 'rgba(0,0,0,0.2)' },
  primaryBtnText: { color: '#06130A', fontWeight: '900' },
  outlineBtn: { backgroundColor: 'transparent', borderColor: colors.muted },
  outlineBtnText: { color: colors.text, fontWeight: '800' },

  submitBtn: {
    marginTop: spacing(2),
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitText: { color: '#06130A', fontWeight: '900' },

  reportCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(1.5),
  },
  reportTitle: { color: colors.text, fontWeight: '900', fontSize: 15, flex: 1, paddingRight: 8 },

  sevBadge: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999 },
  sevBadgeText: { fontWeight: '900', fontSize: 12 },

  statusBadge: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999 },
  statusBadgeText: { fontWeight: '800', fontSize: 11 },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  metaText: { color: colors.muted, fontSize: 12 },

  reportDesc: { color: colors.text, fontSize: 14, lineHeight: 20, marginTop: 6 },
  actionLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  actionText: { color: colors.text, fontSize: 13, marginTop: 2 },

  reportImage: {
    width: '100%',
    height: 220,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  overlay: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  overlayText: { color: '#fff', fontSize: 12, fontWeight: '800' },

  locRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  locLabel: { color: colors.muted, fontSize: 12, flex: 1, paddingRight: 8 },
  mapBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#0F1720',
  },
  mapBtnText: { color: colors.muted, fontSize: 12, fontWeight: '800' },

  fullscreen: { flex: 1, backgroundColor: 'black', justifyContent: 'center', alignItems: 'center' },
  fullImage: { width: '100%', height: '100%' },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullHint: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  fullHintText: { color: '#fff', fontWeight: '800', fontSize: 12 },

  fab: {
    position: 'absolute',
    right: spacing(2),
    bottom: spacing(2),
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.25)',
  },
  fabText: { color: '#06130A', fontWeight: '900', fontSize: 28, lineHeight: 28 },

  pendingBox: {
    marginBottom: spacing(1.5),
    padding: spacing(1.25),
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: '#0F151C',
  },
  pendingText: { color: colors.text, marginBottom: spacing(1) },
  syncBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 8,
    borderRadius: 999,
    alignItems: 'center',
  },
  syncBtnText: { color: '#06130A', fontWeight: '800', fontSize: 13 },
});