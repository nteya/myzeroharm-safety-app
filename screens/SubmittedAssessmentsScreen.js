// screens/SubmittedAssessmentsScreen.js
import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  StatusBar,
  ActivityIndicator,
  FlatList,
  Modal,
  TouchableOpacity,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { auth, db } from "../firebase";
import {
  doc,
  getDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  where,
  getDocs,
  writeBatch,
  serverTimestamp,
  Timestamp,
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
  warn: "#F59E0B",
};

const spacing = (n = 1) => 8 * n;
const radius = 16;

function fmtDate(ts) {
  try {
    const d = ts?.toDate?.();
    if (!d) return "";
    return d.toLocaleString();
  } catch {
    return "";
  }
}

function fmtShortDate(ts) {
  try {
    const d = ts?.toDate?.();
    if (!d) return "";
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

function isExpired(expiresAt) {
  try {
    const exp = expiresAt?.toDate?.();
    if (!exp) return false;
    return exp.getTime() <= Date.now();
  } catch {
    return false;
  }
}

// response.answers is sanitized: [{type, value}]
function formatAnswerForAdmin(q, a) {
  if (!q) return "—";
  if (!a) return "—";

  const type = q.type || a.type;
  const v = a?.value;

  if (type === "yes_no_na") return v ? String(v).toUpperCase() : "—";
  if (type === "tf") return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : "—";
  if (type === "mc") {
    const idx = typeof v === "number" ? v : null;
    if (idx === null) return "—";
    const opt = Array.isArray(q.options) ? q.options[idx] : null;
    return opt ? `Option ${idx + 1}: ${opt}` : `Option ${idx + 1}`;
  }
  if (type === "text_short" || type === "text_long") return (v || "").trim() || "—";
  if (type === "photo") return v?.photo ? "PHOTO SUBMITTED ✅" : "—";
  return v === null || v === undefined ? "—" : String(v);
}

export default function SubmittedAssessmentsScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();

  const routeAssessmentId = route?.params?.assessmentId || "latest";

  const [resolvedAssessmentId, setResolvedAssessmentId] = useState(
    routeAssessmentId === "latest" ? "" : routeAssessmentId
  );

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [assessment, setAssessment] = useState(null);
  const [responses, setResponses] = useState([]);

  const [selected, setSelected] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);

  const uid = auth.currentUser?.uid || null;
  const headerTotalHeight = HEADER_BAR_HEIGHT + insets.top;

  const goBack = () => {
    if (navigation?.canGoBack?.()) navigation.goBack();
    else navigation.navigate("Home");
  };

  /**
   * ✅ Resolve "latest" assessment id using pointer doc:
   * /assessments/latest { latestId }
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (routeAssessmentId !== "latest") return;

      try {
        setLoading(true);
        setLoadError("");

        const pointerRef = doc(db, "assessments", "latest");
        const pointerSnap = await getDoc(pointerRef);
        const latestId = pointerSnap.exists() ? pointerSnap.data()?.latestId : null;

        if (latestId && typeof latestId === "string") {
          if (!cancelled) setResolvedAssessmentId(latestId);
          return;
        }

        if (!cancelled) {
          setResolvedAssessmentId("");
          setLoadError("No latest assessment pointer found.");
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setResolvedAssessmentId("");
          setLoadError("Could not resolve latest assessment.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeAssessmentId]);

  /**
   * ✅ Listen to assessment doc (get questions + title)
   */
  useEffect(() => {
    if (!resolvedAssessmentId) return;

    setLoading(true);
    setLoadError("");

    const ref = doc(db, "assessments", resolvedAssessmentId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setAssessment(null);
          setLoadError("Assessment not found.");
          setLoading(false);
          return;
        }
        const d = snap.data() || {};
        setAssessment({
          id: snap.id,
          title: d.title || "Safety Assessment",
          createdAt: d.createdAt || null,
          questions: Array.isArray(d.questions) ? d.questions : [],
        });
        setLoading(false);
      },
      () => {
        setLoadError("Could not load assessment.");
        setLoading(false);
      }
    );

    return () => unsub && unsub();
  }, [resolvedAssessmentId]);

  /**
   * ✅ Listen to responses for this assessment
   * /assessments/{assessmentId}/responses
   *
   * NOTE: We ONLY orderBy createdAt and filter expiry on-device
   * so we avoid Firestore index issues.
   */
  useEffect(() => {
    if (!resolvedAssessmentId) return;

    const qy = query(
      collection(db, "assessments", resolvedAssessmentId, "responses"),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
        setResponses(list);
      },
      () => {}
    );

    return () => unsub && unsub();
  }, [resolvedAssessmentId]);

  /**
   * ✅ derived:
   * - admin score if marked
   * - filter out expired submissions (7-day rule)
   */
  const normalized = useMemo(() => {
    const totalQ = assessment?.questions?.length || 0;

    const withAdmin = (responses || []).map((r) => {
      const admin = r.admin || null;
      const yesCount = typeof admin?.yesCount === "number" ? admin.yesCount : null;
      const total = typeof admin?.total === "number" ? admin.total : totalQ;

      const pct =
        typeof yesCount === "number" && total > 0
          ? Math.round((yesCount / total) * 100)
          : null;

      return {
        ...r,
        _adminYes: yesCount,
        _adminTotal: total,
        _adminPct: pct,
        _bestTeam: !!admin?.bestTeam,
        _marked: !!admin?.markedAt,
        _expired: isExpired(r.expiresAt),
      };
    });

    // ✅ ONLY show active ones by default
    // If you want to show expired too, remove this filter.
    return withAdmin.filter((r) => !r._expired);
  }, [responses, assessment?.questions?.length]);

  const openMarkModal = (resp) => {
    if (!assessment) return;
    setSelected(resp);
    setModalVisible(true);
  };

  const computeYesCount = (marks, total) => {
    const map = new Map();
    (marks || []).forEach((m) => {
      if (typeof m?.qIndex !== "number") return;
      if (m?.mark !== "yes" && m?.mark !== "no") return;
      map.set(m.qIndex, m.mark);
    });

    let yes = 0;
    for (let i = 0; i < total; i++) if (map.get(i) === "yes") yes++;
    return yes;
  };

  const toggleMark = (qIndex, mark) => {
    if (!selected) return;
    const total = assessment?.questions?.length || 0;

    const current = Array.isArray(selected?.admin?.marks) ? selected.admin.marks : [];
    const nextMap = new Map();
    current.forEach((m) => {
      if (typeof m?.qIndex === "number" && (m.mark === "yes" || m.mark === "no")) {
        nextMap.set(m.qIndex, m.mark);
      }
    });

    const existing = nextMap.get(qIndex);
    if (existing === mark) nextMap.delete(qIndex);
    else nextMap.set(qIndex, mark);

    const nextMarks = Array.from(nextMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([idx, mk]) => ({ qIndex: idx, mark: mk }));

    const yesCount = computeYesCount(nextMarks, total);

    setSelected((prev) => ({
      ...prev,
      admin: {
        ...(prev?.admin || {}),
        marks: nextMarks,
        yesCount,
        total,
      },
    }));
  };

  /**
   * ✅ Save admin marking to Firestore (response doc)
   * (Does NOT touch expiresAt)
   */
  const saveMarking = useCallback(async () => {
    try {
      if (!resolvedAssessmentId || !selected?.id) return;

      const total = assessment?.questions?.length || 0;
      const marks = Array.isArray(selected?.admin?.marks) ? selected.admin.marks : [];
      const yesCount =
        typeof selected?.admin?.yesCount === "number"
          ? selected.admin.yesCount
          : computeYesCount(marks, total);

      const ref = doc(db, "assessments", resolvedAssessmentId, "responses", selected.id);

      const payload = {
        admin: {
          marks,
          yesCount,
          total,
          bestTeam: !!selected?.admin?.bestTeam,
          markedAt: serverTimestamp(),
          markedByUid: uid || null,
        },
      };

      const batch = writeBatch(db);
      batch.update(ref, payload);
      await batch.commit();

      Alert.alert("Saved", "Marking saved successfully.");
    } catch (e) {
      Alert.alert("Error", "Could not save marking.");
    }
  }, [resolvedAssessmentId, selected?.id, selected?.admin, assessment?.questions?.length, uid]);

  /**
   * ✅ Select BEST TEAM (ONLY ONE best team)
   */
  const selectBestTeam = useCallback(async () => {
    try {
      if (!resolvedAssessmentId || !selected?.id) return;

      const respRef = doc(db, "assessments", resolvedAssessmentId, "responses", selected.id);

      const bestQ = query(
        collection(db, "assessments", resolvedAssessmentId, "responses"),
        where("admin.bestTeam", "==", true)
      );

      const snap = await getDocs(bestQ);

      const batch = writeBatch(db);

      snap.docs.forEach((d) => {
        if (d.id === selected.id) return;
        batch.update(d.ref, {
          admin: {
            ...(d.data()?.admin || {}),
            bestTeam: false,
            markedAt: serverTimestamp(),
            markedByUid: uid || null,
          },
        });
      });

      const total = assessment?.questions?.length || 0;
      const marks = Array.isArray(selected?.admin?.marks) ? selected.admin.marks : [];
      const yesCount = computeYesCount(marks, total);

      batch.update(respRef, {
        admin: {
          ...(selected?.admin || {}),
          marks,
          yesCount,
          total,
          bestTeam: true,
          markedAt: serverTimestamp(),
          markedByUid: uid || null,
        },
      });

      await batch.commit();

      setSelected((p) => ({
        ...p,
        admin: { ...(p?.admin || {}), bestTeam: true },
      }));

      Alert.alert("Best Team Selected", "This team/supervisor is now selected as best.");
    } catch (e) {
      Alert.alert("Error", "Could not select best team.");
    }
  }, [resolvedAssessmentId, selected?.id, selected?.admin, assessment?.questions?.length, uid]);

  const closeModal = () => {
    setModalVisible(false);
    setSelected(null);
  };

  const showHeaderSubtitle = useMemo(() => {
    const count = normalized.length;
    const best = normalized.find((r) => r._bestTeam);
    const bestText = best?.supervisorName ? `Best: ${best.supervisorName}` : "No best team yet";
    return `${count} submissions • ${bestText}`;
  }, [normalized]);

  const waitingForLatestResolution = routeAssessmentId === "latest" && !resolvedAssessmentId && !loadError;

  if (waitingForLatestResolution || loading) {
    return (
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />
        <Header
          title="Submitted Assessments"
          subtitle="Loading…"
          headerTotalHeight={headerTotalHeight}
          insetsTop={insets.top}
          onBack={closeModal}
        />
        <View style={[styles.card, { marginTop: headerTotalHeight + spacing(2), alignItems: "center" }]}>
          <ActivityIndicator />
          <Text style={[styles.text, { marginTop: 8 }]}>Loading submissions…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (loadError || !assessment) {
    return (
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />
        <Header
          title="Submitted Assessments"
          subtitle="Couldn’t load"
          headerTotalHeight={headerTotalHeight}
          insetsTop={insets.top}
          onBack={goBack}
        />
        <View style={[styles.card, { marginTop: headerTotalHeight + spacing(2) }]}>
          <Text style={styles.lockTitle}>Couldn’t load</Text>
          <Text style={styles.text}>{loadError || "No assessment available."}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
      <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />

      <Header
        title={assessment?.title || "Submitted Assessments"}
        subtitle={showHeaderSubtitle}
        headerTotalHeight={headerTotalHeight}
        insetsTop={insets.top}
        onBack={goBack}
      />

      <FlatList
        data={normalized}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingHorizontal: spacing(2),
          paddingTop: headerTotalHeight + spacing(2),
          paddingBottom: spacing(6),
        }}
        ListEmptyComponent={() => (
          <View style={styles.card}>
            <Text style={styles.lockTitle}>No submissions yet</Text>
            <Text style={styles.text}>
              Teams haven’t submitted this assessment yet (or submissions expired after 7 days).
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => openMarkModal(item)}
            style={[styles.card, item._bestTeam && styles.bestCard]}
          >
            <View style={styles.rowTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.supervisorTitle}>
                  {item.supervisorName?.trim() || "Supervisor: (not provided)"}
                </Text>
                <Text style={styles.subtle}>Submitted: {fmtDate(item.createdAt) || "—"}</Text>
                {!!item.expiresAt && (
                  <Text style={styles.subtle}>Expires: {fmtShortDate(item.expiresAt) || "—"}</Text>
                )}
              </View>

              {item._bestTeam ? (
                <View style={styles.badgeBest}>
                  <Text style={styles.badgeBestText}>BEST</Text>
                </View>
              ) : item._marked ? (
                <View style={styles.badgeReviewed}>
                  <Text style={styles.badgeReviewedText}>REVIEWED</Text>
                </View>
              ) : (
                <View style={styles.badgePending}>
                  <Text style={styles.badgePendingText}>PENDING</Text>
                </View>
              )}
            </View>

            <View style={{ marginTop: spacing(1) }}>
              <Text style={styles.metaLine}>
                Answers:{" "}
                <Text style={styles.textStrong}>{Array.isArray(item.answers) ? item.answers.length : 0}</Text>
              </Text>

              <Text style={styles.metaLine}>
                Score:{" "}
                <Text style={styles.textStrong}>
                  {typeof item._adminYes === "number"
                    ? `${item._adminYes}/${item._adminTotal} (${item._adminPct}%)`
                    : "Not marked"}
                </Text>
              </Text>
            </View>

            <Text style={[styles.subtle, { marginTop: spacing(1) }]}>
              Tap to mark answers and select best team.
            </Text>
          </TouchableOpacity>
        )}
      />

      {/* ✅ Marking modal */}
      <Modal visible={modalVisible} animationType="slide" onRequestClose={closeModal}>
        <SafeAreaView style={styles.modalRoot} edges={["left", "right", "bottom"]}>
          <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />

          <View style={[styles.modalHeader, { paddingTop: insets.top }]}>
            <Pressable onPress={closeModal} style={styles.backBtn} hitSlop={12}>
              <Text style={styles.backText}>←</Text>
            </Pressable>

            <View style={{ flex: 1 }}>
              <Text style={styles.modalTitle}>Mark Team</Text>
              <Text style={styles.modalSub}>
                {selected?.supervisorName?.trim() || "Supervisor (not provided)"}
              </Text>
            </View>

            {selected?.admin?.bestTeam ? (
              <View style={styles.badgeBest}>
                <Text style={styles.badgeBestText}>BEST</Text>
              </View>
            ) : null}
          </View>

          <ScrollView
            contentContainerStyle={{
              padding: spacing(2),
              paddingBottom: spacing(6),
            }}
          >
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Submission Info</Text>
              <Text style={styles.metaLine}>
                Submitted: <Text style={styles.textStrong}>{fmtDate(selected?.createdAt) || "—"}</Text>
              </Text>
              <Text style={styles.metaLine}>
                Expires: <Text style={styles.textStrong}>{fmtDate(selected?.expiresAt) || "—"}</Text>
              </Text>
              <Text style={styles.metaLine}>
                Device ID: <Text style={styles.textStrong}>{selected?.deviceId || "—"}</Text>
              </Text>
              <Text style={styles.metaLine}>
                User UID: <Text style={styles.textStrong}>{selected?.uid || "—"}</Text>
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Marking</Text>

              <Text style={styles.subtle}>
                Tick YES or NO for each question (admin marking). Leave blank if not assessed.
              </Text>

              {(assessment?.questions || []).map((q, i) => {
                const ans = Array.isArray(selected?.answers) ? selected.answers[i] : null;

                const marks = Array.isArray(selected?.admin?.marks) ? selected.admin.marks : [];
                const found = marks.find((m) => m?.qIndex === i);
                const current = found?.mark || null;

                return (
                  <View key={q.id || `q-${i}`} style={styles.qCard}>
                    <Text style={styles.qNo}>Q{i + 1}</Text>
                    <Text style={styles.qText}>{q.text || "Question"}</Text>

                    <View style={{ marginTop: spacing(1) }}>
                      <Text style={styles.answerLabel}>Team Answer</Text>
                      <Text style={styles.answerText}>{formatAnswerForAdmin(q, ans)}</Text>
                    </View>

                    <View style={styles.markRow}>
                      <MarkChip label="YES" active={current === "yes"} onPress={() => toggleMark(i, "yes")} />
                      <MarkChip label="NO" active={current === "no"} onPress={() => toggleMark(i, "no")} />
                      <View style={{ flex: 1 }} />
                      <Text style={styles.smallMuted}>
                        {current ? `Marked: ${current.toUpperCase()}` : "Not marked"}
                      </Text>
                    </View>
                  </View>
                );
              })}

              <View style={{ marginTop: spacing(1) }}>
                <Text style={styles.metaLine}>
                  Score now:{" "}
                  <Text style={styles.textStrong}>
                    {(() => {
                      const total = assessment?.questions?.length || 0;
                      const marks = Array.isArray(selected?.admin?.marks) ? selected.admin.marks : [];
                      const yes = computeYesCount(marks, total);
                      const pct = total > 0 ? Math.round((yes / total) * 100) : 0;
                      return `${yes}/${total} (${pct}%)`;
                    })()}
                  </Text>
                </Text>
              </View>
            </View>

            <View style={styles.actionRow}>
              <TouchableOpacity activeOpacity={0.85} style={styles.secondaryBtn} onPress={saveMarking}>
                <Text style={styles.secondaryBtnText}>Save Marking</Text>
              </TouchableOpacity>

              <TouchableOpacity activeOpacity={0.85} style={styles.primaryBtn} onPress={selectBestTeam}>
                <Text style={styles.primaryBtnText}>Select Best Team</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.subtle, { marginTop: spacing(1) }]}>
              Note: Select Best Team enforces ONE best team (it unsets previous best team automatically).
            </Text>
          </ScrollView>
        </SafeAreaView>
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

