// screens/AuthScreen.js
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, Alert, ScrollView, ActivityIndicator,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { saveProfile } from '../storage';

const colors = { bg:'#0B0F14', surface:'#131A22', text:'#E7EEF5', muted:'#A7B4C2', primary:'#00C853', border:'#1E2530' };
const spacing = (n=1)=>8*n;

const ROLES = ['Supervisor','Safety Officer','SHE Rep','Operator','Contractor','Other'];

function isStrong(pw='') {
  return /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw) && pw.length >= 8;
}

export default function AuthScreen(){
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'

  // shared
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // signup-only fields
  const [firstName, setFirstName] = useState('');
  const [surname, setSurname] = useState('');
  const [empNo, setEmpNo] = useState('');
  const [role, setRole] = useState('');

  const [busy, setBusy] = useState(false);

  const toggleMode = () => setMode(m => (m === 'signin' ? 'signup' : 'signin'));

  const onSignIn = async () => {
    const em = email.trim().toLowerCase();
    if (!em || !password) return Alert.alert('Missing info', 'Enter email and password.');
    try {
      setBusy(true);
      const cred = await signInWithEmailAndPassword(auth, em, password);

      // Pull server profile (if any) and mirror to local storage
      try {
        const ref = doc(db, 'userProfiles', cred.user.uid);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const p = snap.data() || {};
          await saveProfile({
            name: p.fullName || cred.user.displayName || '',
            role: p.role || '',
            company: p.company || '',
            phone: p.phone || '',
            avatar: p.avatar || '',
          });
        } else {
          await saveProfile({
            name: cred.user.displayName || '',
            role: '',
            company: '',
            phone: '',
            avatar: '',
          });
        }
      } catch {}
    } catch (e) {
      Alert.alert('Sign in error', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onSignUp = async () => {
    const em = email.trim().toLowerCase();
    if (!firstName.trim() || !surname.trim() || !empNo.trim()) {
      return Alert.alert('Missing info', 'Please fill in name, surname and employee number.');
    }
    if (!em) return Alert.alert('Email required', 'Enter your work email.');
    if (!isStrong(password)) {
      return Alert.alert('Weak password', 'Use at least 8 characters with upper, lower and a number.');
    }

    const fullName = `${firstName.trim()} ${surname.trim()}`.trim();
    try {
      setBusy(true);
      const cred = await createUserWithEmailAndPassword(auth, em, password);
      // Set display name
      try { await updateProfile(cred.user, { displayName: fullName }); } catch {}

      // Create/merge Firestore user profile
      const ref = doc(db, 'userProfiles', cred.user.uid);
      await setDoc(ref, {
        fullName,
        firstName: firstName.trim(),
        surname: surname.trim(),
        employeeNumber: empNo.trim(),
        role: role.trim(),
        email: em,
        createdAt: serverTimestamp(),
      }, { merge: true });

      // Mirror to local profile cache
      await saveProfile({
        name: fullName,
        role: role.trim(),
        company: '',
        phone: '',
        avatar: '',
      });
    } catch (e) {
      Alert.alert('Sign up error', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onReset = async () => {
    const em = email.trim().toLowerCase();
    if (!em) return Alert.alert('Enter email', 'Type the email you registered with.');
    try {
      setBusy(true);
      await sendPasswordResetEmail(auth, em);
      Alert.alert('Password reset', 'If that email exists, a reset link has been sent.');
    } catch (e) {
      Alert.alert('Reset error', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const Pill = ({ label, active, onPress }) => (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} disabled={busy}
      style={[styles.pill, active ? styles.pillOn : styles.pillOff, busy && { opacity: 0.7 }]}>
      <Text style={[styles.pillText, active ? styles.pillTextOn : styles.pillTextOff]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top','right','bottom','left']}>
      <ScrollView
        contentContainerStyle={{
          padding: spacing(2),
          paddingTop: spacing(2),
          paddingBottom: spacing(4),
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.appTitle}>MyZeroHarm</Text>
        <Text style={styles.subtitle}>Safety is everyone’s responsibility</Text>

        <View style={styles.switchRow}>
          <Pill label="Sign in" active={mode==='signin'} onPress={()=>setMode('signin')} />
          <Pill label="Create account" active={mode==='signup'} onPress={()=>setMode('signup')} />
        </View>

        <View style={styles.card}>
          {mode === 'signup' && (
            <>
              <Text style={styles.label}>Name</Text>
              <TextInput
                value={firstName} onChangeText={setFirstName} editable={!busy}
                placeholder="First name" placeholderTextColor={colors.muted}
                style={styles.input} returnKeyType="next"
                autoCapitalize="words"
              />

              <Text style={styles.label}>Surname</Text>
              <TextInput
                value={surname} onChangeText={setSurname} editable={!busy}
                placeholder="Surname" placeholderTextColor={colors.muted}
                style={styles.input} returnKeyType="next"
                autoCapitalize="words"
              />

              <Text style={styles.label}>Employee number</Text>
              <TextInput
                value={empNo} onChangeText={setEmpNo} editable={!busy}
                placeholder="e.g., EMP-012345" placeholderTextColor={colors.muted}
                style={styles.input} returnKeyType="next"
                autoCapitalize="characters"
              />

              <Text style={styles.label}>Role (optional)</Text>
              <TextInput
                value={role} onChangeText={setRole} editable={!busy}
                placeholder={`e.g., ${ROLES.join(' / ')}`}
                placeholderTextColor={colors.muted}
                style={styles.input} returnKeyType="next"
              />
            </>
          )}

          <Text style={styles.label}>Email</Text>
          <TextInput
            value={email} onChangeText={setEmail} editable={!busy}
            autoCapitalize="none" keyboardType="email-address"
            autoComplete="email" textContentType="username"
            placeholder="name@company.com" placeholderTextColor={colors.muted}
            style={styles.input} returnKeyType="next"
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            value={password} onChangeText={setPassword} editable={!busy}
            secureTextEntry autoComplete="password" textContentType="password"
            placeholder={mode==='signup' ? 'Strong password (8+ incl. Aa1)' : 'Your password'}
            placeholderTextColor={colors.muted}
            style={styles.input} returnKeyType="done"
          />

          {mode === 'signin' && (
            <TouchableOpacity onPress={onReset} activeOpacity={0.7} disabled={busy} style={{ alignSelf:'flex-end', marginTop: 8 }}>
              <Text style={{ color: colors.muted, fontWeight:'800' }}>{busy ? '...' : 'Forgot password?'}</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={mode==='signin' ? onSignIn : onSignUp}
            disabled={busy}
            activeOpacity={0.85}
            style={[styles.submitBtn, busy && { opacity:0.6 }]}
          >
            {busy ? <ActivityIndicator color="#06130A" /> : <Text style={styles.submitText}>{mode==='signin' ? 'Sign in' : 'Create account'}</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={toggleMode} activeOpacity={0.7} disabled={busy} style={{ alignSelf:'center', marginTop: spacing(1) }}>
            <Text style={{ color: colors.muted }}>
              {mode==='signin' ? 'New here? Create account' : 'Already have an account? Sign in'}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={{ color: colors.muted, fontSize: 12, marginTop: spacing(2) }}>
          Tip: use your work email. Password must be 8+ characters and include upper, lower and a number.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:{ flex:1, backgroundColor: colors.bg },
  appTitle:{ color: colors.text, fontSize: 22, fontWeight:'900' },
  subtitle:{ color: colors.muted, fontSize: 12, marginTop: 2, marginBottom: spacing(1) },

  switchRow:{ flexDirection:'row', gap: spacing(1), marginBottom: spacing(1) },
  pill:{ paddingVertical:8, paddingHorizontal:12, borderRadius:999, borderWidth:1 },
  pillOn:{ backgroundColor: colors.primary, borderColor:'rgba(0,0,0,0.25)' },
  pillOff:{ backgroundColor:'transparent', borderColor: colors.muted },
  pillText:{ fontWeight:'800' },
  pillTextOn:{ color:'#06130A' },
  pillTextOff:{ color: colors.text },

  card:{
    backgroundColor: colors.surface, borderWidth:1, borderColor: colors.border,
    borderRadius:12, padding: spacing(1.5)
  },
  label:{ color: colors.text, fontSize:13, fontWeight:'700', marginTop: spacing(1), marginBottom: spacing(0.5) },
  input:{
    backgroundColor:'#0F151C', borderWidth:1, borderColor: colors.border, color: colors.text,
    padding: spacing(1.25), borderRadius:10
  },
  submitBtn:{
    marginTop: spacing(2), backgroundColor: colors.primary, paddingVertical:12,
    borderRadius:12, alignItems:'center'
  },
  submitText:{ color:'#06130A', fontWeight:'900' },
});

