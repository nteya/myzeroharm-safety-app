// screens/HomeScreen.js
import React, { useEffect, useMemo, useState, useRef, useCallback, memo } from 'react';
import {
  View, Text, StyleSheet, FlatList, Dimensions, Pressable, Image, Platform, Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Carousel from 'react-native-reanimated-carousel';
import { Audio } from 'expo-av';

import { app, db, auth } from '../firebase';
import {
  collection, query, orderBy, limit, onSnapshot, deleteDoc, doc, updateDoc, increment,
} from 'firebase/firestore';
import { loadProfile } from '../storage';

const { width } = Dimensions.get('window');

const colors = { bg:'#0B0F14', surface:'#131A22', text:'#E7EEF5', muted:'#A7B4C2', primary:'#00C853', border:'#1E2530' };
const spacing = (n=1)=>8*n;
const radius = 20;
const HEADER_BAR_HEIGHT = 64; // visual bar height (excluding safe area inset)
const ROLE_BOOST = { Supervisor: 25, 'Safety Officer': 22, 'SHE Rep': 18, 'Team Leader': 15 };

const FN_REGION = 'us-central1';
const CLOUD_FN_URL = `https://${FN_REGION}-${app.options.projectId}.cloudfunctions.net/generateSafetyPlan`;

const FALLBACK_TIPS = [
  'Always wear the correct PPE for your task.',
  'Inspect tools before use — guards on, cables intact.',
  'Keep walkways clear to prevent trips and falls.',
  'Use spotters and signals around moving equipment.',
  'Hydrate regularly — fatigue hides mistakes.',
  'Lock out and tag out before maintenance.',
  'Three points of contact on ladders; no top-two rungs.',
  'Shield sparks when grinding/welding; fire watch ready.',
  'Keep emergency routes clear; know your muster point.',
  'Stop and ask if you’re unsure — safety first.',
];

const getInitials = (name = '') =>
  name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() || '').join('');
const palette = ['#5E60CE', '#F72585', '#3A86FF', '#FF006E', '#8338EC', '#FB5607', '#00BFA6'];
const colorFromName = (name = '') => { let sum=0; for (let i=0;i<name.length;i++) sum+=name.charCodeAt(i); return palette[sum % palette.length]; };
const normalizeCompany = (s='') => s.trim().toLowerCase();

function Avatar({ size = 36, name, avatar, ring = true }) {
  const bg = colorFromName(name || '');
  const wrap = {
    width: size, height: size, borderRadius: size / 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: bg, borderWidth: ring ? 2 : 0, borderColor: 'rgba(255,255,255,0.15)',
  };
  if (avatar) {
    return (
      <View style={wrap}>
        <Image source={{ uri: avatar }} style={{ width: size - 4, height: size - 4, borderRadius: (size - 4) / 2 }} />
      </View>
    );
  }
  return <View style={wrap}><Text style={{ color: 'white', fontWeight: '800' }}>{getInitials(name)}</Text></View>;
}

