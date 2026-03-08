// firebase.js
import { Platform } from 'react-native';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// --- your config ---


const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Use plain getAuth() for now (no custom RN persistence needed yet)
const auth = getAuth(app);

// Firestore & Storage
const db = getFirestore(app);
const storage = getStorage(app);

// Analytics on web only (guarded)
let analytics = null;
if (Platform.OS === 'web') {
  try {
    const { getAnalytics, isSupported } = require('firebase/analytics');
    isSupported().then(ok => { if (ok) analytics = getAnalytics(app); });
  } catch {}
}

export { app, auth, db, storage, analytics };