function MarkChip({ label, active, onPress }) {
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[styles.chip, active && styles.chipOn]}>
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

/* ----------------- Styles ----------------- */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  modalRoot: { flex: 1, backgroundColor: colors.bg },

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

  modalHeader: {
    backgroundColor: SKP_BLUE,
    paddingHorizontal: spacing(2),
    paddingBottom: spacing(1.5),
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.18)",
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

  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "900", lineHeight: 22 },
  headerSub: { color: "rgba(255,255,255,0.85)", fontSize: 12, marginTop: 2, fontWeight: "800" },

  modalTitle: { color: "#fff", fontSize: 18, fontWeight: "900" },
  modalSub: { color: "rgba(255,255,255,0.9)", fontSize: 12, marginTop: 2, fontWeight: "800" },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    padding: spacing(2),
    marginTop: spacing(1.5),
  },
  bestCard: {
    borderColor: "rgba(0,200,83,0.45)",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 1,
  },

  cardTitle: { color: colors.text, fontWeight: "900", fontSize: 14, marginBottom: 8 },

  lockTitle: { color: colors.text, fontWeight: "900", fontSize: 16, marginBottom: 6 },
  text: { color: colors.muted, fontWeight: "700" },
  textStrong: { color: colors.text, fontWeight: "900" },
  subtle: { color: colors.muted, fontWeight: "700", fontSize: 12, marginTop: 6 },

  rowTop: { flexDirection: "row", alignItems: "center", gap: spacing(1) },

  supervisorTitle: { color: colors.text, fontWeight: "900", fontSize: 16 },
  metaLine: { color: colors.muted, fontWeight: "700", marginTop: 4 },

  badgeBest: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
  },
  badgeBestText: { color: "#06130A", fontWeight: "900", fontSize: 12 },

  badgeReviewed: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#E2E8F0",
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeReviewedText: { color: colors.text, fontWeight: "900", fontSize: 12 },

  badgePending: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#FFF7ED",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.35)",
  },
  badgePendingText: { color: "#7C2D12", fontWeight: "900", fontSize: 12 },

  qCard: {
    marginTop: spacing(1.25),
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.5),
    backgroundColor: "#fff",
  },
  qNo: { color: colors.muted, fontWeight: "900", fontSize: 12, marginBottom: 6 },
  qText: { color: colors.text, fontWeight: "900", fontSize: 14, lineHeight: 20 },

  answerLabel: { marginTop: 2, color: colors.muted, fontWeight: "900", fontSize: 12 },
  answerText: { marginTop: 4, color: colors.text, fontWeight: "800", lineHeight: 18 },

  markRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: spacing(1.25),
  },
  smallMuted: { color: colors.muted, fontWeight: "800", fontSize: 12 },

  chip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#fff",
    minWidth: 70,
    alignItems: "center",
  },
  chipOn: {
    backgroundColor: colors.primary,
    borderColor: "rgba(0,0,0,0.12)",
  },
  chipText: { color: colors.text, fontWeight: "900" },
  chipTextOn: { color: "#06130A" },

  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: spacing(1.5),
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: SKP_BLUE,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontWeight: "900" },

  secondaryBtn: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: "center",
  },
  secondaryBtnText: { color: colors.text, fontWeight: "900" },
});