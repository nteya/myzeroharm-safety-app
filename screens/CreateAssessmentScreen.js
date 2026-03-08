// screens/CreateAssessmentScreen.js
import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  Alert,
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StatusBar,
  Platform,
  TouchableOpacity, // ✅ use RN touchables inside Modals (more reliable)
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";

import { db, storage, auth } from "../firebase";
import { addDoc, collection, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { ref as sRef, uploadBytes, getDownloadURL } from "firebase/storage";

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

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function friendlyError(err, fallback = "Something went wrong. Please try again.") {
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("permission")) return "Permission denied. Please check access and try again.";
  if (msg.includes("network") || msg.includes("timeout")) return "Network issue. Please try again.";
  return fallback;
}

async function uploadMediaIfAny(localUri, folder) {
  if (!localUri) return "";
  const resp = await fetch(localUri);
  const blob = await resp.blob();

  const type = blob?.type || "";
  const ext = type.includes("video") ? "mp4" : type.includes("image") ? "jpg" : "bin";

  const path = `${folder}/${uid()}.${ext}`;
  const r = sRef(storage, path);

  await uploadBytes(r, blob, { contentType: type || "application/octet-stream" });
  return await getDownloadURL(r);
}

const QUESTION_TYPES = [
  { key: "text_short", label: "Written (Short)" },
  { key: "text_long", label: "Written (Long)" },
  { key: "yes_no_na", label: "Yes / No / N/A" },
  { key: "tf", label: "True / False" },
  { key: "mc", label: "Multiple Choice" },
];

function typeLabel(t) {
  return QUESTION_TYPES.find((x) => x.key === t)?.label || t;
}

