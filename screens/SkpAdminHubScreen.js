// screens/SkpAdminHubScreen.js
import React from 'react';
import { View, Text, StyleSheet, Pressable, StatusBar } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

const SKP_BLUE = '#003A8F';

const colors = {
  bg: '#F7F4F6',
  surface: '#FFFFFF',
  text: '#0F172A',
  muted: '#64748B',
  border: '#E6E1E7',
  primary: '#00C853',
};

const spacing = (n = 1) => 8 * n;

export default function SkpAdminHubScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.root} edges={['left', 'right', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />

      <View style={[styles.header, { paddingTop: insets.top }]}>
        <Pressable onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={12}>
          <Text style={styles.backText}>←</Text>
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>SKP Admin Tools</Text>
          <Text style={styles.headerSub}>Assessments • Campaigns • Matrix</Text>
        </View>
      </View>

      <View style={styles.body}>
        <Pressable
          style={styles.bigBtn}
          onPress={() => navigation.navigate('CreateAssessment')}
        >
          <Text style={styles.bigBtnTitle}>Create Assessment</Text>
          <Text style={styles.bigBtnSub}>Publish a weekly / team assessment.</Text>
        </Pressable>

        <Pressable
          style={styles.bigBtn}
          onPress={() => navigation.navigate('SubmittedAssessments')}
        >
          <Text style={styles.bigBtnTitle}>Submitted Assessments</Text>
          <Text style={styles.bigBtnSub}>Mark teams • Select best supervisor/team • Review results.</Text>
        </Pressable>

        <Pressable
          style={styles.bigBtn}
          onPress={() => navigation.navigate('ComposePost', { mode: 'campaign' })}
        >
          <Text style={styles.bigBtnTitle}>Create Campaign Post</Text>
          <Text style={styles.bigBtnSub}>Pin a safety focus at the top of Home.</Text>
        </Pressable>

        <Pressable
          style={styles.bigBtn}
          onPress={() => navigation.navigate('SkpMatrix')}
        >
          <Text style={styles.bigBtnTitle}>View Matrix / Stats</Text>
          <Text style={styles.bigBtnSub}>Section 23s, near misses, incidents, trends.</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    backgroundColor: SKP_BLUE,
    paddingHorizontal: spacing(2),
    paddingBottom: spacing(1.5),
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.18)',
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
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '900' },
  headerSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 2, fontWeight: '800' },

  body: {
    padding: spacing(2),
    gap: spacing(1.25),
  },
  bigBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing(2),
  },
  bigBtnTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },
  bigBtnSub: { color: colors.muted, fontWeight: '700', marginTop: 6 },
});