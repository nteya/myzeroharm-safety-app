// screens/AssessmentScreen.js
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, Alert, FlatList, ActivityIndicator
} from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth } from '../firebase';

const colors = { bg:'#0B0F14', surface:'#131A22', text:'#E7EEF5', muted:'#A7B4C2', primary:'#00C853', border:'#1E2530' };
const spacing = (n=1)=>8*n;

// === Cloud Function endpoint ===
// 🔁 Replace YOUR_PROJECT_ID with your Firebase project id (exactly as shown by `firebase use`)
const FUNCTIONS_URL = 'https://us-central1-therapy-7bef0.cloudfunctions.net/generateSafetyPlan';

// ---------- Helpers ----------
const todayYMD = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const STORAGE_KEY_ATTEMPT = (dateKey, uid) => `QUIZ_DAY_V1:${dateKey}:${uid || 'anon'}`;

// ⏱ Global time: 5 min 30 s = 330 seconds for all questions
const TOTAL_SECONDS = 330;

export default function AssessmentScreen() {
  const uid = auth.currentUser?.uid || null;
  const dateKey = useMemo(() => todayYMD(), []);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [questions, setQuestions] = useState([]);   // from server
  const [revealAt, setRevealAt] = useState(null);   // ms
  const [fromTag, setFromTag] = useState('');       // 'ai' | 'fallback' | 'cache'

  // attempt state
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState([]);       // true/false for tf, 0..3 for mc, null for blank
  const [secondsLeft, setSecondsLeft] = useState(TOTAL_SECONDS);
  const [submitted, setSubmitted] = useState(false);
  const [storedAttempt, setStoredAttempt] = useState(null); // prior saved payload
  const [answerKey, setAnswerKey] = useState(undefined);    // fetched after reveal

  const timerRef = useRef(null);

  // ---------- robust fetch + JSON handling ----------
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      // Likely HTML page on flaky networks — show a friendly message
      /* eslint-disable no-unused-vars */
      const _text = await res.text().catch(()=> '');
      /* eslint-enable no-unused-vars */
      throw new Error('Network issue — please try again.');
    }
    const payload = await res.json().catch(()=>null);
    if (!payload) throw new Error('Network issue — please try again.');
    if (!res.ok) {
      const msg = payload?.error || 'Network issue — please try again.';
      throw new Error(msg);
    }
    return payload;
  }

  const fetchQuestions = async (withReveal = false) => {
    setLoadError('');
    try {
      const json = await postJson(FUNCTIONS_URL, {
        mode: 'assessmentDaily',
        date: dateKey,
        ...(withReveal ? { reveal: true } : {})
      });

      const data = json?.data || {};
      const qs = Array.isArray(data.questions) ? data.questions : [];
      setQuestions(qs);
      setFromTag(data.from || '');
      const rev = typeof data.revealAt === 'number' ? data.revealAt : Date.now();
      setRevealAt(rev);
      if (withReveal && Array.isArray(data.answerKey)) {
        setAnswerKey(data.answerKey);
      }
      if (!answers.length && qs.length) setAnswers(Array(qs.length).fill(null));
      // fresh load → reset timer only if we didn't already have progress
      if (!storedAttempt?.submittedAt) {
        setSecondsLeft((prev) => (prev <= 0 || prev > TOTAL_SECONDS ? TOTAL_SECONDS : prev));
      }
    } catch (e) {
      setLoadError('Network issue — please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Initial load (questions only)
  useEffect(() => {
    fetchQuestions(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey]);

  // Load any prior attempt for TODAY
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY_ATTEMPT(dateKey, uid));
        if (!raw) return;
        const parsed = JSON.parse(raw);
        setStoredAttempt(parsed || null);
        if (Array.isArray(parsed?.answers)) setAnswers(parsed.answers);
        if (parsed?.submittedAt) setSubmitted(true);
        if (typeof parsed?.revealAt === 'number') setRevealAt(parsed.revealAt);
        if (typeof parsed?.secondsLeft === 'number') {
          setSecondsLeft(Math.max(0, Math.min(TOTAL_SECONDS, parsed.secondsLeft)));
        }
        if (typeof parsed?.index === 'number') setIndex(Math.max(0, Math.min((questions.length || 1)-1, parsed.index)));
      } catch {}
    })();
  }, [dateKey, uid]);

  // Derived: is submission done & can we reveal?
  const nowMs = Date.now();
  const attemptSubmitted = submitted || !!storedAttempt?.submittedAt;
  const canReveal = !!revealAt && attemptSubmitted && nowMs >= revealAt;

  // After reveal time + submitted, try to fetch answerKey (once).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (canReveal && answerKey === undefined) {
        try {
          const json = await postJson(FUNCTIONS_URL, {
            mode: 'assessmentDaily',
            date: dateKey,
            reveal: true
          });
          if (!cancelled && json?.data?.answerKey && Array.isArray(json.data.answerKey)) {
            setAnswerKey(json.data.answerKey);
          }
        } catch {
          // user can retry via "Check again"
        }
      }
    })();
    return () => { cancelled = true; };
  }, [canReveal, dateKey, answerKey]);

  // Start global timer (auto-submit on 0)
  useEffect(() => {
    if (submitted) return;
    if (!questions.length) return;
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        const next = s - 1;
        if (next <= 0) {
          clearInterval(timerRef.current);
          // autosubmit once time is up
          onSubmit(true);
          return 0;
        }
        // persist progress periodically (lightweight)
        if (next % 5 === 0) {
          saveProgress({ secondsLeft: next, index });
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, questions.length]);

  const saveProgress = async (partial = {}) => {
    try {
      const payload = {
        dateKey,
        uid: uid || null,
        answers,
        index,
        secondsLeft,
        submittedAt: submitted ? (partial.submittedAt || Date.now()) : (partial.submittedAt ?? null),
        revealAt: revealAt ?? null,
        total: questions.length,
        secondsTotal: TOTAL_SECONDS,
        questionsVersion: 'v1',
        ...partial,
      };
      await AsyncStorage.setItem(STORAGE_KEY_ATTEMPT(dateKey, uid), JSON.stringify(payload));
      setStoredAttempt(payload);
    } catch {}
  };

  const pickAnswerTF = async (value) => {
    if (submitted || secondsLeft <= 0) return;
    const next = [...answers];
    next[index] = !!value;
    setAnswers(next);
    await saveProgress({ answers: next });
  };

  const pickAnswerMC = async (i) => {
    if (submitted || secondsLeft <= 0) return;
    const next = [...answers];
    next[index] = i;
    setAnswers(next);
    await saveProgress({ answers: next });
  };

  const goPrev = async () => {
    if (submitted || secondsLeft <= 0) return;
    setIndex((i) => {
      const ni = Math.max(0, i - 1);
      // persist current index
      saveProgress({ index: ni });
      return ni;
    });
  };

  const goNext = async () => {
    if (submitted || secondsLeft <= 0) return;
    const total = questions.length || 0;
    setIndex((i) => {
      const ni = Math.min(total - 1, i + 1);
      saveProgress({ index: ni });
      return ni;
    });
  };

  const onSubmit = async (auto = false) => {
    if (submitted) return;
    if (!questions.length) return;
    setSubmitted(true);
    await saveProgress({ submittedAt: Date.now(), secondsLeft: Math.max(0, secondsLeft) });
    const when = new Date(revealAt || Date.now());
    const hh = String(when.getHours()).padStart(2,'0');
    const mm = String(when.getMinutes()).padStart(2,'0');
    if (!auto) {
      Alert.alert('Submitted', `Thanks — your results will be available after ${when.toDateString()} • ${hh}:${mm}.`);
    }
  };

  // ---------- Derived UI states ----------
  const q = questions[index];

  const formatTime = (s=0) => {
    const m = Math.floor(s/60);
    const ss = s % 60;
    return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  };

  // When results are available, compute grading using answerKey from server
  const result = useMemo(() => {
    if (!canReveal) return null;
    if (!Array.isArray(answerKey) || !answerKey.length) return null;
    if (!questions.length) return null;
    const ans = storedAttempt?.answers || answers;
    let score = 0;
    const detail = questions.map((qq, i) => {
      let correct = false;
      const k = answerKey[i];
      if (qq.type === 'tf') {
        correct = ans[i] === k;
      } else {
        correct = typeof ans[i] === 'number' && ans[i] === k;
      }
      if (correct) score += 1;
      return { i, correct };
    });
    return { score, total: questions.length, detail, answers: ans };
  }, [canReveal, answerKey, questions, storedAttempt, answers]);

  // ---------- UI ----------
  const Header = () => (
    <View style={styles.header}>
      <Text style={styles.title}>Daily Safety Assessment</Text>
      <Text style={styles.subtle}>15 questions • 5m30s total</Text>
      {fromTag ? <Text style={styles.subtle}>Source: {fromTag}</Text> : null}
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <Header />
        <View style={[styles.card, { alignItems:'center' }]}>
          <ActivityIndicator />
          <Text style={[styles.text, { marginTop: 8 }]}>Loading today’s questions…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loadError || !questions.length) {
    return (
      <SafeAreaView style={styles.root}>
        <Header />
        <View style={styles.card}>
          <Text style={styles.lockTitle}>Couldn’t load questions</Text>
          <Text style={styles.text}>{loadError || 'No questions available.'}</Text>
          <TouchableOpacity
            style={[styles.nextBtn, { alignSelf:'flex-start', marginTop: spacing(1.25) }]}
            onPress={() => { setLoading(true); fetchQuestions(false); }}
          >
            <Text style={styles.nextText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Already submitted and waiting for reveal
  if (attemptSubmitted && !canReveal) {
    const dt = new Date(revealAt || Date.now());
    const hh = String(dt.getHours()).padStart(2,'0');
    const mm = String(dt.getMinutes()).padStart(2,'0');
    return (
      <SafeAreaView style={styles.root}>
        <Header />
        <View style={styles.card}>
          <Text style={styles.lockTitle}>Submitted</Text>
          <Text style={styles.text}>Your answers are locked. Results will be visible after</Text>
          <Text style={styles.textStrong}>{dt.toDateString()} • {hh}:{mm}</Text>
          <TouchableOpacity
            style={[styles.nextBtn, { alignSelf:'flex-start', marginTop: spacing(1.25) }]}
            onPress={() => fetchQuestions(true)}
          >
            <Text style={styles.nextText}>Check again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Results
  if (result) {
    return (
      <SafeAreaView style={styles.root}>
        <Header />
        <View style={styles.card}>
          <Text style={styles.scoreTitle}>Your Result for {dateKey}</Text>
          <Text style={styles.scoreValue}>{result.score} / {result.total}</Text>
        </View>

        <FlatList
          data={questions}
          keyExtractor={(qq)=>qq.id}
          contentContainerStyle={{ padding: spacing(2), paddingTop: 0 }}
          renderItem={({ item: qq, index: i }) => {
            const userAns = result.answers[i];
            const k = answerKey[i];
            let isCorrect = false;
            let correctLabel = '';
            let userLabel = '';
            if (qq.type === 'tf') {
              isCorrect = userAns === k;
              correctLabel = k ? 'True' : 'False';
              userLabel = userAns === null ? '—' : (userAns ? 'True' : 'False');
            } else {
              isCorrect = typeof userAns === 'number' && userAns === k;
              correctLabel = qq.options[k];
              userLabel = typeof userAns === 'number' ? qq.options[userAns] : '—';
            }

            return (
              <View style={styles.reviewItem}>
                <Text style={styles.qText}>{i+1}. {qq.text}</Text>
                {qq.type === 'mc' ? (
                  <Text style={styles.reviewMeta}>Options: {qq.options.join(' • ')}</Text>
                ) : null}
                <Text style={[styles.reviewMeta, { marginTop: 6 }]}>
                  Your answer: <Text style={{ color: colors.text }}>{userLabel}</Text>
                </Text>
                <Text style={styles.reviewMeta}>
                  Correct answer: <Text style={{ color: isCorrect ? colors.primary : '#FFB4B4' }}>{correctLabel}</Text>
                </Text>
              </View>
            );
          }}
        />
      </SafeAreaView>
    );
  }

  // Active quiz UI
  const tfSelectedTrue = q && answers[index] === true;
  const tfSelectedFalse = q && answers[index] === false;
  const progressPct = Math.max(0, Math.min(100, (secondsLeft / TOTAL_SECONDS) * 100));

  return (
    <SafeAreaView style={styles.root}>
      <Header />
      <View style={styles.progressRow}>
        <Text style={styles.progressText}>Question {index+1}/{questions.length}</Text>
        <Text style={styles.progressText}>⏱ {formatTime(secondsLeft)}</Text>
      </View>
      <View style={styles.timeBar}>
        <View style={[styles.timeFill, { width: `${progressPct}%` }]} />
      </View>

      <View style={styles.card}>
        <Text style={styles.qText}>{q?.text}</Text>

        {q?.type === 'tf' ? (
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.opt, tfSelectedTrue && styles.optOn]}
              onPress={() => pickAnswerTF(true)}
              activeOpacity={0.8}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ selected: tfSelectedTrue }}
              disabled={submitted || secondsLeft <= 0}
            >
              <Text style={styles.optTick}>{tfSelectedTrue ? '✓ ' : ''}</Text>
              <Text style={[styles.optText, tfSelectedTrue && styles.optTextOn]}>True</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.opt, tfSelectedFalse && styles.optOn]}
              onPress={() => pickAnswerTF(false)}
              activeOpacity={0.8}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ selected: tfSelectedFalse }}
              disabled={submitted || secondsLeft <= 0}
            >
              <Text style={styles.optTick}>{tfSelectedFalse ? '✓ ' : ''}</Text>
              <Text style={[styles.optText, tfSelectedFalse && styles.optTextOn]}>False</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ marginTop: spacing(1) }}>
            {Array.isArray(q?.options) ? q.options.map((opt, i) => {
              const on = answers[index] === i;
              return (
                <TouchableOpacity
                  key={`o-${i}`}
                  style={[styles.opt, on && styles.optOn]}
                  onPress={() => pickAnswerMC(i)}
                  activeOpacity={0.8}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  disabled={submitted || secondsLeft <= 0}
                >
                  <Text style={styles.optTick}>{on ? '✓ ' : ''}</Text>
                  <Text style={[styles.optText, on && styles.optTextOn]}>{opt}</Text>
                </TouchableOpacity>
              );
            }) : null}
          </View>
        )}

        {/* Nav row: Previous / Next (or Submit on last) */}
        <View style={{ flexDirection:'row', justifyContent:'space-between', marginTop: spacing(2) }}>
          <TouchableOpacity
            onPress={goPrev}
            style={[styles.prevBtn, (index===0 || submitted || secondsLeft<=0) && { opacity: 0.5 }]}
            activeOpacity={0.85}
            hitSlop={10}
            disabled={index===0 || submitted || secondsLeft<=0}
          >
            <Text style={styles.prevText}>Previous</Text>
          </TouchableOpacity>

          {index < questions.length - 1 ? (
            <TouchableOpacity
              onPress={goNext}
              style={[styles.nextBtn, (submitted || secondsLeft<=0) && { opacity: 0.5 }]}
              activeOpacity={0.85}
              hitSlop={10}
              disabled={submitted || secondsLeft<=0}
            >
              <Text style={styles.nextText}>Next</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => onSubmit(false)}
              style={[styles.nextBtn, (submitted || secondsLeft<=0) && { opacity: 0.5 }]}
              activeOpacity={0.85}
              hitSlop={10}
              disabled={submitted || secondsLeft<=0}
            >
              <Text style={styles.nextText}>Submit</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:{ flex:1, backgroundColor: colors.bg },
  header:{ padding: spacing(2), paddingBottom: spacing(1) },
  title:{ color: colors.text, fontSize: 18, fontWeight:'900' },
  subtle:{ color: colors.muted, fontSize: 12, marginTop: 4 },

  progressRow:{ flexDirection:'row', justifyContent:'space-between', alignItems:'center', paddingHorizontal: spacing(2), marginTop: spacing(0.5) },
  progressText:{ color: colors.muted, fontWeight:'800' },
  timeBar:{ height: 6, marginHorizontal: spacing(2), marginTop: 6, backgroundColor:'#11202B', borderRadius: 999, overflow:'hidden', borderWidth:1, borderColor: colors.border },
  timeFill:{ height:'100%', backgroundColor: colors.primary },

  card:{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: spacing(2), margin: spacing(2), marginTop: spacing(1.5) },
  qText:{ color: colors.text, fontSize: 16, fontWeight:'800' },

  row:{ flexDirection:'row', gap: spacing(1), marginTop: spacing(1.5) },

  opt:{ flexDirection:'row', alignItems:'center', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.muted, backgroundColor:'transparent', marginTop: spacing(1) },
  optOn:{ backgroundColor: colors.primary, borderColor:'rgba(0,0,0,0.25)' },
  optTick:{ color: colors.text, fontWeight:'900', marginRight: 6 },
  optText:{ color: colors.text, fontWeight:'800' },
  optTextOn:{ color:'#06130A' },

  prevBtn:{ alignSelf:'flex-start', backgroundColor:'#0F151C', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.border },
  prevText:{ color: colors.text, fontWeight:'900' },

  nextBtn:{ alignSelf:'flex-end', backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)' },
  nextText:{ color:'#06130A', fontWeight:'900' },

  lockTitle:{ color: colors.text, fontWeight:'900', fontSize: 16, marginBottom: 6 },
  text:{ color: colors.muted },
  textStrong:{ color: colors.text, fontWeight:'900', marginTop: 4 },

  scoreTitle:{ color: colors.muted, fontWeight:'800', marginBottom: 4 },
  scoreValue:{ color: colors.text, fontWeight:'900', fontSize: 24 },

  reviewItem:{ backgroundColor: colors.surface, borderRadius: 12, borderWidth:1, borderColor: colors.border, padding: spacing(1.5), marginBottom: spacing(1) },
  reviewMeta:{ color: colors.muted, fontSize: 12 },
});
