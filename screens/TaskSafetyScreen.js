// screens/TaskSafetyScreen.js
import React, { useMemo, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { prependChecklistRun } from '../storage';
import { app } from '../firebase';

const colors = { bg:'#0B0F14', surface:'#131A22', text:'#E7EEF5', muted:'#A7B4C2', primary:'#00C853', border:'#1E2530' };
const spacing = (n=1)=>8*n;

// helpers OUTSIDE to avoid re-mount → keyboard blur
const Section = ({ title, children }) => (
  <View style={styles.card}>
    <Text style={styles.cardTitle}>{title}</Text>
    {children}
  </View>
);
const Bullet = ({ text }) => (
  <View style={{ flexDirection: 'row', marginTop: 6 }}>
    <Text style={{ color: colors.muted, marginRight: 8 }}>•</Text>
    <Text style={{ color: colors.text, flex: 1 }}>{text}</Text>
  </View>
);

const FN_REGION = 'us-central1';
const CLOUD_FN_URL = `https://${FN_REGION}-${app.options.projectId}.cloudfunctions.net/generateSafetyPlan`;

const BASE_CHECKS = [
  'PPE correct & worn (helmet, boots, eye/ear, gloves)',
  'Area inspected, hazards removed/barricaded',
  'Tools & equipment inspected (tags, guards, power cords)',
  'Permits in place (hot work / confined space / heights)',
  'LOTO / isolation for stored energy confirmed',
  'Emergency access, first aid & extinguisher available',
  'Good housekeeping — clear walkways, tidy cables',
  'Comms set (radio channel, spotter, hand signals)',
];

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

export default function TaskSafetyScreen() {
  const [task, setTask] = useState('');
  const [details, setDetails] = useState('');
  const [checks, setChecks] = useState(BASE_CHECKS.map((label, i) => ({ id: `c${i}`, label, ok: false })));
  const [insights, setInsights] = useState({ dos: [], donts: [], hazardsControls: [], wellness: [], ppe: [] });
  const [ppeChecks, setPpeChecks] = useState([]);
  const [loadingAI, setLoadingAI] = useState(false);

  const [chatText, setChatText] = useState('');
  const [chatAnswer, setChatAnswer] = useState('');
  const [chatBusy, setChatBusy] = useState(false);

  const hasTask = task.trim().length > 0;

  useEffect(() => {
    setPpeChecks((insights.ppe || []).map((label, i) => ({ id: `p${i}`, label, ok: false })));
  }, [insights.ppe]);

  const onToggle = (id) => setChecks(prev => prev.map(c => c.id === id ? { ...c, ok: !c.ok } : c));
  const onTogglePpe = (id) => setPpeChecks(prev => prev.map(c => c.id === id ? { ...c, ok: !c.ok } : c));

  // Cloud function calls
  const callPlan = async ({ task, details, locale }) => {
    const res = await fetch(CLOUD_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan', task, details, locale }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.data) throw new Error(json?.error || 'Request failed');
    return json.data;
  };

  const callChat = async ({ question, task, locale }) => {
    const res = await fetch(CLOUD_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', question, task, locale }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.data) throw new Error(json?.error || 'Request failed');
    return json.data;
  };

  const onGenerate = async () => {
    if (loadingAI) return;
    const t = task.trim(), d = details.trim();
    setLoadingAI(true);
    try {
      const data = await callPlan({ task: t || 'General task', details: d, locale: 'en' });
      setInsights(data);
    } catch {
      Alert.alert('Using offline tips', 'Network/limit issue—showing on-device guidance.');
    } finally {
      setLoadingAI(false);
    }
  };

  const onAsk = async () => {
    const q = chatText.trim();
    if (!q || chatBusy) return;
    setChatBusy(true);
    setChatAnswer('Thinking…');
    try {
      const data = await callChat({ question: q, task: hasTask ? task.trim() : '', locale: 'en' });
      setChatAnswer((data?.answer || '').trim() || 'No answer.');
    } catch {
      setChatAnswer('Offline: follow supervisor instructions and standard procedures.');
    } finally {
      setChatBusy(false);
    }
  };

  const renderChecks = useMemo(() => (
    checks.map((c) => (
      <TouchableOpacity key={c.id} onPress={() => onToggle(c.id)} activeOpacity={0.7} style={styles.checkRow}>
        <Text style={[styles.checkIcon, c.ok && styles.checkIconOn]}>{c.ok ? '☑️' : '⬜️'}</Text>
        <Text style={[styles.checkLabel, c.ok && styles.checkLabelOn]}>{c.label}</Text>
      </TouchableOpacity>
    ))
  ), [checks]);

  const renderPpeChecks = useMemo(() => (
    (ppeChecks || []).map((c) => (
      <TouchableOpacity key={c.id} onPress={() => onTogglePpe(c.id)} activeOpacity={0.7} style={styles.checkRow}>
        <Text style={[styles.checkIcon, c.ok && styles.checkIconOn]}>{c.ok ? '☑️' : '⬜️'}</Text>
        <Text style={[styles.checkLabel, c.ok && styles.checkLabelOn]}>{c.label}</Text>
      </TouchableOpacity>
    ))
  ), [ppeChecks]);

  const onComplete = async () => {
    if (!hasTask) return Alert.alert('Task required', 'Please enter what you’ll be busy with.');
    try {
      const run = {
        id: uid(),
        task: task.trim(),
        details: details.trim(),
        checks,
        ppeChecks,
        insights,
        createdAt: Date.now(),
      };
      await prependChecklistRun(run);
      Alert.alert('Logged', 'Task safety checklist saved.');
    } catch (e) {
      Alert.alert('Save error', String(e?.message || e));
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top','right','bottom','left']}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(4) }}
        keyboardShouldPersistTaps="always"
      >
        <Section title="Task">
          <TextInput
            value={task}
            onChangeText={setTask}
            placeholder="What are you going to be busy with?"
            placeholderTextColor={colors.muted}
            style={styles.input}
            editable={!loadingAI}
          />
          <TextInput
            value={details}
            onChangeText={setDetails}
            placeholder="Additional details (optional)"
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 90, textAlignVertical: 'top' }]}
            multiline
            editable={!loadingAI}
          />
          <TouchableOpacity
            onPress={loadingAI ? undefined : onGenerate}
            activeOpacity={loadingAI ? 1 : 0.8}
            style={[styles.generateBtn, loadingAI && { opacity: 0.7 }]}
            disabled={loadingAI}
          >
            {loadingAI ? <ActivityIndicator color="#06130A" /> : <Text style={styles.generateBtnText}>Generate safety plan</Text>}
          </TouchableOpacity>
        </Section>

        <Section title="Pre-task Checklist">{renderChecks}</Section>

        <Section title="PPE Checklist for this task">
          {(insights.ppe?.length ? renderPpeChecks : <Text style={styles.emptyText}>Generate to see task-specific PPE.</Text>)}
        </Section>

        <Section title="Do’s">
          {insights.dos?.length ? insights.dos.slice(0,10).map((t, i) => <Bullet key={`d-${i}`} text={t} />) : <Text style={styles.emptyText}>Tap “Generate safety plan”.</Text>}
        </Section>

        <Section title="Don’ts">
          {insights.donts?.length ? insights.donts.slice(0,10).map((t, i) => <Bullet key={`dn-${i}`} text={t} />) : <Text style={styles.emptyText}>Tap “Generate safety plan”.</Text>}
        </Section>

        <Section title="Common hazards & controls">
          {insights.hazardsControls?.length
            ? insights.hazardsControls.map((h, i) => (
              <View key={`hc-${i}`} style={{ marginTop: 6 }}>
                <Text style={{ color: colors.text, fontWeight: '800' }}>Hazard:</Text>
                <Text style={{ color: colors.text }}>{h.hazard}</Text>
                <Text style={{ color: colors.muted, marginTop: 2 }}>Control:</Text>
                <Text style={{ color: colors.text }}>{h.control}</Text>
              </View>
            ))
            : <Text style={styles.emptyText}>Generate to see hazards & controls for this task.</Text>}
        </Section>

        <Section title="Stay healthy & focused">
          {insights.wellness?.length ? insights.wellness.map((t, i) => <Bullet key={`w-${i}`} text={t} />) : <Text style={styles.emptyText}>Tap “Generate safety plan”.</Text>}
        </Section>

        <Section title="Ask Safety AI (optional)">
          <TextInput
            value={chatText}
            onChangeText={setChatText}
            placeholder="Ask about your work, safety, or complaints…"
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 70, textAlignVertical: 'top' }]}
            multiline
            editable={!chatBusy}
          />
          <TouchableOpacity onPress={onAsk} activeOpacity={chatBusy ? 1 : 0.8} style={[styles.generateBtn, chatBusy && { opacity: 0.7 }]} disabled={chatBusy}>
            {chatBusy ? <ActivityIndicator color="#06130A" /> : <Text style={styles.generateBtnText}>Ask</Text>}
          </TouchableOpacity>
          {!!chatAnswer && (
            <View style={{ marginTop: spacing(1), backgroundColor:'#0F151C', borderWidth:1, borderColor:colors.border, borderRadius:10, padding: spacing(1) }}>
              <Text style={{ color: colors.text }}>{chatAnswer}</Text>
            </View>
          )}
        </Section>

        <TouchableOpacity
          onPress={onComplete}
          activeOpacity={0.8}
          style={[styles.completeBtn, !hasTask && { opacity: 0.6 }]}
          disabled={!hasTask}
        >
          <Text style={styles.completeBtnText}>Complete</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: 12, padding: spacing(1.5), marginBottom: spacing(1.5),
  },
  cardTitle: { color: colors.text, fontWeight: '800', marginBottom: 8, fontSize: 15 },
  input: {
    backgroundColor: '#0F151C', borderWidth: 1, borderColor: colors.border, color: colors.text,
    padding: spacing(1.25), borderRadius: 10, marginBottom: spacing(1),
  },
  generateBtn: {
    backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 10, alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)',
  },
  generateBtnText: { color: '#06130A', fontWeight: '900' },
  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8 },
  checkIcon: { width: 26, textAlign: 'center', color: colors.muted },
  checkIconOn: { color: colors.text },
  checkLabel: { color: colors.muted, flex: 1, fontSize: 14, fontWeight: '700' },
  checkLabelOn: { color: colors.text },
  emptyText: { color: colors.muted, fontStyle: 'italic' },
  completeBtn: { marginTop: spacing(1), backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  completeBtnText: { color: '#06130A', fontWeight: '900' },
});




//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//