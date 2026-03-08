// screens/TaskSafetyScreen.js
import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  Alert,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { app } from '../firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * ✅ Light Anglo-ish theme (matches your HomeScreen)
 */
const colors = {
  bg: '#F7F4F6',
  surface: '#FFFFFF',
  text: '#0F172A',
  muted: '#64748B',
  primary: '#00C853',
  border: '#E6E1E7',
};

const spacing = (n = 1) => 8 * n;
const radius = 16;

// ✅ Header branding (same as Home)
const SKP_BLUE = '#003A8F';
const HEADER_BAR_HEIGHT = 64;

const FN_REGION = 'us-central1';
const CLOUD_FN_URL = `https://${FN_REGION}-${app.options.projectId}.cloudfunctions.net/generateSafetyPlan`;

// ✅ Local persistence keys
const TASK_STATE_KEY = 'TASK_SAFETY_STATE_V1';
const TASK_DAY_KEY = 'TASK_SAFETY_DAYKEY_V1';

// ✅ Day rollover rule: "after 12pm it's another day"
function dayKeyMidday(now = new Date()) {
  // If before 12:00, treat it as "yesterday's day key"
  const d = new Date(now);
  if (d.getHours() < 12) {
    d.setDate(d.getDate() - 1);
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const Section = ({ title, children }) => (
  <View style={styles.card}>
    <Text style={styles.cardTitle}>{title}</Text>
    {children}
  </View>
);

// ---- robust, silent fetch with retry (no user alerts) -----------------------
async function postJsonWithRetry(url, body, { attempts = 2, timeoutMs = 15000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      clearTimeout(t);

      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('application/json')) {
        await res.text().catch(() => '');
        continue;
      }

      const json = await res.json().catch(() => null);
      if (!json) continue;

      if (res.ok && json.data) return { ok: true, data: json.data };
      if (json.data) return { ok: true, data: json.data };
    } catch (_) {
      // ignore + retry
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return { ok: false, data: null };
}

// ---- Checklist model --------------------------------------------------------
/**
 * status: "yes" | "no" | "na"
 */
const STATUS = { YES: 'yes', NO: 'no', NA: 'na' };

const makeItem = (id, label) => ({
  id,
  label,
  status: null,
});

const INITIAL_SECTIONS = [
  {
    id: 'permits_toolbox',
    title: 'Permits & Communication',
    items: [
      makeItem('pt1', 'DTSI / Risk Assessment completed and signed by the team.'),
      makeItem('pt2', 'Toolbox talk done and everyone understands the task.'),
      makeItem('pt3', 'All permits required for the job are available and valid (e.g., Hot Work, WAH, Confined Space).'),
      makeItem('pt4', 'JRA / SWP reviewed and controls understood.'),
      makeItem('pt5', 'Roles assigned (supervisor, spotter, fire watch, banksman, etc.).'),
      makeItem('pt6', 'Communication method agreed (radio channel / hand signals).'),
      makeItem('pt7', 'Work area boundaries explained; access control in place.'),
    ],
  },
  {
    id: 'ppe',
    title: 'PPE & Fitness for Work',
    items: [
      makeItem('ppe1', 'Correct PPE worn by all team members (helmet, boots, gloves, glasses).'),
      makeItem('ppe2', 'Task-specific PPE available and worn (respirator, face shield, FR clothing, harness, etc.).'),
      makeItem('ppe3', 'PPE is in good condition (no cracks, torn gloves, damaged straps).'),
      makeItem('ppe4', 'Team is fit for work (not fatigued, ill, or under the influence).'),
      makeItem('ppe5', 'Hydration plan in place (water available; heat stress managed).'),
    ],
  },
  {
    id: 'area_control',
    title: 'Work Area Setup & Controls',
    items: [
      makeItem('a1', 'Housekeeping done: walkway clear, spills cleaned, scrap removed.'),
      makeItem('a2', 'Barricades / danger tape placed; signage visible.'),
      makeItem('a3', 'Exclusion zone set for line-of-fire and moving equipment.'),
      makeItem('a4', 'Lighting adequate for the task; no shadows/blind spots.'),
      makeItem('a5', 'Vehicle–pedestrian interaction controlled (routes separated).'),
      makeItem('a6', 'Fire risk controlled: combustibles removed or protected.'),
    ],
  },
  {
    id: 'tools_equipment',
    title: 'Tools, Equipment & Inspections',
    items: [
      makeItem('t1', 'Tools inspected: guards fitted, cables intact, plugs OK, tags valid.'),
      makeItem('t2', 'Right tool for the job (no makeshift tools).'),
      makeItem('t3', 'Ladders/scaffolds/access equipment inspected and tagged (if used).'),
      makeItem('t4', 'Lifting gear inspected and rated (slings, shackles, hooks) (if used).'),
      makeItem('t5', 'Machines/equipment pre-start checks completed (if operating).'),
      makeItem('t6', 'Workpiece secured/clamped; no hand-holding for cutting/grinding.'),
    ],
  },
  {
    id: 'energy_isolation',
    title: 'Isolation / LOTO & Energy Control',
    items: [
      makeItem('e1', 'LOTO applied where required; isolation points identified.'),
      makeItem('e2', 'Test for dead / verify isolation completed (electrical/mechanical).'),
      makeItem('e3', 'Stored energy released (pressure, gravity, springs, hydraulics).'),
      makeItem('e4', 'Guards/interlocks in place; no bypassing safety devices.'),
      makeItem('e5', 'Emergency stop / shutdown method known and accessible.'),
    ],
  },
  {
    id: 'emergency',
    title: 'Emergency Preparedness',
    items: [
      makeItem('em1', 'Fire extinguisher available, correct type, and within reach.'),
      makeItem('em2', 'First aid box available and stocked.'),
      makeItem('em3', 'Nearest muster point and emergency numbers known.'),
      makeItem('em4', 'Rescue plan ready (especially for confined space / height work).'),
      makeItem('em5', 'Escape routes clear; no blocked exits.'),
    ],
  },
];

function freshSections() {
  // deep clone so we don't share references
  return INITIAL_SECTIONS.map((s) => ({
    ...s,
    items: s.items.map((it) => ({ ...it, status: null })),
  }));
}

function countIssues(sections) {
  let noCount = 0;
  let unanswered = 0;
  let total = 0;
  for (const s of sections) {
    for (const it of s.items) {
      total += 1;
      if (!it.status) unanswered += 1;
      if (it.status === STATUS.NO) noCount += 1;
    }
  }
  return { noCount, unanswered, total };
}

export default function TaskSafetyScreen() {
  const insets = useSafeAreaInsets();

  const [jobTitle, setJobTitle] = useState('');
  const [jobLocation, setJobLocation] = useState('');
  const [supervisor, setSupervisor] = useState('');
  const [sections, setSections] = useState(freshSections());

  // Keep only Ask Safety AI (optional)
  const [chatText, setChatText] = useState('');
  const [chatAnswer, setChatAnswer] = useState('');
  const [chatBusy, setChatBusy] = useState(false);

  // ✅ persistence helpers
  const dayKeyRef = useRef(dayKeyMidday(new Date()));
  const bootedRef = useRef(false);
  const saveTimerRef = useRef(null);

  const headerTotalHeight = HEADER_BAR_HEIGHT + insets.top;

  const setStatus = useCallback((sectionId, itemId, status) => {
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s;
        return {
          ...s,
          items: s.items.map((it) => (it.id === itemId ? { ...it, status } : it)),
        };
      })
    );
  }, []);

  const stats = useMemo(() => countIssues(sections), [sections]);

  // ✅ Load saved state (only for same dayKey)
  useEffect(() => {
    (async () => {
      try {
        const currentDayKey = dayKeyMidday(new Date());
        dayKeyRef.current = currentDayKey;

        const [storedDayKey, storedStateRaw] = await Promise.all([
          AsyncStorage.getItem(TASK_DAY_KEY),
          AsyncStorage.getItem(TASK_STATE_KEY),
        ]);

        // If day changed, wipe old state
        if (!storedDayKey || storedDayKey !== currentDayKey) {
          await AsyncStorage.setItem(TASK_DAY_KEY, currentDayKey);
          await AsyncStorage.removeItem(TASK_STATE_KEY);

          // reset UI to fresh for the new day
          setJobTitle('');
          setJobLocation('');
          setSupervisor('');
          setSections(freshSections());
          setChatText('');
          setChatAnswer('');
          bootedRef.current = true;
          return;
        }

        if (storedStateRaw) {
          const parsed = JSON.parse(storedStateRaw);

          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.jobTitle === 'string') setJobTitle(parsed.jobTitle);
            if (typeof parsed.jobLocation === 'string') setJobLocation(parsed.jobLocation);
            if (typeof parsed.supervisor === 'string') setSupervisor(parsed.supervisor);

            if (Array.isArray(parsed.sections)) {
              // Safe restore: preserve labels, restore statuses by ids
              const statusMap = new Map();
              for (const sec of parsed.sections) {
                if (!sec?.id || !Array.isArray(sec.items)) continue;
                for (const it of sec.items) {
                  if (!it?.id) continue;
                  statusMap.set(`${sec.id}:${it.id}`, it.status || null);
                }
              }

              setSections((prev) =>
                prev.map((sec) => ({
                  ...sec,
                  items: sec.items.map((it) => ({
                    ...it,
                    status: statusMap.get(`${sec.id}:${it.id}`) ?? null,
                  })),
                }))
              );
            }

            // Optional: keep AI text/answer for the day
            if (typeof parsed.chatText === 'string') setChatText(parsed.chatText);
            if (typeof parsed.chatAnswer === 'string') setChatAnswer(parsed.chatAnswer);
          }
        }
      } catch {
        // if anything fails, just run fresh
        setSections(freshSections());
      } finally {
        bootedRef.current = true;
      }
    })();
  }, []);

  // ✅ Auto-reset watcher (checks every 30s; if dayKey changes, resets and saves new dayKey)
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const current = dayKeyMidday(new Date());
        if (current !== dayKeyRef.current) {
          dayKeyRef.current = current;

          await AsyncStorage.setItem(TASK_DAY_KEY, current);
          await AsyncStorage.removeItem(TASK_STATE_KEY);

          setJobTitle('');
          setJobLocation('');
          setSupervisor('');
          setSections(freshSections());
          setChatText('');
          setChatAnswer('');
        }
      } catch {}
    }, 30000);

    return () => clearInterval(t);
  }, []);

  // ✅ Save state whenever user changes stuff (debounced)
  useEffect(() => {
    if (!bootedRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      try {
        const payload = {
          dayKey: dayKeyRef.current,
          jobTitle,
          jobLocation,
          supervisor,
          sections,
          chatText,
          chatAnswer,
          savedAtMs: Date.now(),
        };
        await AsyncStorage.setItem(TASK_STATE_KEY, JSON.stringify(payload));
        await AsyncStorage.setItem(TASK_DAY_KEY, dayKeyRef.current);
      } catch {}
    }, 350);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [jobTitle, jobLocation, supervisor, sections, chatText, chatAnswer]);

  const onReset = () => {
    Alert.alert('Reset checklist?', 'This will clear all selections for today.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          setJobTitle('');
          setJobLocation('');
          setSupervisor('');
          setSections(freshSections());
          setChatText('');
          setChatAnswer('');

          try {
            await AsyncStorage.removeItem(TASK_STATE_KEY);
            await AsyncStorage.setItem(TASK_DAY_KEY, dayKeyRef.current);
          } catch {}
        },
      },
    ]);
  };

  const onComplete = () => {
    const { noCount, unanswered } = stats;

    if (!jobTitle.trim()) {
      return Alert.alert('Task required', 'Please enter the task/job title.');
    }

    if (unanswered > 0) {
      return Alert.alert(
        'Checklist not finished',
        `You still have ${unanswered} unanswered items. Please complete them (Yes / No / N/A).`
      );
    }

    if (noCount > 0) {
      return Alert.alert(
        'Not ready to start',
        `There are ${noCount} items marked “No”. Fix these before starting the task.`
      );
    }

    Alert.alert('Ready to start', 'All checks are marked Yes/N/A. Proceed with the task safely.');
  };

  const onAsk = async () => {
    const q = chatText.trim();
    if (!q || chatBusy) return;
    setChatBusy(true);
    setChatAnswer('Thinking…');

    const resp = await postJsonWithRetry(
      CLOUD_FN_URL,
      { mode: 'chat', question: q, task: jobTitle.trim(), locale: 'en' },
      { attempts: 2, timeoutMs: 15000 }
    );

    if (resp.ok && resp.data?.answer) {
      setChatAnswer((resp.data.answer || '').trim() || 'No answer.');
    } else {
      setChatAnswer('Offline: follow supervisor instructions and standard procedures.');
    }
    setChatBusy(false);
  };

  const renderHeaderRight = useMemo(() => {
    const { noCount, unanswered, total } = stats;
    const done = total - unanswered;

    return (
      <View style={styles.headerRight}>
        <View style={styles.headerChip}>
          <Text style={styles.headerChipText}>{done}/{total}</Text>
        </View>
        {noCount > 0 ? (
          <View style={[styles.headerChip, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
            <Text style={styles.headerChipText}>NO: {noCount}</Text>
          </View>
        ) : null}
      </View>
    );
  }, [stats]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={['left', 'right', 'bottom']}>
      {/* ✅ Only the blue header */}
      <View style={[styles.stickyHeader, { paddingTop: insets.top, height: headerTotalHeight }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>SKP-ZeroHarm</Text>
          <Text style={styles.subtitle}>Task Safety Checklist</Text>
        </View>
        {renderHeaderRight}
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing(2),
          paddingBottom: spacing(4),
          paddingTop: headerTotalHeight + spacing(2),
        }}
        keyboardShouldPersistTaps="always"
      >
        <Section title="Task Details">
          <Text style={styles.label}>Task / Job Title</Text>
          <TextInput
            value={jobTitle}
            onChangeText={setJobTitle}
            placeholder="e.g., Welding brackets on chute at Bay 3"
            placeholderTextColor={colors.muted}
            style={[styles.input, styles.taskBig]}
            multiline
          />

          <View style={{ height: spacing(1) }} />

          <Text style={styles.label}>Location / Area</Text>
          <TextInput
            value={jobLocation}
            onChangeText={setJobLocation}
            placeholder="e.g., Workshop / Plant / Pit / Bay number"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <View style={{ height: spacing(1) }} />

          <Text style={styles.label}>Supervisor / Responsible Person</Text>
          <TextInput
            value={supervisor}
            onChangeText={setSupervisor}
            placeholder="Name"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          {/* ✅ Shows the current "day key" so you know it’s saved for that day */}
          <Text style={styles.dayHint}>
            Saved for: {dayKeyRef.current} (resets automatically after 12:00)
          </Text>
        </Section>

        {sections.map((sec) => (
          <Section key={sec.id} title={sec.title}>
            {sec.items.map((it) => (
              <View key={it.id} style={styles.itemWrap}>
                <Text style={styles.itemText}>{it.label}</Text>

                <View style={styles.triRow}>
                  <Pressable
                    onPress={() => setStatus(sec.id, it.id, STATUS.YES)}
                    style={[
                      styles.triBtn,
                      it.status === STATUS.YES && styles.triBtnOnYes,
                    ]}
                  >
                    <Text style={[styles.triText, it.status === STATUS.YES && styles.triTextOn]}>Yes</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setStatus(sec.id, it.id, STATUS.NA)}
                    style={[
                      styles.triBtn,
                      it.status === STATUS.NA && styles.triBtnOnNA,
                    ]}
                  >
                    <Text style={[styles.triText, it.status === STATUS.NA && styles.triTextOn]}>N/A</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setStatus(sec.id, it.id, STATUS.NO)}
                    style={[
                      styles.triBtn,
                      it.status === STATUS.NO && styles.triBtnOnNo,
                    ]}
                  >
                    <Text style={[styles.triText, it.status === STATUS.NO && styles.triTextOn]}>No</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </Section>
        ))}

        <Section title="Ask Safety AI (optional)">
          <TextInput
            value={chatText}
            onChangeText={setChatText}
            placeholder="Ask about your work, safety, or concerns…"
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]}
            multiline
            editable={!chatBusy}
          />

          <Pressable
            onPress={onAsk}
            style={[styles.primaryBtn, chatBusy && { opacity: 0.7 }]}
            disabled={chatBusy}
          >
            {chatBusy ? (
              <ActivityIndicator color="#06130A" />
            ) : (
              <Text style={styles.primaryBtnText}>Ask</Text>
            )}
          </Pressable>

          {!!chatAnswer && (
            <View style={styles.answerBox}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{chatAnswer}</Text>
            </View>
          )}
        </Section>

        <View style={styles.footerRow}>
          <Pressable onPress={onReset} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Reset</Text>
          </Pressable>

          <Pressable onPress={onComplete} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Complete Checklist</Text>
          </Pressable>
        </View>

        <Text style={styles.smallHint}>
          Tip: If any item is “No”, stop and fix it before starting the task.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Header (same vibe as Home)
  stickyHeader: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    backgroundColor: SKP_BLUE,
    paddingHorizontal: spacing(2),
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.18)',
    zIndex: 10,
  },
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
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  headerChipText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 12,
  },

  // Cards
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    padding: spacing(1.5),
    marginBottom: spacing(1.5),
  },
  cardTitle: {
    color: colors.text,
    fontWeight: '900',
    marginBottom: 10,
    fontSize: 15,
  },

  label: {
    color: colors.muted,
    fontWeight: '800',
    marginBottom: 6,
    fontSize: 12,
  },

  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    padding: spacing(1.25),
    borderRadius: 12,
    fontWeight: '700',
  },
  taskBig: { minHeight: 90, textAlignVertical: 'top' },

  dayHint: {
    marginTop: 10,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },

  itemWrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.25),
    marginBottom: spacing(1),
    backgroundColor: '#FFFFFF',
  },
  itemText: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 14,
    lineHeight: 20,
  },

  triRow: {
    flexDirection: 'row',
    marginTop: spacing(1),
    gap: 10,
  },
  triBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
  },
  triText: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 13,
  },
  triTextOn: { color: '#FFFFFF' },

  triBtnOnYes: { backgroundColor: '#16A34A', borderColor: '#16A34A' },
  triBtnOnNA: { backgroundColor: '#475569', borderColor: '#475569' },
  triBtnOnNo: { backgroundColor: '#DC2626', borderColor: '#DC2626' },

  primaryBtn: {
    marginTop: spacing(1),
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  primaryBtnText: { color: '#06130A', fontWeight: '900' },

  secondaryBtn: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryBtnText: { color: colors.text, fontWeight: '900' },

  footerRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: spacing(1),
    marginBottom: spacing(1),
  },

  answerBox: {
    marginTop: spacing(1),
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing(1.25),
  },

  smallHint: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
    marginBottom: spacing(2),
  },
});



 

