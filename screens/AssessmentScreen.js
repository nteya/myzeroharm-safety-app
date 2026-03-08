// screens/AssessmentScreen.js
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  StatusBar,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { Video, ResizeMode } from "expo-av";

import { db, auth } from "../firebase";
import {
  doc,
  onSnapshot,
  updateDoc,
  arrayUnion,
  serverTimestamp,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  writeBatch,
} from "firebase/firestore";

const SKP_BLUE = "#003A8F";
const HEADER_BAR_HEIGHT = 64;

const colors = {
  bg: "#F7F4F6",
  surface: "#FFFFFF",
  text: "#0F172A",
  muted: "#64748B",
  border: "#E6E1E7",
  primary: "#00C853",
  danger: "#DC2626",
};

const spacing = (n = 1) => 8 * n;
const radius = 16;

const LIKER_ID_KEY = "LIKER_ID_V1";

// ✅ v5 attempt key: (assessment + uid + supervisorKey) so you can reuse the same assessment with different supervisors
const ATTEMPT_KEY_V5 = (assessmentId, uid, supervisorKey) =>
  `SKP_ASSESS_ATTEMPT_V5:${assessmentId}:${uid || "anon"}:${supervisorKey || "nosup"}`;

const makeDeviceId = () =>
  `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function formatTime(s = 0) {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function isPhotoAnswer(v) {
  return v && typeof v === "object" && !!v.photoLocalUri;
}
function isYesNoNaAnswer(v) {
  return v && typeof v === "object" && typeof v.choice === "string";
}

function friendlyLoadError(err) {
  const msg = String(err?.message || "").toLowerCase();
  if (msg.includes("permission")) return "Permission denied. Check Firestore rules.";
  if (msg.includes("network")) return "Network issue. Please check your connection.";
  if (msg.includes("index"))
    return "Firestore index required for this query. (We can avoid the query.)";
  return "Could not load assessment. Please try again.";
}

// ✅ Normalize supervisor so duplicates (case/spaces) are treated the same
function normalizeSupervisorName(name = "") {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export default function AssessmentScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();

  const routeAssessmentId = route?.params?.assessmentId || "latest";
  const mode = route?.params?.mode || "worker"; // "preview" | "worker"
  const isPreview = mode === "preview";

  const [deviceId, setDeviceId] = useState(null);

  const [resolvedAssessmentId, setResolvedAssessmentId] = useState(
    routeAssessmentId === "latest" ? "" : routeAssessmentId
  );

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [assessment, setAssessment] = useState(null);

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [submittedAt, setSubmittedAt] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // ✅ Supervisor gate (ALWAYS ask on open)
  const [supervisorName, setSupervisorName] = useState("");
  const [supervisorModalVisible, setSupervisorModalVisible] = useState(false);

  // ✅ This is the “current session supervisorKey” used for attempt key + duplicate checks
  const [supervisorKey, setSupervisorKey] = useState("");
  const hasSupervisorName = supervisorKey.length >= 2;

  const timerRef = useRef(null);

  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerUri, setViewerUri] = useState("");
  const [viewerLoading, setViewerLoading] = useState(false);

  const headerTotalHeight = HEADER_BAR_HEIGHT + insets.top;
  const uid = auth.currentUser?.uid || null;

  const goBack = () => {
    if (navigation?.canGoBack?.()) navigation.goBack();
    else navigation.navigate("Home");
  };

  // Ensure deviceId
  useEffect(() => {
    (async () => {
      try {
        const existing = await AsyncStorage.getItem(LIKER_ID_KEY);
        if (existing) return setDeviceId(existing);
        const id = makeDeviceId();
        await AsyncStorage.setItem(LIKER_ID_KEY, id);
        setDeviceId(id);
      } catch {
        setDeviceId(makeDeviceId());
      }
    })();
  }, []);

  /**
   * ✅ Resolve "latest" using pointer doc: /assessments/latest { latestId }
   * This avoids query indexes + avoids "no docs found" issues.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (routeAssessmentId !== "latest") return;

      try {
        setLoading(true);
        setLoadError("");
        setAssessment(null);

        // 1) Try pointer doc
        const pointerRef = doc(db, "assessments", "latest");
        const pointerSnap = await getDoc(pointerRef);

        const latestId = pointerSnap.exists() ? pointerSnap.data()?.latestId : null;

        if (latestId && typeof latestId === "string") {
          if (!cancelled) setResolvedAssessmentId(latestId);
          return;
        }

        // 2) Fallback: query last published (ignores the "latest" pointer doc by requiring status field)
        const qy = query(
          collection(db, "assessments"),
          where("status", "==", "published"),
          orderBy("createdAt", "desc"),
          limit(1)
        );

        const snap = await getDocs(qy);
        const first = snap.docs?.[0];

        if (!first) {
          if (!cancelled) {
            setResolvedAssessmentId("");
            setAssessment(null);
            setLoadError("No assessment available right now.");
            setLoading(false);
          }
          return;
        }

        if (!cancelled) setResolvedAssessmentId(first.id);
      } catch (e) {
        if (!cancelled) {
          setResolvedAssessmentId("");
          setLoadError(friendlyLoadError(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeAssessmentId]);

  // Listen to assessment doc (resolved id)
  useEffect(() => {
    if (!resolvedAssessmentId) return;

    setLoading(true);
    setLoadError("");

    const targetRef = doc(db, "assessments", resolvedAssessmentId);

    const unsub = onSnapshot(
      targetRef,
      async (snap) => {
        try {
          if (!snap.exists()) {
            setAssessment(null);
            setLoadError("No assessment available right now.");
            setLoading(false);
            return;
          }

          const data = snap.data() || {};
          const qList = Array.isArray(data.questions) ? data.questions : [];

          const createdAtMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : null;

          // ✅ IMPORTANT: match CreateAssessmentScreen payload:
          // - instructions
          // - context: { text, imageUrl, videoUrl }
          // - media: [{type,url,caption}]
          const instructions = String(data.instructions || "").trim();
          const contextText = String(data.context?.text || "").trim();
          const contextImageUrl = String(data.context?.imageUrl || "");
          const contextVideoUrl = String(data.context?.videoUrl || "");
          const media = Array.isArray(data.media) ? data.media : [];

          // ✅ workers get 20 min if doc missing
          const timeLimitSecFromDoc =
            typeof data.timeLimitSec === "number" && data.timeLimitSec > 0
              ? data.timeLimitSec
              : 1200;

          const normalized = {
            id: snap.id,
            title: data.title || "Safety Assessment",
            instructions,
            context: {
              text: contextText,
              imageUrl: contextImageUrl,
              videoUrl: contextVideoUrl,
            },
            media,
            timeLimitSec: timeLimitSecFromDoc,
            createdAtMs,
            questions: qList,
            status: data.status || "published",
            createdBy: data.createdBy || null,
          };

          setAssessment(normalized);

          // Ensure answers length matches
          setAnswers((prev) => {
            if (prev?.length === qList.length) return prev;
            const next = Array(qList.length).fill(null);
            for (let i = 0; i < Math.min(prev.length, next.length); i++) next[i] = prev[i];
            return next;
          });

          // Preview mode: no timer, no attempt load
          if (isPreview) {
            setSecondsLeft(0);
            setSubmittedAt(null);
            setIndex(0);
            setSupervisorModalVisible(false);
            setLoading(false);
            return;
          }

          // ✅ ALWAYS ask supervisor name on open (your requirement)
          setSupervisorName("");
          setSupervisorKey("");
          setSupervisorModalVisible(true);

          // Reset view state (we will restore if needed after supervisor is chosen)
          setSubmittedAt(null);
          setIndex(0);
          setSecondsLeft(timeLimitSecFromDoc);

          setLoading(false);
        } catch (e) {
          setLoadError(friendlyLoadError(e));
          setLoading(false);
        }
      },
      (e) => {
        setLoadError(friendlyLoadError(e));
        setLoading(false);
      }
    );

    return () => unsub && unsub();
  }, [resolvedAssessmentId, uid, isPreview]);

  const persistAttempt = useCallback(
    async (partial = {}) => {
      try {
        if (!assessment?.id) return;
        if (isPreview) return;
        if (!supervisorKey) return;

        const payload = {
          assessmentId: assessment.id,
          uid: uid || null,
          deviceId: deviceId || null,

          supervisorName: supervisorName || "",
          supervisorKey: supervisorKey || "",

          answers,
          index,
          secondsLeft,
          submittedAt: submittedAt || null,
          updatedAt: Date.now(),
          ...partial,
        };
        await AsyncStorage.setItem(
          ATTEMPT_KEY_V5(assessment.id, uid, supervisorKey),
          JSON.stringify(payload)
        );
      } catch {}
    },
    [
      assessment?.id,
      uid,
      deviceId,
      supervisorName,
      supervisorKey,
      answers,
      index,
      secondsLeft,
      submittedAt,
      isPreview,
    ]
  );

  const isSubmitted = !!submittedAt;

  // ✅ Timer only in worker mode (starts ONLY after supervisor is confirmed)
  useEffect(() => {
    if (isPreview) return;
    if (!assessment?.questions?.length) return;
    if (isSubmitted) return;

    // don’t start timer until supervisor chosen
    if (!hasSupervisorName) {
      clearInterval(timerRef.current);
      return;
    }

    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        const next = s - 1;
        if (next <= 0) {
          clearInterval(timerRef.current);
          onSubmit(true);
          return 0;
        }
        if (next % 5 === 0) persistAttempt({ secondsLeft: next, index });
        return next;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessment?.id, assessment?.questions?.length, isSubmitted, isPreview, hasSupervisorName]);

  useEffect(() => {
    if (!assessment?.questions?.length) return;
    setIndex((i) => clamp(i, 0, Math.max(0, assessment.questions.length - 1)));
  }, [assessment?.questions?.length]);

  const openViewer = (uri) => {
    if (!uri) return;
    setViewerUri(uri);
    setViewerVisible(true);
  };

  const requireSupervisorGate = () => {
    if (isPreview) return false;
    if (isSubmitted || secondsLeft <= 0) return false;
    if (hasSupervisorName) return false;
    setSupervisorModalVisible(true);
    return true;
  };

  const pickAnswerTF = async (val) => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    const next = [...answers];
    next[index] = !!val;
    setAnswers(next);
    await persistAttempt({ answers: next });
  };

  const pickAnswerMC = async (choiceIndex) => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    const next = [...answers];
    next[index] = choiceIndex;
    setAnswers(next);
    await persistAttempt({ answers: next });
  };

  const pickAnswerYesNoNa = async (choice) => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    const next = [...answers];
    next[index] = { choice };
    setAnswers(next);
    await persistAttempt({ answers: next });
  };

  const setAnswerText = async (text) => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    const next = [...answers];
    next[index] = String(text || "");
    setAnswers(next);
    await persistAttempt({ answers: next });
  };

  const attachPhotoAnswer = async () => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        return Alert.alert("Permission needed", "Camera permission is required.");
      }
      const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
      if (res.canceled) return;

      const uri = res.assets?.[0]?.uri || "";
      if (!uri) return;

      const next = [...answers];
      next[index] = { photoLocalUri: uri };
      setAnswers(next);
      await persistAttempt({ answers: next });
    } catch {
      Alert.alert("Photo error", "Could not take photo.");
    }
  };

  const removePhotoAnswer = async () => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    const next = [...answers];
    next[index] = null;
    setAnswers(next);
    await persistAttempt({ answers: next });
  };

  const goPrev = async () => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    setIndex((i) => {
      const ni = Math.max(0, i - 1);
      persistAttempt({ index: ni });
      return ni;
    });
  };

  const goNext = async () => {
    if (isPreview) return;
    if (requireSupervisorGate()) return;
    if (isSubmitted || secondsLeft <= 0) return;
    const total = assessment?.questions?.length || 0;
    setIndex((i) => {
      const ni = Math.min(total - 1, i + 1);
      persistAttempt({ index: ni });
      return ni;
    });
  };

  const sanitizeAnswersForFirestore = (qs, ans) => {
    return (qs || []).map((qq, i) => {
      const a = ans?.[i];

      if (qq.type === "photo")
        return { type: "photo", value: isPhotoAnswer(a) ? { photo: true } : null };
      if (qq.type === "yes_no_na")
        return { type: "yes_no_na", value: isYesNoNaAnswer(a) ? a.choice : null };
      if (qq.type === "tf") return { type: "tf", value: typeof a === "boolean" ? a : null };
      if (qq.type === "mc") return { type: "mc", value: typeof a === "number" ? a : null };
      if (qq.type === "text_short" || qq.type === "text_long")
        return { type: qq.type, value: typeof a === "string" ? a.trim() : "" };

      return { type: qq.type || "unknown", value: a ?? null };
    });
  };

  // ✅ Device submission index doc (no query/index needed)
  const deviceSubmissionsRef = useCallback(() => {
    if (!assessment?.id || !deviceId) return null;
    return doc(db, "assessments", assessment.id, "deviceSubmissions", deviceId);
  }, [assessment?.id, deviceId]);

  const responseDocRef = useCallback(
    (supKey) => {
      if (!assessment?.id || !deviceId || !supKey) return null;
      // deterministic doc id so it never “disappears”
      const safeKey = supKey.replace(/[^a-z0-9]+/g, "_").slice(0, 60);
      const responseId = `${deviceId}__${safeKey}`;
      return doc(db, "assessments", assessment.id, "responses", responseId);
    },
    [assessment?.id, deviceId]
  );

  // ✅ Called when user presses “Start Assessment” in supervisor modal
  const confirmSupervisorAndStart = async () => {
    try {
      const trimmed = String(supervisorName || "").trim().replace(/\s+/g, " ");
      const key = normalizeSupervisorName(trimmed);

      if (key.length < 2) {
        Alert.alert("Supervisor required", "Please enter the supervisor name.");
        return;
      }

      // Must have deviceId to enforce the “already submitted for this supervisor” rule
      if (!deviceId) {
        Alert.alert("Please wait", "Device ID is still loading. Try again in a second.");
        return;
      }

      // 1) Check submission index doc for duplicates
      const idxRef = deviceSubmissionsRef();
      let already = false;

      if (idxRef) {
        const idxSnap = await getDoc(idxRef);
        const submittedKeys = idxSnap.exists() ? idxSnap.data()?.submittedSupervisorKeys : null;
        const arr = Array.isArray(submittedKeys) ? submittedKeys : [];
        already = arr.includes(key);
      }

      // 2) Extra safety check: also check response doc directly (no query)
      const rRef = responseDocRef(key);
      if (!already && rRef) {
        const rSnap = await getDoc(rRef);
        if (rSnap.exists()) already = true;
      }

      if (already) {
        Alert.alert(
          "Already submitted",
          `This assessment was already submitted for supervisor "${trimmed}".\n\nEnter a different supervisor name to submit again.`
        );
        // keep modal open so they can change the name
        return;
      }

      // ✅ Accept supervisor
      setSupervisorName(trimmed);
      setSupervisorKey(key);

      // ✅ Now that we know the supervisor, load any existing attempt for THIS supervisor (resume)
      const raw = await AsyncStorage.getItem(ATTEMPT_KEY_V5(assessment.id, uid, key));
      const timeLimit = assessment?.timeLimitSec || 1200;

      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.answers)) setAnswers(parsed.answers);
        if (typeof parsed?.index === "number")
          setIndex(clamp(parsed.index, 0, Math.max(0, (assessment?.questions?.length || 1) - 1)));
        if (typeof parsed?.secondsLeft === "number")
          setSecondsLeft(clamp(parsed.secondsLeft, 0, timeLimit));
        if (typeof parsed?.submittedAt === "number") setSubmittedAt(parsed.submittedAt);
      } else {
        // fresh run for this supervisor
        setAnswers(Array(assessment?.questions?.length || 0).fill(null));
        setIndex(0);
        setSubmittedAt(null);
        setSecondsLeft(timeLimit);
      }

      // Persist supervisor selection (so resume works)
      await AsyncStorage.setItem(
        ATTEMPT_KEY_V5(assessment.id, uid, key),
        JSON.stringify({
          assessmentId: assessment.id,
          uid: uid || null,
          deviceId: deviceId || null,
          supervisorName: trimmed,
          supervisorKey: key,
          answers: raw ? JSON.parse(raw)?.answers || [] : Array(assessment?.questions?.length || 0).fill(null),
          index: 0,
          secondsLeft: raw ? JSON.parse(raw)?.secondsLeft ?? timeLimit : timeLimit,
          submittedAt: raw ? JSON.parse(raw)?.submittedAt ?? null : null,
          updatedAt: Date.now(),
        })
      );

      setSupervisorModalVisible(false);
    } catch {
      Alert.alert("Error", "Could not start assessment. Please try again.");
    }
  };

  const onSubmit = async (auto = false) => {
    if (isPreview) return;
    if (isSubmitted) return;
    if (!assessment?.questions?.length) return;

    // supervisor required before submit
    if (!hasSupervisorName) {
      setSupervisorModalVisible(true);
      if (!auto)
        Alert.alert("Supervisor required", "Enter the supervisor name before submitting.");
      return;
    }

    const now = Date.now();
    setSubmittedAt(now);

    await persistAttempt({ submittedAt: now, secondsLeft: Math.max(0, secondsLeft) });

    // ✅ Save response doc in a stable way (won’t disappear on restart)
    try {
      const idxRef = deviceSubmissionsRef();
      const rRef = responseDocRef(supervisorKey);

      if (idxRef && rRef) {
        const batch = writeBatch(db);

        // 1) Response (stable doc id)
        batch.set(
          rRef,
          {
            assessmentId: assessment.id,
            uid: uid || null,
            deviceId: deviceId || null,
            supervisorName: supervisorName.trim(),
            supervisorKey,
            createdAt: serverTimestamp(),
            secondsLeft: Math.max(0, secondsLeft),
            answers: sanitizeAnswersForFirestore(assessment.questions, answers),
          },
          { merge: true }
        );

        // 2) Index doc so we can block duplicates without queries
        batch.set(
          idxRef,
          {
            deviceId,
            updatedAt: serverTimestamp(),
            submittedSupervisorKeys: arrayUnion(supervisorKey),
            // keep the latest “pretty” name for that key
            names: { [supervisorKey]: supervisorName.trim() },
          },
          { merge: true }
        );

        await batch.commit();
      } else {
        // fallback: old addDoc if refs missing (should be rare)
        const responsePayload = {
          assessmentId: assessment.id,
          uid: uid || null,
          deviceId: deviceId || null,
          supervisorName: supervisorName.trim(),
          supervisorKey,
          createdAt: serverTimestamp(),
          secondsLeft: Math.max(0, secondsLeft),
          answers: sanitizeAnswersForFirestore(assessment.questions, answers),
        };
        await addDoc(collection(db, "assessments", assessment.id, "responses"), responsePayload);
      }
    } catch {
      // keep local submitted marker anyway
    }

    // Submission marker on assessment doc (optional)
    try {
      if (assessment?.id && deviceId) {
        const ref = doc(db, "assessments", assessment.id);
        await updateDoc(ref, {
          submissions: arrayUnion({
            deviceId,
            uid: uid || null,
            supervisorName: supervisorName.trim(),
            submittedAt: serverTimestamp(),
          }),
        });
      }
    } catch {}

    if (!auto) Alert.alert("Submitted", "Thanks — your answers have been submitted.");
  };

  const progressPct = useMemo(() => {
    const total = assessment?.timeLimitSec || 1;
    return Math.max(0, Math.min(100, (secondsLeft / total) * 100));
  }, [secondsLeft, assessment?.timeLimitSec]);

  const q = assessment?.questions?.[index];

  const waitingForLatestResolution =
    routeAssessmentId === "latest" && !resolvedAssessmentId && !loadError;

  if (waitingForLatestResolution || loading) {
    return (
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />
        <Header
          title="SKP-ZeroHarm"
          subtitle={isPreview ? "Assessment Preview" : "Safety Assessment"}
          headerTotalHeight={HEADER_BAR_HEIGHT + insets.top}
          insetsTop={insets.top}
          onBack={goBack}
        />
        <View
          style={[
            styles.card,
            {
              marginTop: HEADER_BAR_HEIGHT + insets.top + spacing(2),
              alignItems: "center",
            },
          ]}
        >
          <ActivityIndicator />
          <Text style={[styles.text, { marginTop: 8 }]}>Loading assessment…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loadError || !assessment) {
    return (
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />
        <Header
          title="SKP-ZeroHarm"
          subtitle={isPreview ? "Assessment Preview" : "Safety Assessment"}
          headerTotalHeight={HEADER_BAR_HEIGHT + insets.top}
          insetsTop={insets.top}
          onBack={goBack}
        />
        <View style={[styles.card, { marginTop: HEADER_BAR_HEIGHT + insets.top + spacing(2) }]}>
          <Text style={styles.lockTitle}>Couldn’t load</Text>
          <Text style={styles.text}>{loadError || "No assessment available."}</Text>

          <TouchableOpacity
            style={[styles.primaryBtn, { alignSelf: "flex-start", marginTop: spacing(1.25) }]}
            onPress={() => navigation.replace("Assessment", { assessmentId: routeAssessmentId, mode })}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Preview mode = read-only paper (no timer, no answering)
  if (isPreview) {
    return (
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />
        <Header
          title="SKP-ZeroHarm"
          subtitle="Assessment Preview"
          headerTotalHeight={headerTotalHeight}
          insetsTop={insets.top}
          onBack={goBack}
        />

        <FlatList
          data={[{ key: "preview" }]}
          keyExtractor={(i) => i.key}
          renderItem={() => (
            <View
              style={{
                paddingHorizontal: spacing(2),
                paddingTop: headerTotalHeight + spacing(2),
                paddingBottom: spacing(6),
              }}
            >
              <View style={styles.card}>
                <Text style={styles.assessmentTitle}>{assessment.title}</Text>
                {!!assessment.instructions && <Text style={styles.subtle}>{assessment.instructions}</Text>}
              </View>

              {!!assessment.context?.text && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Context</Text>
                  <Text style={styles.text}>{assessment.context.text}</Text>
                </View>
              )}

              {assessment.context?.imageUrl || assessment.context?.videoUrl ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Context Media</Text>

                  {!!assessment.context?.imageUrl && (
                    <TouchableOpacity
                      onPress={() => openViewer(assessment.context.imageUrl)}
                      activeOpacity={0.9}
                      style={[styles.mediaWrap, { marginTop: spacing(1) }]}
                    >
                      <Image
                        source={{ uri: assessment.context.imageUrl }}
                        style={styles.mediaImage}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                  )}

                  {!!assessment.context?.videoUrl && (
                    <View style={[styles.videoWrap, { marginTop: spacing(1) }]}>
                      <Video
                        source={{ uri: assessment.context.videoUrl }}
                        style={styles.video}
                        resizeMode={ResizeMode.CONTAIN}
                        useNativeControls
                      />
                    </View>
                  )}
                </View>
              ) : null}

              {Array.isArray(assessment.media) && assessment.media.length > 0 && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Attachments</Text>
                  {assessment.media.map((m) => {
                    const isImg = m.type === "image";
                    const uri = m.url;
                    if (!uri) return null;

                    return (
                      <View key={m.id} style={{ marginTop: spacing(1) }}>
                        {isImg ? (
                          <TouchableOpacity onPress={() => openViewer(uri)} activeOpacity={0.9} style={styles.mediaWrap}>
                            <Image source={{ uri }} style={styles.mediaImage} resizeMode="cover" />
                          </TouchableOpacity>
                        ) : (
                          <View style={styles.videoWrap}>
                            <Video
                              source={{ uri }}
                              style={styles.video}
                              resizeMode={ResizeMode.CONTAIN}
                              useNativeControls
                            />
                          </View>
                        )}
                        {!!m.caption && <Text style={styles.subtle}>{m.caption}</Text>}
                      </View>
                    );
                  })}
                </View>
              )}

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Questions ({assessment.questions.length})</Text>

                {assessment.questions.map((qq, i) => (
                  <View key={qq.id || `q-${i}`} style={styles.previewQ}>
                    <Text style={styles.previewQNo}>Q{i + 1}</Text>
                    <Text style={styles.previewQText}>{qq.text}</Text>
                    <Text style={styles.previewQType}>{String(qq.type || "unknown")}</Text>
                    {qq.type === "mc" && Array.isArray(qq.options) && qq.options.length > 0 ? (
                      <Text style={styles.previewQOptions}>Options: {qq.options.join(" • ")}</Text>
                    ) : null}
                  </View>
                ))}

                <Text style={[styles.subtle, { marginTop: spacing(1) }]}>
                  Note: Workers will have 20 minutes to complete once they open it.
                </Text>
              </View>
            </View>
          )}
        />

        <Modal visible={viewerVisible} transparent animationType="fade" onRequestClose={() => setViewerVisible(false)}>
          <Pressable style={styles.fullscreen} onPress={() => setViewerVisible(false)}>
            {!!viewerUri && (
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
            )}
          </Pressable>
        </Modal>
      </SafeAreaView>
    );
  }

  // Submitted view (workers)
  if (isSubmitted) {
    return (
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />
        <Header
          title="SKP-ZeroHarm"
          subtitle="Safety Assessment"
          headerTotalHeight={headerTotalHeight}
          insetsTop={insets.top}
          onBack={goBack}
        />

        <View style={{ paddingTop: headerTotalHeight + spacing(2), paddingHorizontal: spacing(2) }}>
          <View style={styles.card}>
            <Text style={styles.lockTitle}>Submitted</Text>
            <Text style={styles.text}>Thanks — your answers were submitted.</Text>
            <Text style={[styles.text, { marginTop: 6 }]}>
              Assessment: <Text style={styles.textStrong}>{assessment.title}</Text>
            </Text>
            {!!supervisorName?.trim() && (
              <Text style={[styles.text, { marginTop: 6 }]}>
                Supervisor: <Text style={styles.textStrong}>{supervisorName.trim()}</Text>
              </Text>
            )}

            {/* ✅ Let them do another run with a DIFFERENT supervisor */}
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.primaryBtn, { marginTop: spacing(1.25) }]}
              onPress={() => {
                setSupervisorName("");
                setSupervisorKey("");
                setSupervisorModalVisible(true);
                setSubmittedAt(null);
              }}
            >
              <Text style={styles.primaryBtnText}>Submit Another Supervisor</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Worker answering view
  return (
    <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
      <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />
      <Header
        title="SKP-ZeroHarm"
        subtitle="Safety Assessment"
        headerTotalHeight={headerTotalHeight}
        insetsTop={insets.top}
        onBack={goBack}
      />

      <FlatList
        data={[{ key: "content" }]}
        keyExtractor={(i) => i.key}
        renderItem={() => (
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={headerTotalHeight}
          >
            <View
              style={{
                paddingHorizontal: spacing(2),
                paddingTop: headerTotalHeight + spacing(2),
                paddingBottom: spacing(6),
              }}
            >
              {/* Title / timer */}
              <View style={styles.topMeta}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.assessmentTitle}>{assessment.title}</Text>
                  {!!assessment.instructions && <Text style={styles.subtle}>{assessment.instructions}</Text>}
                  <Text style={styles.subtle}>
                    Supervisor:{" "}
                    <Text style={{ color: colors.text, fontWeight: "900" }}>
                      {hasSupervisorName ? supervisorName.trim() : "Not set"}
                    </Text>
                  </Text>
                </View>
                <View style={styles.timerPill}>
                  <Text style={styles.timerText}>⏱ {formatTime(secondsLeft)}</Text>
                </View>
              </View>

              {/* Progress bar */}
              <View style={styles.timeBar}>
                <View style={[styles.timeFill, { width: `${progressPct}%` }]} />
              </View>

              {/* Context */}
              {assessment.context?.text || assessment.context?.imageUrl || assessment.context?.videoUrl ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Context</Text>

                  {!!assessment.context?.text && <Text style={styles.text}>{assessment.context.text}</Text>}

                  {!!assessment.context?.imageUrl && (
                    <TouchableOpacity
                      onPress={() => openViewer(assessment.context.imageUrl)}
                      activeOpacity={0.9}
                      style={[styles.mediaWrap, { marginTop: spacing(1) }]}
                    >
                      <Image
                        source={{ uri: assessment.context.imageUrl }}
                        style={styles.mediaImage}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                  )}

                  {!!assessment.context?.videoUrl && (
                    <View style={[styles.videoWrap, { marginTop: spacing(1) }]}>
                      <Video
                        source={{ uri: assessment.context.videoUrl }}
                        style={styles.video}
                        resizeMode={ResizeMode.CONTAIN}
                        useNativeControls
                      />
                    </View>
                  )}
                </View>
              ) : null}

              {/* Attachments */}
              {Array.isArray(assessment.media) && assessment.media.length > 0 && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Attachments</Text>
                  {assessment.media.map((m) => {
                    const isImg = m.type === "image";
                    const uri = m.url;
                    if (!uri) return null;

                    return (
                      <View key={m.id} style={{ marginTop: spacing(1) }}>
                        {isImg ? (
                          <TouchableOpacity onPress={() => openViewer(uri)} activeOpacity={0.9} style={styles.mediaWrap}>
                            <Image source={{ uri }} style={styles.mediaImage} resizeMode="cover" />
                          </TouchableOpacity>
                        ) : (
                          <View style={styles.videoWrap}>
                            <Video
                              source={{ uri }}
                              style={styles.video}
                              resizeMode={ResizeMode.CONTAIN}
                              useNativeControls
                            />
                          </View>
                        )}
                        {!!m.caption && <Text style={styles.subtle}>{m.caption}</Text>}
                      </View>
                    );
                  })}
                </View>
              )}

              {/* Question card */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  Question {index + 1} / {assessment.questions.length}
                </Text>

                <Text style={styles.qText}>{q?.text || "Question"}</Text>

                {q?.type === "tf" ? (
                  <View style={styles.row}>
                    <Choice label="True" selected={answers[index] === true} onPress={() => pickAnswerTF(true)} />
                    <Choice label="False" selected={answers[index] === false} onPress={() => pickAnswerTF(false)} />
                  </View>
                ) : q?.type === "mc" ? (
                  <View style={{ marginTop: spacing(1) }}>
                    {(Array.isArray(q.options) ? q.options : []).map((opt, i) => (
                      <Choice
                        key={`o-${i}`}
                        label={opt}
                        selected={answers[index] === i}
                        onPress={() => pickAnswerMC(i)}
                        stacked
                      />
                    ))}
                  </View>
                ) : q?.type === "yes_no_na" ? (
                  <View style={styles.row}>
                    <Choice
                      label="Yes"
                      selected={isYesNoNaAnswer(answers[index]) && answers[index].choice === "yes"}
                      onPress={() => pickAnswerYesNoNa("yes")}
                    />
                    <Choice
                      label="No"
                      selected={isYesNoNaAnswer(answers[index]) && answers[index].choice === "no"}
                      onPress={() => pickAnswerYesNoNa("no")}
                    />
                    <Choice
                      label="N/A"
                      selected={isYesNoNaAnswer(answers[index]) && answers[index].choice === "na"}
                      onPress={() => pickAnswerYesNoNa("na")}
                    />
                  </View>
                ) : q?.type === "text_short" || q?.type === "text_long" ? (
                  <View style={{ marginTop: spacing(1) }}>
                    <TextInput
                      value={typeof answers[index] === "string" ? answers[index] : ""}
                      onChangeText={setAnswerText}
                      placeholder="Type your answer…"
                      placeholderTextColor="#98A2B3"
                      style={[
                        styles.textInput,
                        q?.type === "text_long" && { minHeight: 120, textAlignVertical: "top" },
                      ]}
                      multiline={q?.type === "text_long"}
                    />
                    <Text style={styles.subtle}>Answer clearly.</Text>
                  </View>
                ) : q?.type === "photo" ? (
                  <View style={{ marginTop: spacing(1) }}>
                    {isPhotoAnswer(answers[index]) ? (
                      <View>
                        <TouchableOpacity
                          activeOpacity={0.9}
                          onPress={() => openViewer(answers[index].photoLocalUri)}
                          style={styles.mediaWrap}
                        >
                          <Image
                            source={{ uri: answers[index].photoLocalUri }}
                            style={styles.mediaImage}
                            resizeMode="cover"
                          />
                        </TouchableOpacity>

                        <View style={{ flexDirection: "row", gap: 10, marginTop: spacing(1) }}>
                          <TouchableOpacity
                            onPress={attachPhotoAnswer}
                            activeOpacity={0.85}
                            style={[styles.secondaryBtn, { flex: 1 }]}
                          >
                            <Text style={styles.secondaryBtnText}>Retake</Text>
                          </TouchableOpacity>

                          <TouchableOpacity
                            onPress={removePhotoAnswer}
                            activeOpacity={0.85}
                            style={[styles.dangerBtn, { flex: 1 }]}
                          >
                            <Text style={styles.dangerBtnText}>Remove</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <>
                        <TouchableOpacity onPress={attachPhotoAnswer} activeOpacity={0.85} style={styles.primaryBtn}>
                          <Text style={styles.primaryBtnText}>Take Photo</Text>
                        </TouchableOpacity>
                        <Text style={[styles.subtle, { marginTop: spacing(1) }]}>
                          Take a clear photo as evidence.
                        </Text>
                      </>
                    )}
                  </View>
                ) : (
                  <Text style={styles.subtle}>Unsupported question type: {String(q?.type || "unknown")}</Text>
                )}

                <View style={styles.navRow}>
                  <TouchableOpacity
                    onPress={goPrev}
                    style={[styles.navBtnSecondary, index === 0 && { opacity: 0.5 }]}
                    activeOpacity={0.85}
                    disabled={index === 0}
                  >
                    <Text style={styles.navBtnSecondaryText}>Previous</Text>
                  </TouchableOpacity>

                  {index < assessment.questions.length - 1 ? (
                    <TouchableOpacity onPress={goNext} style={styles.navBtnPrimary} activeOpacity={0.85}>
                      <Text style={styles.navBtnPrimaryText}>Next</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={() => onSubmit(false)} style={styles.navBtnPrimary} activeOpacity={0.85}>
                      <Text style={styles.navBtnPrimaryText}>Submit</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              <Text style={[styles.subtle, { marginTop: spacing(1) }]}>
                Tip: answer all questions before you submit.
              </Text>
            </View>
          </KeyboardAvoidingView>
        )}
      />

      {/* ✅ Supervisor gate modal
          - ALWAYS opens on screen open
          - If supervisor already submitted this week -> blocks and asks for another supervisor
      */}
      <Modal
        visible={supervisorModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.gateOverlay}>
          <View style={styles.gateCard}>
            <Text style={styles.gateTitle}>Supervisor Name</Text>
            <Text style={styles.gateSub}>
              Enter the supervisor’s name for this team assessment.
            </Text>

            <TextInput
              value={supervisorName}
              onChangeText={(t) => setSupervisorName(t)}
              placeholder="e.g. Vusi Ndlovu"
              placeholderTextColor="#98A2B3"
              style={styles.gateInput}
              autoCapitalize="words"
              returnKeyType="done"
            />

            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.gateBtn, normalizeSupervisorName(supervisorName).length < 2 && { opacity: 0.5 }]}
              disabled={normalizeSupervisorName(supervisorName).length < 2}
              onPress={confirmSupervisorAndStart}
            >
              <Text style={styles.gateBtnText}>Start Assessment</Text>
            </TouchableOpacity>

            <Text style={[styles.subtle, { marginTop: spacing(1) }]}>
              If that supervisor already submitted this week, we’ll ask you to enter another name.
            </Text>
          </View>
        </View>
      </Modal>

      <Modal
        visible={viewerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerVisible(false)}
      >
        <Pressable style={styles.fullscreen} onPress={() => setViewerVisible(false)}>
          {!!viewerUri && (
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
          )}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

/* ----------------- Small components ----------------- */

function Header({ title, subtitle, headerTotalHeight, insetsTop, onBack }) {
  return (
    <View style={[styles.stickyHeader, { paddingTop: insetsTop, height: headerTotalHeight }]}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.backBtn}>
        <Text style={styles.backText}>←</Text>
      </Pressable>

      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>{title}</Text>
        <Text style={styles.headerSub}>{subtitle}</Text>
      </View>
    </View>
  );
}

function Choice({ label, selected, onPress, stacked }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      hitSlop={10}
      style={[styles.choice, stacked && { marginTop: spacing(1) }, selected && styles.choiceOn]}
    >
      <Text style={[styles.choiceTick, selected && { color: "#06130A" }]}>{selected ? "✓" : ""}</Text>
      <Text style={[styles.choiceText, selected && { color: "#06130A" }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/* ----------------- Styles ----------------- */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  stickyHeader: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: SKP_BLUE,
    paddingHorizontal: spacing(2),
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.18)",
    zIndex: 10,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing(1.25),
  },
  backText: { color: "#fff", fontSize: 18, fontWeight: "900" },
  headerTitle: { color: "#fff", fontSize: 20, fontWeight: "900", lineHeight: 24 },
  headerSub: { color: "rgba(255,255,255,0.85)", fontSize: 12, marginTop: 2, fontWeight: "800" },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    padding: spacing(2),
    marginTop: spacing(1.5),
  },
  cardTitle: { color: colors.text, fontWeight: "900", fontSize: 14, marginBottom: 8 },

  assessmentTitle: { color: colors.text, fontWeight: "900", fontSize: 16 },
  subtle: { color: colors.muted, fontWeight: "700", fontSize: 12, marginTop: 6 },

  topMeta: { flexDirection: "row", alignItems: "center", gap: spacing(1) },
  timerPill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
  },
  timerText: { color: colors.text, fontWeight: "900" },

  timeBar: {
    height: 8,
    marginTop: spacing(1),
    backgroundColor: "#E9E3EA",
    borderRadius: 999,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  timeFill: { height: "100%", backgroundColor: colors.primary },

  qText: { color: colors.text, fontWeight: "900", fontSize: 16, lineHeight: 22, marginTop: 2 },

  row: { flexDirection: "row", gap: spacing(1), marginTop: spacing(1.25) },

  choice: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#FFFFFF",
  },
  choiceOn: { backgroundColor: colors.primary, borderColor: "rgba(0,0,0,0.12)" },
  choiceTick: { width: 18, color: colors.muted, fontWeight: "900", marginRight: 8 },
  choiceText: { color: colors.text, fontWeight: "900", flex: 1 },

  textInput: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.25),
    color: colors.text,
    minHeight: 54,
  },

  navRow: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing(2) },
  navBtnSecondary: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  navBtnSecondaryText: { color: colors.text, fontWeight: "900" },

  navBtnPrimary: {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 14,
  },
  navBtnPrimaryText: { color: "#06130A", fontWeight: "900" },

  lockTitle: { color: colors.text, fontWeight: "900", fontSize: 16, marginBottom: 6 },
  text: { color: colors.muted, fontWeight: "700" },
  textStrong: { color: colors.text, fontWeight: "900" },

  primaryBtn: {
    backgroundColor: SKP_BLUE,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontWeight: "900" },

  secondaryBtn: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: "center",
  },
  secondaryBtnText: { color: colors.text, fontWeight: "900" },

  dangerBtn: {
    backgroundColor: "#FFF5F5",
    borderWidth: 1,
    borderColor: "#F3C6C6",
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: "center",
  },
  dangerBtnText: { color: colors.danger, fontWeight: "900" },

  mediaWrap: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFFFFF",
  },
  mediaImage: { width: "100%", height: 220 },

  videoWrap: {
    width: "100%",
    height: 240,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#000",
  },
  video: { width: "100%", height: "100%" },

  fullscreen: {
    flex: 1,
    backgroundColor: "black",
    justifyContent: "center",
    alignItems: "center",
  },
  fullImage: { width: "100%", height: "100%" },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  fullHint: {
    position: "absolute",
    bottom: 24,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  fullHintText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  previewQ: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.5),
    marginTop: spacing(1),
    backgroundColor: "#fff",
  },
  previewQNo: { color: colors.muted, fontWeight: "900", fontSize: 12, marginBottom: 6 },
  previewQText: { color: colors.text, fontWeight: "900", fontSize: 14, lineHeight: 20 },
  previewQType: { color: colors.muted, fontWeight: "800", fontSize: 12, marginTop: 6 },
  previewQOptions: { color: colors.muted, fontWeight: "700", fontSize: 12, marginTop: 6 },

  // ✅ gate modal styles
  gateOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing(2),
  },
  gateCard: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: spacing(2),
    borderWidth: 1,
    borderColor: colors.border,
  },
  gateTitle: { color: colors.text, fontWeight: "900", fontSize: 16 },
  gateSub: { color: colors.muted, fontWeight: "700", marginTop: 6, marginBottom: 12 },
  gateInput: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.25),
    color: colors.text,
    minHeight: 54,
  },
  gateBtn: {
    marginTop: spacing(1.5),
    backgroundColor: SKP_BLUE,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  gateBtnText: { color: "#fff", fontWeight: "900" },
});

