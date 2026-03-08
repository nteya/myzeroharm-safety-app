// screens/HomeScreen.js
import React, { useEffect, useMemo, useState, useRef, useCallback, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Dimensions,
  Pressable,
  Image,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
  TouchableOpacity,
  Linking,
  TextInput,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Carousel from 'react-native-reanimated-carousel';
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';

import { app, db, auth, storage } from '../firebase';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  deleteDoc,
  doc,
  updateDoc,
  increment,
  arrayUnion,
  addDoc,
  serverTimestamp,
  writeBatch, // ✅ NEW (for 7-day cleanup)
} from 'firebase/firestore';
import { ref as sRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadProfile } from '../storage';

const { width } = Dimensions.get('window');

/**
 * ✅ Light theme (keep your existing look)
 */
const colors = {
  bg: '#F7F4F6',
  surface: '#FFFFFF',
  text: '#0F172A',
  muted: '#64748B',
  primary: '#00C853',
  border: '#E6E1E7',
  shadow: 'rgba(15, 23, 42, 0.08)',
};

const spacing = (n = 1) => 8 * n;
const radius = 20;
const likeBlue = '#3A86FF';
const HEADER_BAR_HEIGHT = 64;

const ROLE_BOOST = {
  Supervisor: 25,
  'Safety Officer': 22,
  'SHE Rep': 18,
  'Team Leader': 15,
};

const SKP_BLUE = '#003A8F';

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

const THANKS_KEY = 'THANKS_LIKED_V1';
const LIKER_ID_KEY = 'LIKER_ID_V1';

// ✅ pending queue for campaign comments (offline/bad network)
const PENDING_CAMPAIGN_COMMENTS_KEY = 'PENDING_CAMPAIGN_COMMENTS_V1';

// ✅ DELETE POSTS AFTER 7 DAYS (not campaign)
const POST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const getInitials = (name = '') =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('');

const palette = ['#5E60CE', '#F72585', '#3A86FF', '#FF006E', '#8338EC', '#FB5607', '#00BFA6'];
const colorFromName = (name = '') => {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return palette[sum % palette.length];
};
const normalizeCompany = (s = '') => s.trim().toLowerCase();

/** Initials-only avatar (no photos) */
function Avatar({ size = 36, name }) {
  const bg = colorFromName(name || '');
  const wrap = {
    width: size,
    height: size,
    borderRadius: size / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: bg,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
  };
  return (
    <View style={wrap}>
      <Text style={{ color: 'white', fontWeight: '800' }}>{getInitials(name)}</Text>
    </View>
  );
}

/** Special SKP avatar used ONLY for campaign card */
function SkpAvatar({ size = 36 }) {
  const wrap = {
    width: size,
    height: size,
    borderRadius: size / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B1E45',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
  };
  return (
    <View style={wrap}>
      <Text style={{ color: 'white', fontWeight: '900' }}>SKP</Text>
    </View>
  );
}

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

/* ---------------- Hazard badge helpers (match hazard screen style) ---------------- */
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

const statusColor = (st) => {
  switch (st) {
    case 'Solved':
      return { bg: '#0F4D32', text: '#E7FBEA' };
    case 'No action needed':
      return { bg: '#374151', text: '#E5E7EB' };
    default:
      return { bg: '#8B6500', text: '#FFF7E6' }; // Action needed
  }
};
/* ------------------------------------------------------------------------------- */

// ✅ Roles that should show designation + company on post cards (minimal)
const SPECIAL_ROLES = new Set(['Supervisor', 'SHE Rep', 'Safety Officer', 'Team Leader']);

