// storage.js
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, db } from './firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

// ---- Canonical keys ---------------------------------------------------------
const LEGACY_PROFILE_KEYS = ['PROFILE_V1', 'USER_PROFILE', 'PROFILE'];
const profileKey = (uid) => (uid ? `PROFILE_V2:${uid}` : 'PROFILE_V2:local');

// ---- Utils ------------------------------------------------------------------
const safeJSON = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};

const normalizeProfile = (obj = {}) => {
  const name = (obj.fullName || obj.name || '').trim();
  const role = (obj.role || obj.designation || '').trim();
  const company = (obj.company || '').trim();
  const phone = (obj.phone || '').trim();
  const avatar = obj.avatar || obj.avatarUri || obj.photoURL || obj.photo || '';
  const updatedAt = Number(obj.updatedAt || Date.now());
  return { name, role, company, phone, avatar, updatedAt };
};

// ---- Profile: load / save / cleanup ----------------------------------------
export async function clearLegacyProfileKeys() {
  try { await AsyncStorage.multiRemove(LEGACY_PROFILE_KEYS); } catch {}
}

export async function loadProfile(opts = { preferServer: true, purgeLegacy: true }) {
  const uid = auth.currentUser?.uid || null;
  const key = profileKey(uid);

  let local = null;

  // 1) Canonical local
  try {
    const raw = await AsyncStorage.getItem(key);
    local = safeJSON(raw);
  } catch {}

  // 2) Legacy migration if canonical missing
  if (!local) {
    for (const k of LEGACY_PROFILE_KEYS) {
      const raw = await AsyncStorage.getItem(k);
      if (raw) {
        const parsed = safeJSON(raw);
        if (parsed) {
          local = normalizeProfile(parsed);
          try {
            await AsyncStorage.setItem(key, JSON.stringify(local));
            await AsyncStorage.removeItem(k);
          } catch {}
          break;
        }
      }
    }
  }

  // 3) Server
  let server = null;
  if (opts.preferServer !== false && uid) {
    try {
      const snap = await getDoc(doc(db, 'userProfiles', uid));
      if (snap.exists()) {
        const d = snap.data() || {};
        server = normalizeProfile({
          fullName: d.fullName,
          role: d.role,
          company: d.company,
          phone: d.phone,
          avatar: d.avatar || d.photoURL,
          updatedAt: d.updatedAt?.toMillis ? d.updatedAt.toMillis() : (d.updatedAt || 0),
        });
      }
    } catch {}
  }

  // 4) Choose newest (falls back gracefully)
  const localT = Number(local?.updatedAt || 0);
  const serverT = Number(server?.updatedAt || 0);
  const chosen = serverT > localT ? (server || local) : (local || server) || normalizeProfile({});

  // 5) Cache canonical + purge legacy (once)
  try { await AsyncStorage.setItem(key, JSON.stringify(chosen)); } catch {}
  if (opts.purgeLegacy) clearLegacyProfileKeys().catch(()=>{});

  return chosen;
}

export async function saveProfile(partial) {
  const uid = auth.currentUser?.uid || null;
  const key = profileKey(uid);

  // Merge with current local (keep non-empty old fields if new empty)
  let prev = null;
  try { prev = safeJSON(await AsyncStorage.getItem(key)); } catch {}
  const incoming = normalizeProfile(partial);

  // Small safeguard: if incoming avatar is empty, keep previous
  const merged = { ...(prev || {}), ...incoming };
  for (const f of ['name','role','company','phone','avatar']) {
    if (!merged[f] && prev?.[f]) merged[f] = prev[f];
  }
  merged.updatedAt = Date.now();

  // Save local
  try { await AsyncStorage.setItem(key, JSON.stringify(merged)); } catch {}

  // Save server (if logged in)
  if (uid) {
    try {
      await setDoc(doc(db, 'userProfiles', uid), {
        fullName: merged.name,
        role: merged.role,
        company: merged.company,
        phone: merged.phone,
        avatar: merged.avatar,              // should be a HTTPS URL (ProfileScreen uploads first)
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch {}
  }

  // Clean legacy
  clearLegacyProfileKeys().catch(()=>{});
  return merged;
}

// ---- Posts helpers ----------------------------------------------------------
const DEFAULT_POSTS_KEY = 'FEED_POSTS';

export async function loadPosts() {
  try {
    const raw = await AsyncStorage.getItem(DEFAULT_POSTS_KEY);
    const arr = safeJSON(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function savePosts(posts) {
  try { await AsyncStorage.setItem(DEFAULT_POSTS_KEY, JSON.stringify(posts || [])); } catch {}
}

export async function prependPost(newPost) {
  const list = await loadPosts();
  const next = [newPost, ...list];
  await savePosts(next);
  return next;
}

// ---- Task Safety checklist helpers (used by TaskSafetyScreen) ---------------
const CHECKLIST_KEY = 'CHECKLIST_RUNS_V1';
const CHECKLIST_CAP = 100; // keep the most recent 100 locally

export async function loadChecklistRuns() {
  try {
    const raw = await AsyncStorage.getItem(CHECKLIST_KEY);
    const arr = safeJSON(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveChecklistRuns(runs) {
  try {
    await AsyncStorage.setItem(CHECKLIST_KEY, JSON.stringify(runs || []));
  } catch {}
}

/**
 * Prepend a run, ensure most recent first, cap the list to CHECKLIST_CAP.
 * Each run is expected to have: { id, task, details, checks, ppeChecks, insights, createdAt }
 */
export async function prependChecklistRun(run) {
  const list = await loadChecklistRuns();
  const item = { ...run, createdAt: Number(run?.createdAt || Date.now()) };
  const next = [item, ...list]
    .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0))
    .slice(0, CHECKLIST_CAP);
  await saveChecklistRuns(next);
  return next;
}