// ---- Memoized PostCard ------------------------------------------------------
const PostCard = memo(function PostCard({
  item,
  isMine,
  avatarToUse,
  onLongDelete,
  onToggleThanks,
  onTogglePlay,
  isActive,
  activePosition,
  activeDuration,
  isPlayingActive,
}) {
  const formatTime = (ms=0)=>{ const s=Math.floor(ms/1000); const m=Math.floor(s/60); const ss=s%60; return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; };
  const progressPct = isActive ? Math.min(100, Math.max(0, (activePosition / Math.max(1, activeDuration)) * 100)) : 0;

  return (
    <Pressable
      onLongPress={() => { if (isMine) onLongDelete(item); }}
      delayLongPress={500}
      style={[styles.postCard, { marginHorizontal: spacing(2) }]}
    >
      <View style={styles.postHeader}>
        <Avatar name={item.author} avatar={avatarToUse} />
        <View style={{ marginLeft: spacing(1.5), flex: 1 }}>
          <Text style={styles.postAuthor}>{item.author}</Text>
          {!!item.role && <Text style={styles.postRole}>{item.role}{item.company ? ` • ${item.company}` : ''}</Text>}
        </View>
        {isMine ? (
          <Pressable onPress={() => onLongDelete(item)} hitSlop={10} style={styles.deleteChip}>
            <Text style={styles.deleteChipText}>Delete</Text>
          </Pressable>
        ) : null}
      </View>

      {!!item.text && <Text style={styles.postText}>{item.text}</Text>}
      {!!item.imageUri && (<Image source={{ uri: item.imageUri }} style={styles.postImage} resizeMode="cover" />)}

      {!!(item.audioUrl) && (
        <View style={styles.audioRow}>
          <Pressable onPress={() => onTogglePlay(item)} hitSlop={10} style={styles.audioPlayBtn}>
            <Text style={styles.audioPlayIcon}>{isActive && isPlayingActive ? '⏸️' : '▶️'}</Text>
          </Pressable>
          <View style={styles.audioProgressWrap}>
            <View style={styles.audioProgressTrack}>
              <View style={[styles.audioProgressFill, { width: `${progressPct}%` }]} />
            </View>
            <Text style={styles.audioTimeText}>
              {isActive
                ? `${formatTime(activePosition)} / ${formatTime(activeDuration)}`
                : `${formatTime(0)} / ${formatTime(item.audioDurationMs || 0)}`}
            </Text>
          </View>
        </View>
      )}

      <View style={styles.reactionsRow}>
        <Pressable onPress={() => onToggleThanks(item.firestoreId)} style={[styles.reactionBtn]}>
          <Text style={[styles.reactionIcon]}>👍</Text>
          <Text style={[styles.reactionText]}>Thanks</Text>
        </Pressable>
        <Text style={styles.reactionCount}>{item.thanks} thanks</Text>
      </View>
    </Pressable>
  );
}, (prev, next) => {
  const keys = ['id','author','role','company','text','imageUri','thanks','audioUrl','audioDurationMs'];
  for (const k of keys) if (prev.item[k] !== next.item[k]) return false;
  if (prev.avatarToUse !== next.avatarToUse) return false;
  if (prev.isMine !== next.isMine) return false;
  if (prev.isActive !== next.isActive) return false;
  if (next.isActive) {
    if (prev.activePosition !== next.activePosition) return false;
    if (prev.activeDuration !== next.activeDuration) return false;
    if (prev.isPlayingActive !== next.isPlayingActive) return false;
  }
  return true;
});