// ---- Memoized PostCard ------------------------------------------------------
const PostCard = memo(
  function PostCard({
    item,
    isMine,
    onLongDelete,
    onToggleThanks,
    onTogglePlay,
    isActive,
    activePosition,
    activeDuration,
    isPlayingActive,
    isLoadingAudioActive,
    onOpenImage,
    isLiked,
  }) {
    const formatTime = (ms = 0) => {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const ss = s % 60;
      return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    };
    const progressPct = isActive
      ? Math.min(100, Math.max(0, (activePosition / Math.max(1, activeDuration)) * 100))
      : 0;

    // ✅ Minimal meta line:
    // - SPECIAL roles: "Role • Company"
    // - Everyone else: "Company" only (name always shows above)
    const role = (item.role || '').trim();
    const company = (item.company || '').trim();
    const showRole = !!role && SPECIAL_ROLES.has(role);
    const metaLine = showRole ? `${role}${company ? ` • ${company}` : ''}` : company;

    return (
      <Pressable
        onLongPress={() => {
          if (isMine) onLongDelete(item);
        }}
        delayLongPress={500}
        style={[styles.postCard, { marginHorizontal: spacing(2) }]}
      >
        <View style={styles.postHeader}>
          <Avatar name={item.author} />
          <View style={{ marginLeft: spacing(1.5), flex: 1 }}>
            <Text style={styles.postAuthor}>{item.author}</Text>

            {!!metaLine ? (
              <Text style={styles.postRole}>{metaLine}</Text>
            ) : null}
          </View>

          {isMine ? (
            <Pressable onPress={() => onLongDelete(item)} hitSlop={10} style={styles.deleteChip}>
              <Text style={styles.deleteChipText}>Delete</Text>
            </Pressable>
          ) : null}
        </View>

        {!!item.text && <Text style={styles.postText}>{item.text}</Text>}

        {!!item.imageUri && (
          <TouchableOpacity
            onPress={() => onOpenImage(item.imageUri)}
            activeOpacity={0.9}
            style={{ marginTop: spacing(1) }}
          >
            <Image source={{ uri: item.imageUri }} style={styles.postImage} resizeMode="cover" />
            <View style={styles.overlay}>
              <Text style={styles.overlayText}>Tap to view full</Text>
            </View>
          </TouchableOpacity>
        )}

        {!!item.audioUrl && (
          <View style={styles.audioRow}>
            <Pressable onPress={() => onTogglePlay(item)} hitSlop={10} style={styles.audioPlayBtn}>
              {isActive && isLoadingAudioActive ? (
                <ActivityIndicator />
              ) : (
                <Text style={styles.audioPlayIcon}>{isActive && isPlayingActive ? '⏸️' : '▶️'}</Text>
              )}
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

        {/* ✅ Normal posts remain THANKS-ONLY */}
        <View style={styles.reactionsRow}>
          <Pressable
            onPress={() => onToggleThanks(item)}
            style={[
              styles.reactionBtn,
              isLiked && { borderColor: likeBlue, backgroundColor: 'rgba(58,134,255,0.08)' },
            ]}
          >
            <Text style={[styles.reactionIcon, isLiked && { color: likeBlue }]}>👍</Text>
            <Text style={[styles.reactionText, isLiked && { color: likeBlue }]}>Thanks</Text>
          </Pressable>
          <Text style={styles.reactionCount}>{item.thanks} thanks</Text>
        </View>
      </Pressable>
    );
  },
  (prev, next) => {
    const keys = ['id', 'author', 'role', 'company', 'text', 'imageUri', 'thanks', 'audioUrl', 'audioDurationMs'];
    for (const k of keys) if (prev.item[k] !== next.item[k]) return false;
    if (prev.isMine !== next.isMine) return false;
    if (prev.isActive !== next.isActive) return false;
    if (prev.isLiked !== next.isLiked) return false;
    if (prev.isLoadingAudioActive !== next.isLoadingAudioActive) return false;
    if (next.isActive) {
      if (prev.activePosition !== next.activePosition) return false;
      if (prev.activeDuration !== next.activeDuration) return false;
      if (prev.isPlayingActive !== next.isPlayingActive) return false;
    }
    return true;
  }
);

// ✅ HazardCard
const HazardCard = memo(function HazardCard({ item, onOpenImage, onOpenMaps }) {
  const sev = badgeColor(item.severity || 'Low');
  const st = statusColor(item.status || 'Action needed');
  const uri = item.imageUrl || item.imageUri || item.image || '';
  const hasCoords =
    item?.coords &&
    typeof item.coords.latitude === 'number' &&
    typeof item.coords.longitude === 'number';

  const nameLabel = item.reporterName || 'Anonymous';

  return (
    <View style={[styles.postCard, { marginHorizontal: spacing(2) }]}>
      <View style={styles.hzTopRow}>
        <Text style={styles.hzTitle} numberOfLines={2}>
          {item.title || 'Hazard report'}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={[styles.hzStatusBadge, { backgroundColor: st.bg }]}>
            <Text style={[styles.hzStatusBadgeText, { color: st.text }]}>
              {item.status || 'Action needed'}
            </Text>
          </View>
          <View style={[styles.hzSevBadge, { backgroundColor: sev.bg }]}>
            <Text style={[styles.hzSevBadgeText, { color: sev.text }]}>{item.severity || 'Low'}</Text>
          </View>
        </View>
      </View>

      <View style={styles.hzMetaRow}>
        {!!item.type && <Text style={styles.hzMetaText}>• {item.type}</Text>}
        {!!item.category && <Text style={styles.hzMetaText}>• {item.category}</Text>}
        <Text style={styles.hzMetaText}>• Reported by {nameLabel}</Text>
        {!!item.supervisorName && <Text style={styles.hzMetaText}>• Supervisor: {item.supervisorName}</Text>}
      </View>

      {!!item.description && <Text style={styles.postText}>{item.description}</Text>}

      {!!item.actionSuggestion && (
        <View style={{ marginTop: 6 }}>
          <Text style={styles.hzActionLabel}>Suggested action:</Text>
          <Text style={styles.postText}>{item.actionSuggestion}</Text>
        </View>
      )}

      {!!uri && (
        <TouchableOpacity onPress={() => onOpenImage(uri)} activeOpacity={0.9} style={{ marginTop: spacing(1) }}>
          <Image source={{ uri }} style={styles.postImage} resizeMode="cover" />
          <View style={styles.overlay}>
            <Text style={styles.overlayText}>Tap to view full</Text>
          </View>
        </TouchableOpacity>
      )}

      {(item.locationText || hasCoords) && (
        <View style={styles.hzLocRow}>
          <Text style={styles.hzLocText} numberOfLines={2}>
            📍{' '}
            {item.locationText ||
              (hasCoords
                ? `${item.coords.latitude.toFixed(5)}, ${item.coords.longitude.toFixed(5)}`
                : '')}
          </Text>

          {hasCoords ? (
            <TouchableOpacity
              onPress={() => onOpenMaps(item.coords.latitude, item.coords.longitude)}
              style={styles.hzMapBtn}
              activeOpacity={0.75}
            >
              <Text style={styles.hzMapBtnText}>Open in Maps</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
});

// ✅ Campaign card (ONLY ONE shown)
const CampaignCard = memo(function CampaignCard({
  campaign,
  onOpenImage,
  onPressComments,
  onToggleThanks,
  isLiked,
  // ✅ NEW
  isExpanded,
  onToggleExpanded,
}) {
  const title = campaign?.title || 'Campaign of the Week';
  const text = campaign?.text || '';
  const imageUri = campaign?.imageUri || '';
  const audioUrl = campaign?.audioUrl || '';

  const showMoreNeeded = (text || '').trim().length > 220;

  return (
    <View style={styles.campaignCard}>
      <View style={styles.campaignHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
          <SkpAvatar size={36} />
          <View style={{ marginLeft: 10, flex: 1 }}>
            <Text style={styles.campaignAuthor}>SKP</Text>
            <Text style={styles.campaignBadgeLine}>Campaign of the Week</Text>
          </View>
        </View>

        <View style={styles.pinnedChip}>
          <Text style={styles.pinnedChipText}>PINNED</Text>
        </View>
      </View>

      <Text style={styles.campaignTitle}>{title}</Text>

      {!!text && (
        <>
          <Text
            style={styles.postText}
            numberOfLines={isExpanded ? undefined : 4}
          >
            {text}
          </Text>

          {showMoreNeeded ? (
            <Pressable onPress={onToggleExpanded} style={styles.showMoreBtn} hitSlop={10}>
              <Text style={styles.showMoreText}>{isExpanded ? 'Show less' : 'Show more'}</Text>
            </Pressable>
          ) : null}
        </>
      )}

      {!!imageUri && (
        <TouchableOpacity onPress={() => onOpenImage(imageUri)} activeOpacity={0.9} style={{ marginTop: spacing(1) }}>
          <Image source={{ uri: imageUri }} style={styles.postImage} resizeMode="cover" />
          <View style={styles.overlay}>
            <Text style={styles.overlayText}>Tap to view full</Text>
          </View>
        </TouchableOpacity>
      )}

      {!!audioUrl && (
        <View style={styles.campaignAudioHint}>
          <Text style={styles.campaignAudioHintText}>🎙️ Voice note attached</Text>
        </View>
      )}

      <View style={styles.campaignActionsRow}>
        <Pressable
          onPress={() => onToggleThanks(campaign)}
          style={[
            styles.reactionBtn,
            styles.campaignBtn,
            isLiked && { borderColor: likeBlue, backgroundColor: 'rgba(58,134,255,0.08)' },
          ]}
        >
          <Text style={[styles.reactionIcon, isLiked && { color: likeBlue }]}>👍</Text>
          <Text style={[styles.reactionText, isLiked && { color: likeBlue }]}>Thanks</Text>
        </Pressable>

        <Pressable onPress={onPressComments} style={styles.campaignCommentBtn}>
          <Text style={styles.campaignCommentBtnText}>💬 Comments</Text>
        </Pressable>
      </View>

      <Text style={styles.campaignCounts}>{campaign?.thanks || 0} thanks</Text>
    </View>
  );
});

// ---- Screen -----------------------------------------------------------------
export default function HomeScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [currentUser, setCurrentUser] = useState({ name: '', company: '' });
  const [tips, setTips] = useState(FALLBACK_TIPS);
  const [loadingTips, setLoadingTips] = useState(false);

  const [likerId, setLikerId] = useState(null);

  const [posts, setPosts] = useState([]);
  const [hazardsFeed, setHazardsFeed] = useState([]);

  // ✅ single active campaign
  const [activeCampaignPinned, setActiveCampaignPinned] = useState(null);

  // ✅ NEW: expanded/collapsed state for pinned campaign text
  const [campaignExpanded, setCampaignExpanded] = useState(false);

  const [likedSet, setLikedSet] = useState(new Set());

  const [viewerUri, setViewerUri] = useState('');
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);

  // audio player (for normal posts)
  const soundRef = useRef(null);
  const playLockRef = useRef(false);
  const tapDebounceRef = useRef(0);
  const [playingId, setPlayingId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(1);
  const [audioLoadingId, setAudioLoadingId] = useState(null);

  // ✅ campaign comments modal (facebook-style)
  const [campaignModalVisible, setCampaignModalVisible] = useState(false);
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [campaignComments, setCampaignComments] = useState([]);

  const [commentText, setCommentText] = useState('');
  const [commentImageUri, setCommentImageUri] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const commentsUnsubRef = useRef(null);
  const commentSyncTimerRef = useRef(null);

  const openImage = useCallback((uri) => {
    if (!uri) return;
    setViewerUri(uri);
    setViewerVisible(true);
  }, []);

  const openInMaps = useCallback((lat, lon) => {
    const url = `https://www.google.com/maps?q=${lat},${lon}`;
    Linking.openURL(url).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      } catch {}
    })();
    return () => {
      try {
        soundRef.current?.unloadAsync();
      } catch {}
    };
  }, []);

  const onStatus = useCallback((st) => {
    if (!st?.isLoaded) return;
    if (typeof st.positionMillis === 'number') setPosition(st.positionMillis);
    if (typeof st.durationMillis === 'number' && st.durationMillis > 0) setDuration(st.durationMillis);
    if (st.didJustFinish) {
      setIsPlaying(false);
      setPlayingId(null);
      const s = soundRef.current;
      soundRef.current = null;
      (async () => {
        try {
          await s?.stopAsync();
        } catch {}
        try {
          await s?.unloadAsync();
        } catch {}
      })();
    }
  }, []);

  const stopAndUnload = useCallback(async () => {
    const s = soundRef.current;
    soundRef.current = null;
    if (!s) return;
    try {
      await s.stopAsync();
    } catch {}
    try {
      await s.unloadAsync();
    } catch {}
  }, []);

  const togglePlay = useCallback(
    async (item) => {
      const now = Date.now();
      if (now - tapDebounceRef.current < 250) return;
      tapDebounceRef.current = now;

      if (playLockRef.current) return;
      playLockRef.current = true;

      try {
        const uri = item.audioUrl;
        if (!uri) return;

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

        await stopAndUnload();

        setAudioLoadingId(item.id);
        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: false, isLooping: false, progressUpdateIntervalMillis: 200 }
        );
        sound.setOnPlaybackStatusUpdate(onStatus);
        soundRef.current = sound;

        setPlayingId(item.id);
        setIsPlaying(true);
        setPosition(0);
        if (item.audioDurationMs) setDuration(item.audioDurationMs);

        await sound.playAsync();
      } catch (e) {
        Alert.alert('Audio error', friendlyError(e, 'Audio'));
        setIsPlaying(false);
        setPlayingId(null);
        await stopAndUnload();
      } finally {
        setAudioLoadingId(null);
        playLockRef.current = false;
      }
    },
    [onStatus, playingId, stopAndUnload]
  );

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(THANKS_KEY);
        if (raw) setLikedSet(new Set(JSON.parse(raw)));
      } catch {}
    })();
  }, []);

  const persistLikedSet = useCallback(async (setObj) => {
    try {
      await AsyncStorage.setItem(THANKS_KEY, JSON.stringify([...setObj]));
    } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const existing = await AsyncStorage.getItem(LIKER_ID_KEY);
        if (existing) {
          setLikerId(existing);
          return;
        }
        const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await AsyncStorage.setItem(LIKER_ID_KEY, id);
        setLikerId(id);
      } catch {}
    })();
  }, []);

  // ✅ Load user profile (normal behavior)
  useEffect(() => {
    (async () => {
      try {
        const p = await loadProfile({ preferServer: true });
        setCurrentUser({
          name: p?.name || p?.fullName || 'Anonymous',
          company: p?.company || '',
        });
      } catch {
        setCurrentUser({ name: 'Anonymous', company: '' });
      }
    })();
  }, []);

  // ✅ Posts snapshot (extracts normal posts + single pinned campaign)
  // ✅ ALSO auto-deletes non-campaign posts after 7 days
  useEffect(() => {
    const qy = query(collection(db, 'posts'), orderBy('createdAt', 'desc'), limit(250));

    const unsub = onSnapshot(
      qy,
      async (snap) => {
        const nowMs = Date.now();
        const cutoffMs = nowMs - POST_TTL_MS;

        const arr = snap.docs.map((d) => {
          const data = d.data() || {};
          const created = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
          return {
            id: data.id || d.id,
            firestoreId: d.id,
            uid: data.uid || null,
            author: data.authorName || data.author || 'Unknown',
            role: data.role || '',
            company: data.company || '',
            text: data.text || '',
            title: data.title || '',
            type: data.type || 'normal',
            pinned: !!data.pinned,
            imageUri: data.imageUrl || '',
            audioUrl: data.audioUrl || '',
            audioDurationMs: data.audioDurationMs || null,
            thanks: data.thanks || 0,
            likedBy: Array.isArray(data.likedBy) ? data.likedBy : [],
            createdAt: created,
          };
        });

        // ✅ Delete expired NON-campaign posts (firestore cleanup)
        try {
          const expired = snap.docs.filter((d) => {
            const data = d.data() || {};
            const type = data.type || 'normal';
            if (type === 'campaign') return false; // never delete campaign here
            const created = data.createdAt?.toMillis ? data.createdAt.toMillis() : null;
            if (!created) return false;
            return created < cutoffMs;
          });

          if (expired.length > 0) {
            const batch = writeBatch(db);
            // safety: keep within batch limits
            expired.slice(0, 450).forEach((d) => batch.delete(d.ref));
            await batch.commit();
          }
        } catch {
          // if delete fails, we still hide them in UI below
        }

        // ✅ Filter expired non-campaign from UI so list stays clean
        const visible = arr.filter((p) => {
          if ((p.type || 'normal') === 'campaign') return true;
          const created = typeof p.createdAt === 'number' ? p.createdAt : 0;
          return created >= cutoffMs;
        });

        // normal posts
        setPosts(visible.filter((p) => (p.type || 'normal') !== 'campaign'));

        // ✅ only one campaign: latest pinned campaign wins
        const latestPinned =
          visible
            .filter((p) => p.type === 'campaign' && p.pinned)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;

        setActiveCampaignPinned(latestPinned);

        // ✅ reset collapsed state when campaign changes
        setCampaignExpanded(false);
      },
      () => {}
    );

    return () => unsub && unsub();
  }, []);

  // ✅ Hazards → Home feed
  useEffect(() => {
    const qy = query(collection(db, 'hazards'), orderBy('createdAtMs', 'desc'), limit(60));
    const unsub = onSnapshot(
      qy,
      (snap) => {
        const arr = snap.docs.map((d) => {
          const data = d.data() || {};
          const createdAtMs =
            (data.createdAt?.toMillis && data.createdAt.toMillis()) || data.createdAtMs || Date.now();

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
            reporterName: data.reporterName || '',
            reporterRole: data.reporterRole || '',

            actionSuggestion: data.actionSuggestion || '',
            supervisorName: data.supervisorName || data.supervisor || '',
            status: data.status || 'Action needed',

            createdAtMs,
          };
        });
        setHazardsFeed(arr);
      },
      () => {}
    );
    return () => unsub && unsub();
  }, []);

  useEffect(() => {
    const loadDailyTips = async () => {
      setLoadingTips(true);
      try {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const dayStr = `${yyyy}-${mm}-${dd}`;
        const res = await fetch(CLOUD_FN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'tips', date: dayStr, locale: 'en' }),
        });
        const json = await res.json().catch(() => ({}));
        const list = Array.isArray(json?.data?.tips) ? json.data.tips : FALLBACK_TIPS;
        setTips(list.slice(0, 10));
      } catch {
        setTips(FALLBACK_TIPS);
      } finally {
        setLoadingTips(false);
      }
    };
    loadDailyTips();
  }, []);

  const onLongDelete = useCallback(
    (post) => {
      const myUid = auth.currentUser?.uid || null;
      const myName = (currentUser.name || '').trim().toLowerCase();
      const postAuthor = (post.author || '').trim().toLowerCase();

      const canDeleteRemote =
        post.firestoreId && ((myUid && post.uid === myUid) || (!!myName && myName === postAuthor));

      Alert.alert('Delete post?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (canDeleteRemote) {
                await deleteDoc(doc(db, 'posts', post.firestoreId));
              } else {
                Alert.alert('Cannot delete', 'You can only delete your own post.');
              }
            } catch (e) {
              Alert.alert('Delete error', friendlyError(e, 'Delete'));
            }
          },
        },
      ]);
    },
    [currentUser.name]
  );

  const onToggleThanks = useCallback(
    async (post) => {
      try {
        if (!likerId) return;
        if (!post?.firestoreId) return;

        if (likedSet.has(post.firestoreId) || (Array.isArray(post.likedBy) && post.likedBy.includes(likerId))) {
          return;
        }

        const nextSet = new Set(likedSet);
        nextSet.add(post.firestoreId);
        setLikedSet(nextSet);
        persistLikedSet(nextSet);

        // local update (campaign + normal posts)
        setActiveCampaignPinned((prev) => {
          if (prev?.firestoreId === post.firestoreId) {
            return { ...prev, thanks: (prev.thanks || 0) + 1, likedBy: [...(prev.likedBy || []), likerId] };
          }
          return prev;
        });

        setPosts((prev) =>
          prev.map((p) =>
            p.firestoreId === post.firestoreId
              ? { ...p, thanks: (p.thanks || 0) + 1, likedBy: [...(p.likedBy || []), likerId] }
              : p
          )
        );

        await updateDoc(doc(db, 'posts', post.firestoreId), {
          thanks: increment(1),
          likedBy: arrayUnion(likerId),
        });
      } catch (e) {
        setLikedSet((prev) => {
          const clone = new Set(prev);
          clone.delete(post.firestoreId);
          persistLikedSet(clone);
          return clone;
        });

        setActiveCampaignPinned((prev) => {
          if (prev?.firestoreId === post.firestoreId) {
            return { ...prev, thanks: Math.max(0, (prev.thanks || 1) - 1) };
          }
          return prev;
        });

        setPosts((prev) =>
          prev.map((p) => (p.firestoreId === post.firestoreId ? { ...p, thanks: Math.max(0, (p.thanks || 1) - 1) } : p))
        );

        Alert.alert('Action failed', friendlyError(e, 'Like'));
      }
    },
    [likedSet, persistLikedSet, likerId]
  );

  // ✅ rank logic stays for normal posts only
  const combinedRankedPosts = useMemo(() => {
    const now = Date.now();
    const meCompanyKey = normalizeCompany(currentUser.company || '');
    return (posts || [])
      .map((p) => {
        const ageHrs = Math.max(0, (now - (p.createdAt || 0)) / 3_600_000);
        const sameCompany = normalizeCompany(p.company || '') === meCompanyKey;
        const roleBoost = ROLE_BOOST[p.role] || 0;
        const recency = Math.max(0, 48 - ageHrs);
        const thanksBoost = Math.min(20, p.thanks || 0) * 0.5;
        const score = (sameCompany ? 100 : 0) + roleBoost + recency + thanksBoost;
        return { ...p, __score: score };
      })
      .sort((a, b) => b.__score - a.__score || (b.createdAt || 0) - (a.createdAt || 0));
  }, [posts, currentUser.company]);

  // ✅ Final feed (hazards + normal posts only)
  const homeFeed = useMemo(() => {
    const hz = (hazardsFeed || []).map((h) => ({
      kind: 'hazard',
      keyId: h.firestoreId || h.id,
      sortTime: h.createdAtMs || 0,
      data: h,
    }));

    const ps = (combinedRankedPosts || []).map((p) => ({
      kind: 'post',
      keyId: p.firestoreId || p.id,
      sortTime: p.createdAt || 0,
      data: p,
    }));

    return [...hz, ...ps].sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));
  }, [hazardsFeed, combinedRankedPosts]);

  const navigationProfile = useCallback(() => navigation.navigate('Profile'), [navigation]);

  // ✅ Campaign modal open/close (facebook-style list)
  const closeCampaignModal = useCallback(async () => {
    try {
      commentsUnsubRef.current?.();
    } catch {}
    commentsUnsubRef.current = null;

    setCampaignModalVisible(false);
    setActiveCampaign(null);
    setCampaignComments([]);
    setCommentText('');
    setCommentImageUri('');
    setCommentBusy(false);
  }, []);

  const openCampaignModal = useCallback((campaign) => {
    if (!campaign?.firestoreId) return;

    setActiveCampaign(campaign);
    setCampaignModalVisible(true);

    try {
      commentsUnsubRef.current?.();
    } catch {}
    commentsUnsubRef.current = null;

    const commentsQ = query(
      collection(db, 'posts', campaign.firestoreId, 'comments'),
      orderBy('createdAt', 'desc'),
      limit(120)
    );

    const unsub = onSnapshot(
      commentsQ,
      (snap) => {
        const arr = snap.docs.map((d) => {
          const data = d.data() || {};
          const created = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
          return {
            id: d.id,
            authorName: data.authorName || 'Anonymous',
            text: data.text || '',
            imageUrl: data.imageUrl || '',
            createdAt: created,
          };
        });
        setCampaignComments(arr);
      },
      () => {}
    );

    commentsUnsubRef.current = unsub;
  }, []);

  // ✅ Upload helper
  async function uploadIfAny(localUri, pathPrefix) {
    if (!localUri) return '';
    try {
      const resp = await fetch(localUri);
      const blob = await resp.blob();
      const isAudio = (blob.type || '').includes('audio');
      const ext = isAudio ? 'm4a' : 'jpg';
      const path = `${pathPrefix}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const ref = sRef(storage, path);
      await uploadBytes(ref, blob, {
        contentType: blob.type || (isAudio ? 'audio/mp4' : 'image/jpeg'),
      });
      return await getDownloadURL(ref);
    } catch {
      return '';
    }
  }

  const pickCommentImage = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') return Alert.alert('Permission needed', 'Media library access is required.');
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
      });
      if (!res.canceled) setCommentImageUri(res.assets[0].uri);
    } catch (e) {
      Alert.alert('Image error', friendlyError(e, 'Image selection'));
    }
  }, []);

  // ✅ Offline/bad network queue for comments
  const enqueuePendingComment = useCallback(async (entry) => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_CAMPAIGN_COMMENTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift(entry);
      await AsyncStorage.setItem(PENDING_CAMPAIGN_COMMENTS_KEY, JSON.stringify(list.slice(0, 80)));
    } catch {}
  }, []);

  const syncPendingComments = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_CAMPAIGN_COMMENTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list) || list.length === 0) return;

      const remaining = [];
      for (const entry of list) {
        try {
          const { postId, authorName, text, imageUri } = entry || {};
          if (!postId) continue;

          const uid = auth.currentUser?.uid || 'anon';

          const imageUrl = await uploadIfAny(imageUri, `campaignComments/${uid}/images`);

          await addDoc(collection(db, 'posts', postId, 'comments'), {
            authorName: authorName || 'Anonymous',
            text: text || '',
            imageUrl: imageUrl || '',
            createdAt: serverTimestamp(),
          });
        } catch {
          remaining.push(entry);
        }
      }

      await AsyncStorage.setItem(PENDING_CAMPAIGN_COMMENTS_KEY, JSON.stringify(remaining));
    } catch {}
  }, []);

  useEffect(() => {
    syncPendingComments();
    commentSyncTimerRef.current = setInterval(() => {
      syncPendingComments();
    }, 15000);

    return () => {
      try {
        if (commentSyncTimerRef.current) clearInterval(commentSyncTimerRef.current);
      } catch {}
    };
  }, [syncPendingComments]);

  const submitCampaignComment = useCallback(async () => {
    if (!activeCampaign?.firestoreId) return;

    const text = (commentText || '').trim();
    const hasMedia = !!commentImageUri;

    if (!text && !hasMedia) {
      return Alert.alert('Empty comment', 'Type a comment or attach a photo.');
    }

    const authorName = (currentUser.name || 'Anonymous').trim() || 'Anonymous';

    try {
      setCommentBusy(true);

      const uid = auth.currentUser?.uid || 'anon';

      const imageUrl = await uploadIfAny(commentImageUri, `campaignComments/${uid}/images`);

      await addDoc(collection(db, 'posts', activeCampaign.firestoreId, 'comments'), {
        authorName,
        text: text || '',
        imageUrl: imageUrl || '',
        createdAt: serverTimestamp(),
      });

      setCommentText('');
      setCommentImageUri('');
    } catch (e) {
      await enqueuePendingComment({
        postId: activeCampaign.firestoreId,
        authorName,
        text,
        imageUri: commentImageUri || '',
        createdAtMs: Date.now(),
      });

      setCommentText('');
      setCommentImageUri('');

      Alert.alert('Saved', "Your comment will send automatically when the network is better.");
    } finally {
      setCommentBusy(false);
    }
  }, [
    activeCampaign,
    commentText,
    commentImageUri,
    enqueuePendingComment,
    currentUser.name,
  ]);

  const renderItem = useCallback(
    ({ item }) => {
      if (item.kind === 'hazard') {
        return <HazardCard item={item.data} onOpenImage={openImage} onOpenMaps={openInMaps} />;
      }

      const post = item.data;
      const myUid = auth.currentUser?.uid || null;
      const myName = (currentUser.name || '').trim().toLowerCase();
      const postAuthor = (post.author || '').trim().toLowerCase();
      const isMine = (myUid && post.uid === myUid) || (!!myName && myName === postAuthor);

      const isActive = playingId === post.id;
      const isLiked =
        likedSet.has(post.firestoreId) ||
        (Array.isArray(post.likedBy) && likerId && post.likedBy.includes(likerId));

      const isLoadingAudioActive = isActive && audioLoadingId === post.id;

      return (
        <PostCard
          item={post}
          isMine={isMine}
          onLongDelete={onLongDelete}
          onToggleThanks={onToggleThanks}
          onTogglePlay={togglePlay}
          isActive={isActive}
          activePosition={isActive ? position : 0}
          activeDuration={isActive ? duration : post.audioDurationMs || 1}
          isPlayingActive={isActive ? isPlaying : false}
          isLoadingAudioActive={isLoadingAudioActive}
          onOpenImage={openImage}
          isLiked={isLiked}
        />
      );
    },
    [
      openImage,
      openInMaps,
      currentUser.name,
      playingId,
      position,
      duration,
      isPlaying,
      onToggleThanks,
      onLongDelete,
      togglePlay,
      likedSet,
      audioLoadingId,
      likerId,
    ]
  );

  const headerTotalHeight = HEADER_BAR_HEIGHT + insets.top;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={['left', 'right', 'bottom']}>
      {/* Sticky header */}
      <View style={[styles.stickyHeader, { paddingTop: insets.top, height: headerTotalHeight }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>SKP-ZeroHarm</Text>
          <Text style={styles.subtitle}>Sishen Koketso Projects • Safety Culture Feed</Text>
        </View>

        <Pressable onPress={navigationProfile} hitSlop={10} style={styles.avatarWrap}>
          <Avatar size={40} name={currentUser.name} />
        </Pressable>

        <Pressable
          onPress={() => navigation.navigate('ComposePost')}
          accessibilityLabel="New post"
          style={styles.plusBtn}
          hitSlop={16}
        >
          <Text style={styles.plusText}>＋</Text>
        </Pressable>
      </View>

      <FlatList
        data={homeFeed}
        keyExtractor={(it) => `${it.kind}:${it.keyId}`}
        renderItem={renderItem}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: spacing(2) }}>
            <View style={styles.carouselContainer}>
              <Carousel
                loop
                autoPlay
                autoPlayInterval={10000}
                width={width - spacing(2)}
                height={100}
                data={tips}
                scrollAnimationDuration={900}
                renderItem={({ item }) => (
                  <View style={styles.tipCard}>
                    <Text style={styles.tipText}>{item}</Text>
                  </View>
                )}
              />
              {loadingTips ? (
                <Text style={{ color: colors.muted, marginTop: 6, fontSize: 12 }}>Loading today’s tips…</Text>
              ) : null}
            </View>

            <View style={styles.actionRow}>
              <Pressable
                accessibilityLabel="Start Task Safety"
                style={[styles.actionPill, styles.actionPrimary]}
                onPress={() => navigation.navigate('TaskSafety')}
              >
                <Text style={styles.actionPrimaryText}>Start Task Safety</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Report Hazard"
                style={[styles.actionPill, styles.actionOutline]}
                onPress={() => navigation.navigate('ReportHazard')}
              >
                <Text style={styles.actionOutlineText}>Report Hazard</Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityLabel="Weekly Safety Assessment"
              style={styles.assessmentBtn}
              onPress={() => navigation.navigate('Assessment', { assessmentId: 'latest', mode: 'worker' })}
            >
              <Text style={styles.assessmentBtnText}>Weekly Safety Assessment</Text>
              <Text style={styles.assessmentBtnSub}>
                Answer the questions with your team. You have 20 minutes after opening.
              </Text>
            </Pressable>

            {/* ✅ ONE pinned campaign (latest pinned) */}
            {activeCampaignPinned ? (
              <View style={{ marginBottom: spacing(2) }}>
                {(() => {
                  const c = activeCampaignPinned;
                  const isLiked =
                    likedSet.has(c.firestoreId) ||
                    (Array.isArray(c.likedBy) && likerId && c.likedBy.includes(likerId));
                  return (
                    <CampaignCard
                      campaign={c}
                      onOpenImage={openImage}
                      onPressComments={() => openCampaignModal(c)}
                      onToggleThanks={onToggleThanks}
                      isLiked={isLiked}
                      isExpanded={campaignExpanded}
                      onToggleExpanded={() => setCampaignExpanded((v) => !v)}
                    />
                  );
                })()}
              </View>
            ) : null}

            {/* Professional title */}
            <Text style={styles.sectionTitle}>Latest updates from Supervisors, SHE Representatives & Safety</Text>
          </View>
        }
        contentContainerStyle={{
          paddingBottom: spacing(6),
          paddingTop: headerTotalHeight + spacing(1),
        }}
        initialNumToRender={6}
        maxToRenderPerBatch={8}
        windowSize={9}
        updateCellsBatchingPeriod={30}
        removeClippedSubviews={Platform.OS === 'android'}
      />

      {/* Full-screen image viewer */}
      <Modal visible={viewerVisible} transparent animationType="fade" onRequestClose={() => setViewerVisible(false)}>
        <TouchableOpacity style={styles.fullscreen} activeOpacity={1} onPress={() => setViewerVisible(false)}>
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

      {/* ✅ Campaign comments modal (Facebook-style) */}
      <Modal
        visible={campaignModalVisible}
        animationType="slide"
        onRequestClose={closeCampaignModal}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
          {/* Header */}
          <View style={styles.commentsHeader}>
            <Pressable onPress={closeCampaignModal} hitSlop={12} style={styles.commentsBackBtn}>
              <Text style={styles.commentsBackText}>←</Text>
            </Pressable>
            <Text style={styles.commentsHeaderTitle}>Comments</Text>
            <View style={{ width: 40 }} />
          </View>

          {/* ✅ Campaign preview: show ONLY topic/title (no long text) */}
          <View style={styles.commentsCampaignPreview}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <SkpAvatar size={34} />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '900' }}>SKP</Text>
                <Text style={{ color: colors.muted, fontWeight: '800', fontSize: 12 }}>Campaign of the Week</Text>
              </View>
            </View>

            <Text style={{ color: colors.text, fontWeight: '900', fontSize: 15, marginTop: 10 }}>
              {activeCampaign?.title || 'Campaign'}
            </Text>
          </View>

          {/* Comments list */}
          <FlatList
            data={campaignComments}
            keyExtractor={(it) => it.id}
            contentContainerStyle={{ padding: spacing(2), paddingBottom: 120 }}
            renderItem={({ item }) => (
              <View style={styles.commentRow}>
                <Avatar size={34} name={item.authorName || 'Anonymous'} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={styles.commentAuthor}>{item.authorName || 'Anonymous'}</Text>

                  {!!item.text ? <Text style={styles.commentText}>{item.text}</Text> : null}

                  {!!item.imageUrl ? (
                    <TouchableOpacity onPress={() => openImage(item.imageUrl)} activeOpacity={0.9} style={{ marginTop: 8 }}>
                      <Image source={{ uri: item.imageUrl }} style={styles.commentImage} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            )}
          />

          {/* Composer (fixed bottom) */}
          <View style={styles.composerWrap}>
            {!!commentImageUri ? (
              <View style={{ paddingHorizontal: spacing(2), paddingTop: 10 }}>
                <Image source={{ uri: commentImageUri }} style={styles.commentPreview} />
              </View>
            ) : null}

            <View style={styles.composerRow}>
              <Pressable onPress={pickCommentImage} style={styles.composerIconBtn} disabled={commentBusy}>
                <Text style={styles.composerIconText}>🖼️</Text>
              </Pressable>

              <TextInput
                value={commentText}
                onChangeText={setCommentText}
                placeholder="Write a comment…"
                placeholderTextColor={colors.muted}
                style={styles.composerInput}
                multiline
              />

              <Pressable onPress={commentBusy ? undefined : submitCampaignComment} style={styles.composerSendBtn}>
                {commentBusy ? <ActivityIndicator color="#06130A" /> : <Text style={styles.composerSendText}>Send</Text>}
              </Pressable>
            </View>

            <Text style={styles.composerHint}>
              If your network is bad, your comment saves and sends automatically later.
            </Text>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

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
  avatarWrap: { marginLeft: spacing(2) },

  title: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
    lineHeight: 24,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    marginTop: 2,
    fontWeight: '700',
  },

  plusBtn: {
    marginLeft: spacing(1),
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.18)',
  },
  plusText: {
    color: '#06130A',
    fontSize: 24,
    lineHeight: 24,
    fontWeight: '900',
  },

  // Carousel
  carouselContainer: { marginBottom: spacing(2), marginTop: spacing(1) },
  tipCard: {
    backgroundColor: colors.surface,
    borderRadius: radius,
    padding: spacing(2),
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    minHeight: 100,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 2 },
    }),
  },
  tipText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '700',
  },

  actionRow: {
    flexDirection: 'row',
    gap: spacing(1),
    marginBottom: spacing(1.5),
  },
  actionPill: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignItems: 'center',
    borderWidth: 1,
  },
  actionPrimary: {
    backgroundColor: colors.primary,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  actionPrimaryText: {
    color: '#06130A',
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 0.2,
  },
  actionOutline: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  actionOutlineText: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 14,
  },

  assessmentBtn: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: spacing(2),
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 1 },
    }),
  },
  assessmentBtnText: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 15,
  },
  assessmentBtnSub: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 4,
    fontWeight: '700',
  },

  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '900',
    marginBottom: spacing(1),
    marginTop: spacing(1),
  },

  // Shared card style (posts + hazards)
  postCard: {
    backgroundColor: colors.surface,
    padding: spacing(2),
    borderRadius: 16,
    borderColor: colors.border,
    borderWidth: 1,
    marginVertical: spacing(1),
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 1 },
    }),
  },

  // Post pieces
  postHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing(1),
  },
  postAuthor: { color: colors.text, fontWeight: '900', fontSize: 15 },
  postRole: { color: colors.muted, fontSize: 12, marginTop: 2, fontWeight: '700' },
  postText: { color: colors.text, fontSize: 14, lineHeight: 22, marginTop: spacing(0.5), fontWeight: '600' },

  postImage: {
    width: '100%',
    height: 200,
    borderRadius: 12,
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

  // Audio
  audioRow: {
    marginTop: spacing(1),
    padding: spacing(1),
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
  },
  audioPlayBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing(1),
  },
  audioPlayIcon: { color: colors.text, fontSize: 16 },
  audioProgressWrap: { flex: 1 },
  audioProgressTrack: {
    height: 6,
    borderRadius: 999,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  audioProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  audioTimeText: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 6,
    fontWeight: '800',
  },

  reactionsRow: {
    marginTop: spacing(1.25),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reactionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  reactionIcon: { color: colors.muted, marginRight: 8, fontSize: 16 },
  reactionText: { color: colors.muted, fontWeight: '900' },
  reactionCount: { color: colors.muted, fontSize: 13, fontWeight: '800' },

  deleteChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFE4E6',
  },
  deleteChipText: {
    color: '#9F1239',
    fontWeight: '900',
    fontSize: 12,
  },

  // Hazard pieces
  hzTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  hzTitle: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 15,
    flex: 1,
    paddingRight: 6,
  },
  hzSevBadge: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999 },
  hzSevBadgeText: { fontWeight: '900', fontSize: 12 },
  hzStatusBadge: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999 },
  hzStatusBadgeText: { fontWeight: '800', fontSize: 11 },

  hzMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  hzMetaText: { color: colors.muted, fontSize: 12 },

  hzActionLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
  },

  hzLocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  hzLocText: { color: colors.muted, fontSize: 12, flex: 1, paddingRight: 8 },
  hzMapBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#0F1720',
  },
  hzMapBtnText: { color: '#E5E7EB', fontSize: 12, fontWeight: '800' },

  // ✅ Campaign styles
  campaignCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(0,58,143,0.25)',
    padding: spacing(2),
    marginTop: 6,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 2 },
    }),
  },
  campaignHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  campaignAuthor: { color: colors.text, fontWeight: '900' },
  campaignBadgeLine: { color: '#003A8F', fontWeight: '900', fontSize: 12, marginTop: 2 },

  pinnedChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,58,143,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0,58,143,0.20)',
  },
  pinnedChipText: { color: '#003A8F', fontWeight: '900', fontSize: 11, letterSpacing: 0.4 },

  campaignTitle: { color: colors.text, fontWeight: '900', fontSize: 16, marginTop: 12 },
  campaignActionsRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  campaignBtn: { flex: 1 },
  campaignCommentBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  campaignCommentBtnText: { color: colors.text, fontWeight: '900' },
  campaignCounts: { color: colors.muted, fontWeight: '800', marginTop: 10 },
  campaignAudioHint: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  campaignAudioHintText: { color: colors.muted, fontWeight: '800', fontSize: 12 },

  // ✅ Show more/less
  showMoreBtn: { marginTop: 8, alignSelf: 'flex-start' },
  showMoreText: { color: likeBlue, fontWeight: '900' },

  // Full-screen viewer
  fullscreen: {
    flex: 1,
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
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

  // ✅ Comments modal styling
  commentsHeader: {
    backgroundColor: SKP_BLUE,
    paddingHorizontal: spacing(2),
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.18)',
  },
  commentsBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentsBackText: { color: '#fff', fontSize: 18, fontWeight: '900' },
  commentsHeaderTitle: { flex: 1, textAlign: 'center', color: '#fff', fontWeight: '900', fontSize: 16 },

  commentsCampaignPreview: {
    margin: spacing(2),
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing(2),
  },

  commentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  commentAuthor: { color: colors.text, fontWeight: '900' },
  commentText: { color: colors.text, fontWeight: '600', marginTop: 4, lineHeight: 20 },
  commentImage: {
    width: '100%',
    height: 180,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },

  composerWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingBottom: 10,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing(2),
    paddingTop: 10,
    gap: 10,
  },
  composerIconBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerIconText: { fontSize: 18 },

  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontWeight: '700',
    textAlignVertical: 'top',
    backgroundColor: '#FFFFFF',
  },

  composerSendBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerSendText: { color: '#06130A', fontWeight: '900' },

  composerHint: {
    paddingHorizontal: spacing(2),
    paddingTop: 6,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },

  commentPreview: {
    width: '100%',
    height: 120,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
});