export default function CreateAssessmentScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const headerTotalHeight = HEADER_BAR_HEIGHT + insets.top;

  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState(
    "Complete this assessment as a team. Discuss each question and agree on the best answer."
  );
  const [contextText, setContextText] = useState("");

  const [media, setMedia] = useState([]); // { id, type, localUri, url:'', caption:'' }
  const [questions, setQuestions] = useState([]);
  const [busy, setBusy] = useState(false);

  // Question modal state
  const [qModal, setQModal] = useState(false);
  const [editingIndex, setEditingIndex] = useState(-1);
  const [qText, setQText] = useState("");
  const [qType, setQType] = useState("yes_no_na");
  const [qOptions, setQOptions] = useState(["", "", "", ""]);

  // Media viewer
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerUri, setViewerUri] = useState("");
  const [viewerType, setViewerType] = useState("image");

  // Publish success modal
  const [successVisible, setSuccessVisible] = useState(false);
  const [publishedId, setPublishedId] = useState("");

  const canPublish = useMemo(() => title.trim().length > 0 && questions.length > 0 && !busy, [
    title,
    questions.length,
    busy,
  ]);

  const goBack = () => {
    if (navigation?.canGoBack?.()) navigation.goBack();
    else navigation.navigate("Home");
  };

  // --- Media permissions ---
  const requestLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Media library access is required to attach files.");
      return false;
    }
    return true;
  };

  const requestCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access is required to take a photo/video.");
      return false;
    }
    return true;
  };

  const addFromLibrary = async (kind) => {
    try {
      const ok = await requestLibrary();
      if (!ok) return;

      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes:
          kind === "video"
            ? ImagePicker.MediaTypeOptions.Videos
            : ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
        allowsEditing: false,
      });

      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return;

      setMedia((prev) => [
        ...prev,
        { id: uid(), type: kind, localUri: asset.uri, url: "", caption: "" },
      ]);
    } catch (e) {
      Alert.alert("Attach error", friendlyError(e));
    }
  };

  const addFromCamera = async (kind) => {
    try {
      const ok = await requestCamera();
      if (!ok) return;

      const res =
        kind === "video"
          ? await ImagePicker.launchCameraAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Videos,
              quality: 1,
            })
          : await ImagePicker.launchCameraAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.9,
            });

      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return;

      setMedia((prev) => [
        ...prev,
        { id: uid(), type: kind, localUri: asset.uri, url: "", caption: "" },
      ]);
    } catch (e) {
      Alert.alert("Camera error", friendlyError(e));
    }
  };

  const removeMedia = (id) => setMedia((prev) => prev.filter((m) => m.id !== id));

  const openViewer = (m) => {
    const uri = m?.localUri || m?.url;
    if (!uri) return;
    setViewerUri(uri);
    setViewerType(m.type || "image");
    setViewerVisible(true);
  };

  // --- Questions ---
  const openAddQuestion = () => {
    setEditingIndex(-1);
    setQText("");
    setQType("yes_no_na");
    setQOptions(["", "", "", ""]);
    setQModal(true);
  };

  const openEditQuestion = (idx) => {
    const q = questions[idx];
    if (!q) return;

    setEditingIndex(idx);
    setQText(q.text || "");
    setQType(q.type || "yes_no_na");

    const safe = Array.isArray(q.options) ? q.options : ["", "", "", ""];
    setQOptions([...safe, "", "", "", ""].slice(0, 4));

    setQModal(true);
  };

  const deleteQuestion = (idx) => {
    Alert.alert("Delete question?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => setQuestions((prev) => prev.filter((_, i) => i !== idx)),
      },
    ]);
  };

  const saveQuestion = () => {
    const text = qText.trim();
    if (!text) return Alert.alert("Question required", "Please type a question.");

    const base = { id: uid(), type: qType, text };
    let q = base;

    if (qType === "mc") {
      const opts = qOptions.map((x) => String(x || "").trim()).filter(Boolean);
      if (opts.length < 2)
        return Alert.alert("Options needed", "Multiple choice needs at least 2 options.");
      q = { ...base, options: opts.slice(0, 6) };
    }

    setQuestions((prev) => {
      const next = [...prev];
      if (editingIndex >= 0) next[editingIndex] = { ...q, id: prev[editingIndex]?.id || q.id };
      else next.push(q);
      return next;
    });

    setQModal(false);
  };

  // --- Publish ---
  const publish = async () => {
    if (!title.trim()) return Alert.alert("Title required", "Please add a title.");
    if (questions.length < 1) return Alert.alert("Add questions", "Please add at least 1 question.");

    setBusy(true);
    try {
      // upload media
      const uploaded = [];
      for (const m of media) {
        const folder = m.type === "video" ? "assessments/videos" : "assessments/images";
        const url = await uploadMediaIfAny(m.localUri, folder);
        uploaded.push({
          id: m.id,
          type: m.type,
          url: url || "",
          caption: (m.caption || "").trim(),
        });
      }

      // normalize questions
      const normalizedQuestions = questions.map((q) => {
        const base = { id: q.id || uid(), type: q.type, text: String(q.text || "").trim() };
        if (q.type === "mc") {
          return { ...base, options: Array.isArray(q.options) ? q.options.filter(Boolean) : [] };
        }
        return base;
      });

      const createdBy = auth.currentUser?.uid || null;

      // match AssessmentScreen reader fields
      const firstImage = uploaded.find((x) => x.type === "image")?.url || "";
      const firstVideo = uploaded.find((x) => x.type === "video")?.url || "";

      const payload = {
        title: title.trim(),
        instructions: (instructions || "").trim(),
        context: {
          text: (contextText || "").trim(),
          imageUrl: firstImage,
          videoUrl: firstVideo,
        },
        media: uploaded,
        questions: normalizedQuestions,
        published: true,
        status: "published",
        createdBy,
        createdAt: serverTimestamp(),
        timeLimitSec: 20 * 60, // ✅ workers get 20 min
      };

      const docRef = await addDoc(collection(db, "assessments"), payload);

      // ✅ CRITICAL FIX:
      // assessments/latest MUST include the FULL question paper so AssessmentScreen can load it reliably.
      // (If you only save latestId, the assessment screen may still show "Retry" depending on how it reads data.)
      await setDoc(
        doc(db, "assessments", "latest"),
        {
          ...payload,
          latestId: docRef.id,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setPublishedId(docRef.id);
      setSuccessVisible(true);
    } catch (e) {
      Alert.alert("Publish failed", friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
      <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />

      {/* Header */}
      <View style={[styles.stickyHeader, { paddingTop: insets.top, height: headerTotalHeight }]}>
        <Pressable onPress={goBack} hitSlop={12} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>SKP-ZeroHarm</Text>
          <Text style={styles.headerSub}>Create Assessment</Text>
        </View>

        <TouchableOpacity
          onPress={publish}
          activeOpacity={0.85}
          style={[styles.publishBtn, !canPublish && { opacity: 0.6 }]}
          disabled={!canPublish}
        >
          {busy ? (
            <ActivityIndicator color="#06130A" />
          ) : (
            <Text style={styles.publishBtnText}>Publish</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingTop: headerTotalHeight + spacing(2),
          paddingHorizontal: spacing(2),
          paddingBottom: spacing(5),
        }}
        keyboardShouldPersistTaps="always"
      >
        {/* Title */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Title</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g., Weekly Safety Scenario — Bay 3"
            placeholderTextColor={colors.muted}
            style={styles.input}
            editable={!busy}
          />
        </View>

        {/* Instructions */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Instructions (optional)</Text>
          <TextInput
            value={instructions}
            onChangeText={setInstructions}
            placeholder="Short instruction for the team…"
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
            multiline
            editable={!busy}
          />
        </View>

        {/* Context */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Context / Passage (optional)</Text>
          <TextInput
            value={contextText}
            onChangeText={setContextText}
            placeholder="Paste the scenario, message, or context the team must read before answering…"
            placeholderTextColor={colors.muted}
            style={[styles.input, { minHeight: 110, textAlignVertical: "top" }]}
            multiline
            editable={!busy}
          />
        </View>

        {/* Attachments */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Attachments (optional)</Text>

          <View style={styles.attachRow}>
            <TouchableOpacity
              onPress={() => addFromCamera("image")}
              style={styles.attachBtn}
              activeOpacity={0.85}
              disabled={busy}
            >
              <Text style={styles.attachBtnText}>📷 Photo</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => addFromLibrary("image")}
              style={styles.attachBtn}
              activeOpacity={0.85}
              disabled={busy}
            >
              <Text style={styles.attachBtnText}>🖼️ Gallery</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.attachRow, { marginTop: spacing(1) }]}>
            <TouchableOpacity
              onPress={() => addFromCamera("video")}
              style={styles.attachBtn}
              activeOpacity={0.85}
              disabled={busy}
            >
              <Text style={styles.attachBtnText}>🎥 Video</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => addFromLibrary("video")}
              style={styles.attachBtn}
              activeOpacity={0.85}
              disabled={busy}
            >
              <Text style={styles.attachBtnText}>📁 Video (files)</Text>
            </TouchableOpacity>
          </View>

          {media.length > 0 && (
            <View style={{ marginTop: spacing(1.25) }}>
              {media.map((m) => (
                <View key={m.id} style={styles.mediaItem}>
                  <TouchableOpacity
                    onPress={() => openViewer(m)}
                    activeOpacity={0.9}
                    style={styles.mediaThumbWrap}
                  >
                    {m.type === "image" ? (
                      <Image source={{ uri: m.localUri }} style={styles.mediaThumb} resizeMode="cover" />
                    ) : (
                      <View style={styles.videoThumb}>
                        <Text style={styles.videoThumbText}>Video attached</Text>
                        <Text style={styles.videoThumbHint}>Tap to preview</Text>
                      </View>
                    )}
                  </TouchableOpacity>

                  <View style={{ flex: 1, marginLeft: spacing(1) }}>
                    <Text style={styles.mediaMeta}>{m.type === "image" ? "Image" : "Video"}</Text>
                    <TextInput
                      value={m.caption}
                      onChangeText={(t) =>
                        setMedia((prev) => prev.map((x) => (x.id === m.id ? { ...x, caption: t } : x)))
                      }
                      placeholder="Caption (optional)…"
                      placeholderTextColor={colors.muted}
                      style={styles.captionInput}
                      editable={!busy}
                    />
                    <TouchableOpacity
                      onPress={() => removeMedia(m.id)}
                      activeOpacity={0.85}
                      style={styles.removeBtn}
                      disabled={busy}
                    >
                      <Text style={styles.removeBtnText}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          {media.length === 0 && (
            <Text style={styles.helperText}>
              Add an image/video if the questions depend on a real scenario or evidence.
            </Text>
          )}
        </View>

        {/* Questions */}
        <View style={styles.card}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={[styles.cardTitle, { flex: 1 }]}>Questions</Text>
            <TouchableOpacity
              onPress={openAddQuestion}
              activeOpacity={0.85}
              style={styles.addQBtn}
              disabled={busy}
            >
              <Text style={styles.addQBtnText}>＋ Add</Text>
            </TouchableOpacity>
          </View>

          {questions.length === 0 ? (
            <Text style={styles.helperText}>
              Add at least 1 question. This is a team assessment — it can be one strong question only.
            </Text>
          ) : (
            <View style={{ marginTop: spacing(1) }}>
              {questions.map((q, idx) => (
                <View key={q.id || `${idx}`} style={styles.qItem}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.qType}>{typeLabel(q.type)}</Text>
                    <Text style={styles.qText}>{q.text}</Text>
                    {q.type === "mc" && Array.isArray(q.options) && q.options.length > 0 ? (
                      <Text style={styles.qOptions}>Options: {q.options.join(" • ")}</Text>
                    ) : null}
                  </View>

                  <View style={{ alignItems: "flex-end", marginLeft: spacing(1) }}>
                    <TouchableOpacity
                      onPress={() => openEditQuestion(idx)}
                      activeOpacity={0.85}
                      style={styles.smallBtn}
                      disabled={busy}
                    >
                      <Text style={styles.smallBtnText}>Edit</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => deleteQuestion(idx)}
                      activeOpacity={0.85}
                      style={[styles.smallBtn, { marginTop: 8, backgroundColor: "#FEE2E2" }]}
                      disabled={busy}
                    >
                      <Text style={[styles.smallBtnText, { color: "#991B1B" }]}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          <Text style={[styles.helperText, { marginTop: spacing(1) }]}>
            Tip: Use “Yes/No/N/A” for compliance checks, and “Written” for explanations.
          </Text>
        </View>

        {/* Bottom publish */}
        <TouchableOpacity
          onPress={publish}
          activeOpacity={0.85}
          style={[styles.bottomPublish, !canPublish && { opacity: 0.6 }]}
          disabled={!canPublish}
        >
          {busy ? (
            <ActivityIndicator color="#06130A" />
          ) : (
            <Text style={styles.bottomPublishText}>Publish Assessment</Text>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* ✅ FIXED Question Modal (backdrop is a separate sibling, not wrapping the card) */}
      <Modal visible={qModal} transparent animationType="fade" onRequestClose={() => setQModal(false)}>
        <View style={styles.modalRoot}>
          {/* Backdrop (tap to close) */}
          <Pressable style={styles.modalBackdrop} onPress={() => setQModal(false)} />

          {/* Card (taps inside work normally) */}
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editingIndex >= 0 ? "Edit Question" : "Add Question"}</Text>

            <Text style={styles.modalLabel}>Type</Text>
            <View style={styles.typeGrid}>
              {QUESTION_TYPES.map((t) => {
                const on = qType === t.key;
                return (
                  <TouchableOpacity
                    key={t.key}
                    onPress={() => setQType(t.key)}
                    activeOpacity={0.85}
                    style={[styles.typeChip, on && styles.typeChipOn]}
                  >
                    <Text style={[styles.typeChipText, on && styles.typeChipTextOn]}>{t.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.modalLabel}>Question</Text>
            <TextInput
              value={qText}
              onChangeText={setQText}
              placeholder="Type the question…"
              placeholderTextColor={colors.muted}
              style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
              multiline
            />

            {qType === "mc" && (
              <View style={{ marginTop: spacing(1) }}>
                <Text style={styles.modalLabel}>Options (2+)</Text>
                {[0, 1, 2, 3].map((i) => (
                  <TextInput
                    key={`opt-${i}`}
                    value={qOptions[i]}
                    onChangeText={(t) =>
                      setQOptions((prev) => {
                        const next = [...prev];
                        next[i] = t;
                        return next;
                      })
                    }
                    placeholder={`Option ${i + 1}`}
                    placeholderTextColor={colors.muted}
                    style={[styles.input, { marginTop: 8 }]}
                  />
                ))}
              </View>
            )}

            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: spacing(1.25) }}>
              <TouchableOpacity
                onPress={() => setQModal(false)}
                style={[styles.modalBtnSecondary, { marginRight: 10 }]}
                activeOpacity={0.85}
              >
                <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={saveQuestion} style={styles.modalBtnPrimary} activeOpacity={0.85}>
                <Text style={styles.modalBtnPrimaryText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Media viewer */}
      <Modal visible={viewerVisible} transparent animationType="fade" onRequestClose={() => setViewerVisible(false)}>
        <Pressable style={styles.fullscreen} onPress={() => setViewerVisible(false)}>
          {viewerType === "image" ? (
            <Image source={{ uri: viewerUri }} style={styles.fullImage} resizeMode="contain" />
          ) : (
            <View style={styles.videoFullPlaceholder}>
              <Text style={styles.videoThumbText}>Video attached</Text>
              <Text style={styles.videoThumbHint}>
                This preview is a placeholder. If you want in-app video playback, we’ll add the video player next.
              </Text>
            </View>
          )}
          <View style={styles.fullHint}>
            <Text style={styles.fullHintText}>Tap to close</Text>
          </View>
        </Pressable>
      </Modal>

      {/* Publish success */}
      <Modal visible={successVisible} transparent animationType="fade" onRequestClose={() => setSuccessVisible(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.modalBackdrop} onPress={() => setSuccessVisible(false)} />
          <View style={styles.successCard}>
            <Text style={styles.successTitle}>Published ✅</Text>
            <Text style={styles.successText}>
              Your assessment has been uploaded and is now available to workers under “Weekly Safety Assessment”.
            </Text>

            {!!publishedId && (
              <Text style={[styles.successText, { marginTop: 8 }]}>
                Reference ID: <Text style={{ fontWeight: "900", color: colors.text }}>{publishedId}</Text>
              </Text>
            )}

            <View style={{ flexDirection: "row", gap: 10, marginTop: spacing(1.25) }}>
              <TouchableOpacity
                onPress={() => {
                  setSuccessVisible(false);
                  goBack();
                }}
                style={styles.modalBtnPrimary}
                activeOpacity={0.85}
              >
                <Text style={styles.modalBtnPrimaryText}>Done</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => {
                  setSuccessVisible(false);
                  setTitle("");
                  setContextText("");
                  setMedia([]);
                  setQuestions([]);
                  setEditingIndex(-1);
                  setQText("");
                  setQType("yes_no_na");
                  setQOptions(["", "", "", ""]);
                }}
                style={styles.modalBtnSecondary}
                activeOpacity={0.85}
              >
                <Text style={styles.modalBtnSecondaryText}>Create another</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ---------------- Styles ---------------- */

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

  publishBtn: {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  publishBtnText: { color: "#06130A", fontWeight: "900" },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    padding: spacing(2),
    marginBottom: spacing(1.5),
  },
  cardTitle: { color: colors.text, fontWeight: "900", fontSize: 14, marginBottom: 8 },

  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: colors.text,
    fontWeight: "700",
  },

  helperText: {
    color: colors.muted,
    fontWeight: "700",
    fontSize: 12,
    marginTop: 8,
    lineHeight: 18,
  },

  attachRow: { flexDirection: "row", gap: spacing(1) },
  attachBtn: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
  },
  attachBtnText: { color: colors.text, fontWeight: "900" },

  mediaItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 10,
  },
  mediaThumbWrap: {
    width: 110,
    height: 86,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#fff",
  },
  mediaThumb: { width: "100%", height: "100%" },
  videoThumb: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center", padding: 10 },
  videoThumbText: { color: colors.text, fontWeight: "900", textAlign: "center" },
  videoThumbHint: { color: colors.muted, fontWeight: "700", marginTop: 6, textAlign: "center", fontSize: 12 },

  mediaMeta: { color: colors.muted, fontWeight: "900", fontSize: 12 },

  captionInput: {
    marginTop: 8,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    paddingHorizontal: 12,
    color: colors.text,
    fontWeight: "700",
  },

  removeBtn: {
    marginTop: 8,
    alignSelf: "flex-start",
    backgroundColor: "#FEE2E2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  removeBtnText: { color: "#991B1B", fontWeight: "900" },

  addQBtn: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  addQBtnText: { color: colors.text, fontWeight: "900" },

  qItem: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(1.5),
    marginBottom: spacing(1),
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "flex-start",
  },
  qType: { color: colors.muted, fontWeight: "900", fontSize: 12, marginBottom: 4 },
  qText: { color: colors.text, fontWeight: "900", fontSize: 14, lineHeight: 20 },
  qOptions: { color: colors.muted, fontWeight: "700", fontSize: 12, marginTop: 6 },

  smallBtn: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  smallBtnText: { color: colors.text, fontWeight: "900", fontSize: 12 },

  bottomPublish: {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: spacing(1),
  },
  bottomPublishText: { color: "#06130A", fontWeight: "900", fontSize: 15 },

  // ✅ Modal layout
  modalRoot: {
    flex: 1,
    justifyContent: "center",
    padding: spacing(2),
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  modalCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: spacing(2),
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: { color: colors.text, fontWeight: "900", fontSize: 16, marginBottom: 10 },
  modalLabel: { color: colors.muted, fontWeight: "900", fontSize: 12, marginTop: 10, marginBottom: 6 },

  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  typeChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
  },
  typeChipOn: { backgroundColor: colors.primary, borderColor: "rgba(0,0,0,0.12)" },
  typeChipText: { color: colors.text, fontWeight: "900", fontSize: 12 },
  typeChipTextOn: { color: "#06130A" },

  modalBtnSecondary: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    flex: 1,
    alignItems: "center",
  },
  modalBtnSecondaryText: { color: colors.text, fontWeight: "900" },

  modalBtnPrimary: {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    flex: 1,
    alignItems: "center",
  },
  modalBtnPrimaryText: { color: "#06130A", fontWeight: "900" },

  // Viewer
  fullscreen: { flex: 1, backgroundColor: "black", justifyContent: "center", alignItems: "center" },
  fullImage: { width: "100%", height: "100%" },
  videoFullPlaceholder: {
    width: "92%",
    padding: spacing(2),
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    backgroundColor: "rgba(255,255,255,0.08)",
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

  // Success modal
  successCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: spacing(2),
    borderWidth: 1,
    borderColor: colors.border,
  },
  successTitle: { color: colors.text, fontWeight: "900", fontSize: 18, marginBottom: 8 },
  successText: { color: colors.muted, fontWeight: "700", fontSize: 13, lineHeight: 18 },
});