// ---- Screen -----------------------------------------------------------------
export default function HomeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [currentUser, setCurrentUser] = useState({ name:'', role:'', company:'', phone:'', avatar:'' });
  const [tips, setTips] = useState(FALLBACK_TIPS);
  const [loadingTips, setLoadingTips] = useState(false);

  // Firestore posts only (no local cache)
  const [posts, setPosts] = useState([]);

  // Audio
  const soundRef = useRef(null);
  const playLockRef = useRef(false);          // serialize play/pause to prevent race/echo
  const tapDebounceRef = useRef(0);           // debounce rapid taps
  const [playingId, setPlayingId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(1);

  // Audio init/cleanup
  useEffect(() => {
    (async () => { try { await Audio.setAudioModeAsync({ playsInSilentModeIOS: true }); } catch {} })();
    return () => { try { soundRef.current?.unloadAsync(); } catch {} };
  }, []);

  const onStatus = useCallback((st) => {
    if (!st?.isLoaded) return;
    if (typeof st.positionMillis === 'number') setPosition(st.positionMillis);
    if (typeof st.durationMillis === 'number' && st.durationMillis > 0) setDuration(st.durationMillis);
    if (st.didJustFinish) {
      // End: stop, unload, clear state — no auto-replay
      setIsPlaying(false);
      setPlayingId(null);
      const s = soundRef.current;
      soundRef.current = null;
      (async () => {
        try { await s?.stopAsync(); } catch {}
        try { await s?.unloadAsync(); } catch {}
      })();
    }
  }, []);

  const stopAndUnload = useCallback(async () => {
    const s = soundRef.current;
    soundRef.current = null;
    if (!s) return;
    try { await s.stopAsync(); } catch {}
    try { await s.unloadAsync(); } catch {}
  }, []);

  const togglePlay = useCallback(async (item) => {
    // Debounce taps (250ms)
    const now = Date.now();
    if (now - tapDebounceRef.current < 250) return;
    tapDebounceRef.current = now;

    // Serialize async ops
    if (playLockRef.current) return;
    playLockRef.current = true;

    try {
      const uri = item.audioUrl;
      if (!uri) return;

      // Same item toggles pause/play
      if (playingId === item.id && soundRef.current) {
        const status = await soundRef.current.getStatusAsync().catch(() => null);
        if (status?.isLoaded) {
          if (status.isPlaying) {
            await soundRef.current.pauseAsync();
            setIsPlaying(false);
          } else {
            await soundRef.current.playAsync();
            setIsPlaying(true);
          }
        }
        return;
      }

      // New item: stop previous completely first
      await stopAndUnload();

      // Preload without auto-play, no loop, frequent updates
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: false, isLooping: false, progressUpdateIntervalMillis: 250 }
      );
      sound.setOnPlaybackStatusUpdate(onStatus);
      soundRef.current = sound;

      // Reset UI counters; use server-provided duration until we get real one
      setPlayingId(item.id);
      setIsPlaying(true);
      setPosition(0);
      if (item.audioDurationMs) setDuration(item.audioDurationMs);

      // Start playback
      await sound.playAsync();
    } catch (e) {
      console.log('Audio error', e?.message || e);
      // In case of failure, ensure state is sane
      setIsPlaying(false);
      setPlayingId(null);
      await stopAndUnload();
    } finally {
      playLockRef.current = false;
    }
  }, [onStatus, playingId, stopAndUnload]);

  // Load latest profile (server preferred)
  useEffect(() => {
    (async () => {
      try {
        const p = await loadProfile({ preferServer: true });
        setCurrentUser({ name: p.name || 'My Profile', role: p.role || '', company: p.company || '', phone: p.phone || '', avatar: p.avatar || '' });
      } catch {}
    })();
  }, []);

  // Firestore realtime stream for posts
  useEffect(() => {
    const q = query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(200));
    const unsub = onSnapshot(q, (snap) => {
      const arr = snap.docs.map((d) => {
        const data = d.data() || {};
        const created = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
        return {
          id: data.id || d.id,
          firestoreId: d.id,
          uid: data.uid || null,
          author: data.authorName || data.author || 'Unknown',
          role: data.role || '',
          avatar: data.avatar || data.photoURL || '',
          company: data.company || '',
          text: data.text || '',
          imageUri: data.imageUrl || '',
          audioUrl: data.audioUrl || '',
          audioDurationMs: data.audioDurationMs || null,   // <-- for early duration display
          thanks: data.thanks || 0,
          createdAt: created,
        };
      });
      setPosts(arr);
    }, (e) => console.log('posts stream error', e?.message || e));
    return () => unsub && unsub();
  }, []);

  // Tips (daily cached by function; we just fetch)
  useEffect(() => {
    const loadDailyTips = async () => {
      setLoadingTips(true);
      try {
        const now = new Date();
        const yyyy = now.getFullYear(); const mm = String(now.getMonth()+1).padStart(2,'0'); const dd = String(now.getDate()).padStart(2,'0');
        const dayStr = `${yyyy}-${mm}-${dd}`;
        const res = await fetch(CLOUD_FN_URL, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ mode:'tips', date:dayStr, locale:'en' }) });
        const json = await res.json().catch(()=>({}));
        const list = Array.isArray(json?.data?.tips) ? json.data.tips : FALLBACK_TIPS;
        setTips(list.slice(0,10));
      } catch {
        setTips(FALLBACK_TIPS);
      } finally {
        setLoadingTips(false);
      }
    };
    loadDailyTips();
  }, []);

  const onLongDelete = useCallback((post) => {
    const myUid = auth.currentUser?.uid || null;
    const canDeleteRemote = post.firestoreId && myUid && post.uid === myUid;

    Alert.alert('Delete post?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            if (canDeleteRemote) {
              await deleteDoc(doc(db, 'posts', post.firestoreId));
            } else {
              Alert.alert('Cannot delete', 'You can only delete your own post.');
            }
          } catch (e) { Alert.alert('Delete error', String(e?.message || e)); }
        },
      },
    ]);
  }, []);

  // Very simple thanks: +1 on tap (optimistic)
  const onToggleThanks = useCallback(async (firestoreId) => {
    try {
      setPosts((prev) => prev.map(p => p.firestoreId === firestoreId ? { ...p, thanks: (p.thanks || 0) + 1 } : p));
      await updateDoc(doc(db, 'posts', firestoreId), { thanks: increment(1) });
    } catch (e) {
      setPosts((prev) => prev.map(p => p.firestoreId === firestoreId ? { ...p, thanks: Math.max(0, (p.thanks || 1) - 1) } : p));
    }
  }, []);

  // Ranking (single source)
  const combinedRanked = useMemo(() => {
    const now = Date.now();
    const meCompanyKey = normalizeCompany(currentUser.company || '');
    return (posts || []).map((p) => {
      const ageHrs = Math.max(0, (now - (p.createdAt || 0)) / 3_600_000);
      const sameCompany = normalizeCompany(p.company || '') === meCompanyKey;
      const roleBoost = ROLE_BOOST[p.role] || 0;
      const recency = Math.max(0, 48 - ageHrs);
      const thanksBoost = Math.min(20, p.thanks || 0) * 0.5;
      const score = (sameCompany ? 100 : 0) + roleBoost + recency + thanksBoost;
      return { ...p, __score: score };
    }).sort((a, b) => b.__score - a.__score || (b.createdAt || 0) - (a.createdAt || 0));
  }, [posts, currentUser.company]);

  const navigationProfile = useCallback(() => navigation.navigate('Profile'), [navigation]);

  const resolveAvatarForPost = (p, me) => p.avatar || ((p.author || '').trim().toLowerCase() === (me?.name || '').trim().toLowerCase() ? me.avatar || '' : '');

  const renderItem = useCallback(({ item }) => {
    const myUid = auth.currentUser?.uid || null;
    const isMine = (myUid && item.uid === myUid) || ((item.author || '').trim().toLowerCase() === (currentUser.name || '').trim().toLowerCase());
    const avatarToUse = resolveAvatarForPost(item, currentUser);

    const isActive = playingId === item.id;
    return (
      <PostCard
        item={item}
        isMine={isMine}
        avatarToUse={avatarToUse}
        onLongDelete={onLongDelete}
        onToggleThanks={onToggleThanks}
        onTogglePlay={togglePlay}
        isActive={isActive}
        activePosition={isActive ? position : 0}
        activeDuration={isActive ? duration : (item.audioDurationMs || 1)}
        isPlayingActive={isActive ? isPlaying : false}
      />
    );
  }, [currentUser, playingId, position, duration, isPlaying, onToggleThanks, onLongDelete, togglePlay]);

  // Layout values based on safe area (prevents overlapping the phone status bar)
  const headerTotalHeight = HEADER_BAR_HEIGHT + insets.top;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={['left','right','bottom']}>
      {/* Sticky header that respects safe-area top inset */}
      <View style={[styles.stickyHeader, { paddingTop: insets.top, height: headerTotalHeight }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>MyZeroHarm</Text>
          <Text style={styles.subtitle}>Safety is everyone’s responsibility</Text>
        </View>
        <Pressable onPress={navigationProfile} hitSlop={10} style={styles.avatarWrap}>
          <Avatar size={40} name={currentUser.name} avatar={currentUser.avatar} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('ComposePost')} accessibilityLabel="New post" style={styles.plusBtn} hitSlop={16}>
          <Text style={styles.plusText}>＋</Text>
        </Pressable>
      </View>

      <FlatList
        data={combinedRanked}
        keyExtractor={(item) => item.firestoreId || item.id}
        renderItem={renderItem}
        ListHeaderComponent={(
          <View style={{ paddingHorizontal: spacing(2) }}>
            <View style={styles.carouselContainer}>
              <Carousel
                loop autoPlay autoPlayInterval={10000}
                width={width - spacing(2)} height={100}
                data={tips} scrollAnimationDuration={900}
                renderItem={({ item }) => (<View style={styles.tipCard}><Text style={styles.tipText}>{item}</Text></View>)}
              />
              {loadingTips ? (<Text style={{ color: colors.muted, marginTop: 6, fontSize: 12 }}>Loading today’s tips…</Text>) : null}
            </View>

            {/* Top actions */}
            <View style={styles.actionRow}>
              <Pressable accessibilityLabel="Start Task Safety" style={[styles.actionPill, styles.actionPrimary]} onPress={() => navigation.navigate('TaskSafety')}>
                <Text style={styles.actionPrimaryText}>Start Task Safety</Text>
              </Pressable>
              <Pressable accessibilityLabel="Report Hazard" style={[styles.actionPill, styles.actionOutline]} onPress={() => navigation.navigate('ReportHazard')}>
                <Text style={styles.actionOutlineText}>Report Hazard</Text>
              </Pressable>
            </View>

            {/* Weekly assessment button (adjust label if using daily instead) */}
            <Pressable
              accessibilityLabel="Weekly Safety Assessment"
              style={[styles.assessmentBtn]}
              onPress={() => navigation.navigate('Assessment')}
            >
              <Text style={styles.assessmentBtnText}>Weekly Safety Assessment</Text>
              <Text style={styles.assessmentBtnSub}>15 True/False • 15 Multiple Choice • Results 7pm</Text>
            </Pressable>

            <Text style={styles.sectionTitle}>Latest from Supervisors & Safety Reps</Text>
          </View>
        )}
        contentContainerStyle={{
          paddingBottom: spacing(6),
          paddingTop: headerTotalHeight + spacing(1),
        }}
        // PERF TUNING:
        initialNumToRender={6}
        maxToRenderPerBatch={8}
        windowSize={9}
        updateCellsBatchingPeriod={30}
        removeClippedSubviews={Platform.OS === 'android'}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  stickyHeader: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing(2),
    flexDirection: 'row', alignItems: 'center',
    borderBottomWidth: 1, borderBottomColor: colors.border, zIndex: 10,
  },
  avatarWrap: { marginLeft: spacing(2) },
  title: { color: colors.text, fontSize: 20, fontWeight: '900', lineHeight: 24 },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 2 },

  plusBtn: {
    marginLeft: spacing(1),
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)',
  },
  plusText: { color: '#06130A', fontSize: 24, lineHeight: 24, fontWeight: '900' },

  // Carousel
  carouselContainer: { marginBottom: spacing(2), marginTop: spacing(1) },
  tipCard: {
    backgroundColor: colors.surface, borderRadius: radius, padding: spacing(2),
    borderWidth: 1, borderColor: colors.border, justifyContent: 'center', minHeight: 100,
  },
  tipText: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },

  actionRow: { flexDirection: 'row', gap: spacing(1), marginBottom: spacing(1.5) },
  actionPill: { flex: 1, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 999, alignItems: 'center', borderWidth: 1 },
  actionPrimary: { backgroundColor: colors.primary, borderColor: 'rgba(0,0,0,0.2)' },
  actionPrimaryText: { color: '#06130A', fontWeight: '900', fontSize: 14, letterSpacing: 0.2 },
  actionOutline: { backgroundColor: 'transparent', borderColor: colors.muted },
  actionOutlineText: { color: colors.text, fontWeight: '800', fontSize: 14 },

  assessmentBtn: {
    borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, paddingVertical: 14, paddingHorizontal: 16,
    marginBottom: spacing(2),
  },
  assessmentBtnText: { color: colors.text, fontWeight: '900', fontSize: 15 },
  assessmentBtnSub: { color: colors.muted, fontSize: 12, marginTop: 4 },

  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: spacing(1), marginTop: spacing(1) },

  postCard: { backgroundColor: colors.surface, padding: spacing(2), borderRadius: 14, borderColor: colors.border, borderWidth: 1, marginVertical: spacing(1) },
  postHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(1) },
  postAuthor: { color: colors.text, fontWeight: '800', fontSize: 15 },
  postRole: { color: colors.muted, fontSize: 12, marginTop: 2 },
  postText: { color: colors.text, fontSize: 14, lineHeight: 22, marginTop: spacing(0.5) },
  postImage: { width: '100%', height: 200, borderRadius: 12, marginTop: spacing(1), borderWidth: 1, borderColor: colors.border },

  audioRow: {
    marginTop: spacing(1), padding: spacing(1), borderRadius: 10,
    backgroundColor: '#0F1720', borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center',
  },
  audioPlayBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: '#0F151C',
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginRight: spacing(1),
  },
  audioPlayIcon: { color: colors.text, fontSize: 16 },
  audioProgressWrap: { flex: 1 },
  audioProgressTrack: { height: 6, borderRadius: 999, backgroundColor: '#11202B', overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  audioProgressFill: { height: '100%', borderRadius: 999, backgroundColor: colors.primary },
  audioTimeText: { color: colors.muted, fontSize: 11, marginTop: 6, fontWeight: '700' },

  reactionsRow: { marginTop: spacing(1.25), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reactionBtn: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14,
    borderWidth: 2, borderColor: colors.muted, backgroundColor: 'transparent',
  },
  reactionIcon: { color: colors.muted, marginRight: 8, fontSize: 16 },
  reactionText: { color: colors.muted, fontWeight: '700' },
  reactionCount: { color: colors.muted, fontSize: 13 },

  deleteChip: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: '#2A1010' },
  deleteChipText: { color: '#FFB4B4', fontWeight: '800', fontSize: 12 },
});
