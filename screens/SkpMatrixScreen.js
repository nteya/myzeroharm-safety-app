// screens/SkpMatrixScreen.js
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  StatusBar,
  ActivityIndicator,
  Modal,
  Image,
  Linking,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

import { db } from '../firebase';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

// ✅ Use legacy API to remove the deprecation WARN (SDK 54+)
import * as FileSystem from 'expo-file-system/legacy';

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

const TYPE_ORDER = ['Hazard', 'Near Miss', 'Incident', 'Leak', 'Section 23'];

function formatWhen(item) {
  const ms =
    (typeof item.occurredAtMs === 'number' && item.occurredAtMs) ||
    (typeof item.createdAtMs === 'number' && item.createdAtMs) ||
    Date.now();

  if (item.occurredAtText) return item.occurredAtText;

  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function ms7DaysAgo() {
  return Date.now() - 7 * 24 * 60 * 60 * 1000;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeText(s, fallback = '-') {
  const t = String(s || '').trim();
  return t.length ? t : fallback;
}

function pickLocationText(h) {
  return (
    (h.locationText && String(h.locationText).trim()) ||
    (h.area && String(h.area).trim()) ||
    (h.section && String(h.section).trim()) ||
    ''
  );
}

export default function SkpMatrixScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [hazards, setHazards] = useState([]);

  // detail modal
  const [active, setActive] = useState(null);
  const [viewerVisible, setViewerVisible] = useState(false);

  // PDF loading state
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const openInMaps = useCallback((lat, lon) => {
    const url = `https://www.google.com/maps?q=${lat},${lon}`;
    Linking.openURL(url).catch(() => {});
  }, []);

  useEffect(() => {
    const qy = query(collection(db, 'hazards'), orderBy('createdAtMs', 'desc'), limit(300));
    const unsub = onSnapshot(
      qy,
      (snap) => {
        const arr = snap.docs.map((d) => {
          const data = d.data() || {};
          return {
            id: data.id || d.id,
            firestoreId: d.id,
            ...data,
          };
        });
        setHazards(arr);
        setLoading(false);
      },
      () => {
        setLoading(false);
      }
    );

    return () => {
      try {
        unsub && unsub();
      } catch {}
    };
  }, []);

  // WEEK ONLY (last 7 days)
  const weekHazards = useMemo(() => {
    const cutoff = ms7DaysAgo();
    return (hazards || []).filter((h) => {
      const ms =
        (typeof h.occurredAtMs === 'number' && h.occurredAtMs) ||
        (typeof h.createdAtMs === 'number' && h.createdAtMs) ||
        0;
      return ms >= cutoff;
    });
  }, [hazards]);

  const weekStats = useMemo(() => {
    const counts = {};
    for (const t of TYPE_ORDER) counts[t] = 0;

    for (const h of weekHazards) {
      const t = (h.type || 'Hazard').trim();
      if (counts[t] == null) counts[t] = 0;
      counts[t] += 1;
    }

    const rows = TYPE_ORDER.map((t) => ({ type: t, count: counts[t] || 0 }));
    const extraTypes = Object.keys(counts).filter((t) => !TYPE_ORDER.includes(t));
    for (const t of extraTypes) rows.push({ type: t, count: counts[t] || 0 });

    return { rows, total: weekHazards.length };
  }, [weekHazards]);

  const statsAllTime = useMemo(() => {
    const counts = {};
    for (const t of TYPE_ORDER) counts[t] = 0;

    for (const h of hazards) {
      const t = (h.type || 'Hazard').trim();
      if (counts[t] == null) counts[t] = 0;
      counts[t] += 1;
    }

    const rows = TYPE_ORDER.map((t) => ({ type: t, count: counts[t] || 0 }));
    const extraTypes = Object.keys(counts).filter((t) => !TYPE_ORDER.includes(t));
    for (const t of extraTypes) rows.push({ type: t, count: counts[t] || 0 });

    return { rows, total: hazards.length };
  }, [hazards]);

  const recent = useMemo(() => hazards.slice(0, 25), [hazards]);

  const openDetails = (item) => {
    setActive(item);
    setViewerVisible(true);
  };

  const closeDetails = () => {
    setViewerVisible(false);
    setActive(null);
  };

  const hasCoordsActive =
    active?.coords &&
    typeof active.coords.latitude === 'number' &&
    typeof active.coords.longitude === 'number';

  const imgActive = active?.imageUrl || active?.imageUri || '';

  // ✅ Reliable PDF HTML (NO base64 images = no stalls/crashes)
  const buildWeeklyReportHtml = ({ list }) => {
    const now = new Date();
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const headerDate = `${start.toLocaleDateString()} — ${now.toLocaleDateString()}`;

    const statsRowsHtml = weekStats.rows
      .map(
        (r) => `
        <tr>
          <td class="td">${escapeHtml(r.type)}</td>
          <td class="td tdR">${escapeHtml(String(r.count))}</td>
        </tr>
      `
      )
      .join('');

    const hazardsHtml = list
      .map((h) => {
        const title = safeText(h.title, '(No title)');
        const type = safeText((h.type || '').trim(), 'Hazard');
        const category = safeText(h.category, '-');
        const severity = safeText(h.severity, '-');
        const status = safeText(h.status, '-');
        const when = formatWhen(h);
        const reporter = safeText(h.reporterName, 'Anonymous');
        const supervisor = safeText(h.supervisorName, '');

        const locText = pickLocationText(h);
        const coordsLine =
          h?.coords &&
          typeof h.coords.latitude === 'number' &&
          typeof h.coords.longitude === 'number'
            ? `${h.coords.latitude.toFixed(5)}, ${h.coords.longitude.toFixed(5)}`
            : '';

        const desc = (h.description || '').trim();
        const suggestion = (h.actionSuggestion || '').trim();

        const supervisorHtml = supervisor ? ` • <b>Supervisor:</b> ${escapeHtml(supervisor)}` : '';

        const locHtml =
          locText || coordsLine
            ? `<div class="meta mt6">
                ${locText ? `📍 ${escapeHtml(locText)}` : ''}
                ${locText && coordsLine ? ' • ' : ''}
                ${coordsLine ? escapeHtml(coordsLine) : ''}
              </div>`
            : '';

        const descHtml = desc ? `<div class="muted mt6">${escapeHtml(desc)}</div>` : '';
        const suggHtml = suggestion
          ? `<div class="muted mt6"><b>Suggested action:</b> ${escapeHtml(suggestion)}</div>`
          : '';

        // ✅ Always placeholder in PDF (fast + stable)
        const thumbBlock = `
          <div class="thumbWrap placeholder">
            <div class="phText">No photo</div>
          </div>
        `;

        return `
          <div class="hazRow">
            ${thumbBlock}
            <div class="hazBody">
              <div class="titleRow">
                <div class="hTitle">${escapeHtml(title)}</div>
                <div class="chip">${escapeHtml(type)}</div>
              </div>

              <div class="meta">
                <b>Category:</b> ${escapeHtml(category)} •
                <b>Severity:</b> ${escapeHtml(severity)} •
                <b>Status:</b> ${escapeHtml(status)}
              </div>

              <div class="meta mt6">
                <b>Reported by:</b> ${escapeHtml(reporter)}${supervisorHtml} •
                <b>When:</b> ${escapeHtml(when)}
              </div>

              ${locHtml}
              ${descHtml}
              ${suggHtml}
            </div>
          </div>
        `;
      })
      .join('');

    const emptyHtml = `
      <div class="empty">
        No hazards were reported in the last 7 days.
      </div>
    `;

    return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { margin: 22px; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial;
      color: #0F172A;
      margin: 0;
      padding: 0;
    }

    .topbar {
      background: ${SKP_BLUE};
      color: #fff;
      padding: 18px 16px;
      border-radius: 14px;
    }
    .topTitle { font-size: 18px; font-weight: 900; letter-spacing: 0.2px; }
    .topSub { margin-top: 6px; font-size: 12px; font-weight: 700; opacity: 0.9; }

    .section {
      margin-top: 14px;
      padding: 14px;
      border: 1px solid #E6E1E7;
      border-radius: 14px;
      background: #fff;
    }

    .secTitle { font-size: 14px; font-weight: 900; margin-bottom: 10px; }

    .kpi {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .kpiBox {
      flex: 1;
      min-width: 160px;
      border: 1px solid #E6E1E7;
      border-radius: 12px;
      padding: 10px 12px;
      background: #F8FAFC;
    }
    .kpiLabel { font-size: 11px; font-weight: 800; color: #64748B; }
    .kpiVal { margin-top: 4px; font-size: 18px; font-weight: 900; }

    table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border-radius: 12px;
      border: 1px solid #E6E1E7;
    }
    .thRow { background: #F1F5F9; }
    th, td { padding: 10px 12px; font-size: 12px; }
    th { text-align: left; font-weight: 900; }
    .td { border-top: 1px solid #E6E1E7; font-weight: 800; color: #334155; }
    .tdR { text-align: right; }

    .hazList { margin-top: 10px; }

    .hazRow {
      display: flex;
      gap: 12px;
      border: 1px solid #E6E1E7;
      border-radius: 14px;
      padding: 12px;
      margin-top: 10px;
      background: #fff;
      page-break-inside: avoid;
      break-inside: avoid;
    }

    .thumbWrap {
      width: 92px;
      height: 92px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid #E6E1E7;
      flex: 0 0 auto;
      background: #F8FAFC;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .placeholder { background: #F1F5F9; }
    .phText {
      font-size: 10px;
      font-weight: 900;
      color: #64748B;
    }

    .hazBody { flex: 1; min-width: 0; }
    .titleRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .hTitle {
      font-size: 13px;
      font-weight: 900;
      color: #0F172A;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip {
      font-size: 10px;
      font-weight: 900;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid #E6E1E7;
      background: #F8FAFC;
      color: #0F172A;
      flex: 0 0 auto;
    }
    .meta {
      margin-top: 6px;
      font-size: 11px;
      font-weight: 700;
      color: #475569;
      line-height: 15px;
    }
    .muted {
      font-size: 11px;
      color: #334155;
      font-weight: 700;
      line-height: 16px;
    }
    .mt6 { margin-top: 6px; }

    .empty {
      padding: 12px;
      border-radius: 14px;
      border: 1px dashed #CBD5E1;
      background: #F8FAFC;
      color: #475569;
      font-weight: 800;
      font-size: 12px;
    }

    .footer {
      margin-top: 14px;
      font-size: 10px;
      color: #64748B;
      font-weight: 700;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="topTitle">SKP-MyZeroHarm Weekly Report</div>
    <div class="topSub">Reporting period: ${escapeHtml(headerDate)} • Generated: ${escapeHtml(now.toLocaleString())}</div>
  </div>

  <div class="section">
    <div class="secTitle">Weekly Summary</div>

    <div class="kpi">
      <div class="kpiBox">
        <div class="kpiLabel">Total weekly reports</div>
        <div class="kpiVal">${escapeHtml(String(weekStats.total))}</div>
      </div>
      <div class="kpiBox">
        <div class="kpiLabel">All-time reports (last 300 loaded)</div>
        <div class="kpiVal">${escapeHtml(String(statsAllTime.total))}</div>
      </div>
    </div>

    <table>
      <tr class="thRow">
        <th>Type</th>
        <th style="text-align:right;">Count</th>
      </tr>
      ${statsRowsHtml}
    </table>
  </div>

  <div class="section">
    <div class="secTitle">Weekly Reports</div>
    <div class="hazList">
      ${list.length ? hazardsHtml : emptyHtml}
    </div>
  </div>

  <div class="footer">
    Confidential • Internal safety reporting • SKP-MyZeroHarm
  </div>
</body>
</html>
`;
  };

  // ✅ Generate weekly PDF (stable again)
  const generateWeeklyPdf = async () => {
    if (generatingPdf) return;
    if (loading) return Alert.alert('Please wait', 'Still loading reports…');

    try {
      setGeneratingPdf(true);

      // keep it stable if lots of hazards
      const MAX_WEEKLY = 120;
      const list = weekHazards.slice(0, MAX_WEEKLY);

      const html = buildWeeklyReportHtml({ list });

      const { uri } = await Print.printToFileAsync({
        html,
        base64: false,
      });

      const safeName = `SKP-MyZeroHarm_Weekly-Report_${new Date().toISOString().slice(0, 10)}.pdf`;
      const dest = `${FileSystem.documentDirectory}${safeName}`;

      // Try save in documents; if it fails, we still share the original uri.
      let shareUri = uri;
      try {
        await FileSystem.copyAsync({ from: uri, to: dest });
        shareUri = dest;
      } catch {}

      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Saved', 'PDF created successfully (sharing not available on this device).');
        return;
      }

      // If sharing the saved dest fails for any reason, fallback to the temp uri
      try {
        await Sharing.shareAsync(shareUri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share weekly report',
          UTI: 'com.adobe.pdf',
        });
      } catch {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share weekly report',
          UTI: 'com.adobe.pdf',
        });
      }
    } catch (e) {
      Alert.alert('PDF error', 'Cannot generate PDF. Please try again.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['left', 'right', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={SKP_BLUE} />

      <View style={[styles.header, { paddingTop: insets.top }]}>
        <Pressable onPress={() => navigation.goBack()} style={styles.backBtn} hitSlop={12}>
          <Text style={styles.backText}>←</Text>
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>SKP Matrix / Stats</Text>
          <Text style={styles.headerSub}>Real-time hazard trends</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing(2), paddingBottom: spacing(10) }}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Overview</Text>
          {loading ? (
            <View style={{ marginTop: 12 }}>
              <ActivityIndicator />
              <Text style={{ color: colors.muted, marginTop: 8, fontWeight: '700' }}>
                Loading live stats…
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.kpiText}>
                Total reports: <Text style={styles.kpiStrong}>{statsAllTime.total}</Text>
              </Text>

              <View style={styles.tableWrap}>
                <View style={styles.tableHeaderRow}>
                  <Text style={[styles.th, { flex: 1 }]}>Type</Text>
                  <Text style={[styles.th, { width: 80, textAlign: 'right' }]}>Count</Text>
                </View>

                {statsAllTime.rows.map((r) => (
                  <View key={r.type} style={styles.tableRow}>
                    <Text style={[styles.td, { flex: 1 }]}>{r.type}</Text>
                    <Text style={[styles.td, { width: 80, textAlign: 'right', fontWeight: '900' }]}>
                      {r.count}
                    </Text>
                  </View>
                ))}
              </View>

              <Text style={styles.note}>
                Tip: Tap a report below to open full details (photo, location, supervisor, status).
              </Text>
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent reports</Text>

          {loading ? (
            <View style={{ marginTop: 12 }}>
              <ActivityIndicator />
            </View>
          ) : recent.length === 0 ? (
            <Text style={{ color: colors.muted, marginTop: 10, fontWeight: '700' }}>
              No reports yet.
            </Text>
          ) : (
            <View style={{ marginTop: 10, gap: 10 }}>
              {recent.map((h) => {
                const when = formatWhen(h);
                const t = (h.type || 'Hazard').trim();
                const loc = pickLocationText(h);
                return (
                  <Pressable
                    key={h.firestoreId || h.id}
                    onPress={() => openDetails(h)}
                    style={styles.row}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {h.title || '(No title)'}
                      </Text>
                      <Text style={styles.rowMeta} numberOfLines={2}>
                        {t} • {h.category || 'No category'} • {when}
                      </Text>
                      {!!loc && (
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          📍 {loc}
                        </Text>
                      )}
                    </View>

                    <View style={styles.countPill}>
                      <Text style={styles.countPillText}>View</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <Pressable
          onPress={generatingPdf ? undefined : generateWeeklyPdf}
          style={[styles.pdfBtn, (generatingPdf || loading) && { opacity: 0.65 }]}
          disabled={generatingPdf || loading}
        >
          {generatingPdf ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ActivityIndicator color="#06130A" />
              <Text style={styles.pdfBtnText}>Generating PDF…</Text>
            </View>
          ) : (
            <Text style={styles.pdfBtnText}>Generate Weekly PDF Report</Text>
          )}
        </Pressable>
      </ScrollView>

      <Modal visible={viewerVisible} transparent animationType="fade" onRequestClose={closeDetails}>
        <Pressable style={styles.modalBackdrop} onPress={closeDetails}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{active?.title || 'Report details'}</Text>
            <Text style={styles.modalSub}>
              {(active?.type || 'Hazard')} • {formatWhen(active || {})}
            </Text>

            <View style={styles.detailLine}>
              <Text style={styles.detailKey}>Category:</Text>
              <Text style={styles.detailVal}>{active?.category || '-'}</Text>
            </View>

            <View style={styles.detailLine}>
              <Text style={styles.detailKey}>Severity:</Text>
              <Text style={styles.detailVal}>{active?.severity || '-'}</Text>
            </View>

            <View style={styles.detailLine}>
              <Text style={styles.detailKey}>Status:</Text>
              <Text style={styles.detailVal}>{active?.status || '-'}</Text>
            </View>

            <View style={styles.detailLine}>
              <Text style={styles.detailKey}>Reported by:</Text>
              <Text style={styles.detailVal}>{active?.reporterName || 'Anonymous'}</Text>
            </View>

            {!!active?.supervisorName && (
              <View style={styles.detailLine}>
                <Text style={styles.detailKey}>Supervisor:</Text>
                <Text style={styles.detailVal}>{active?.supervisorName}</Text>
              </View>
            )}

            {!!active?.description && (
              <View style={{ marginTop: 10 }}>
                <Text style={styles.detailKey}>Description</Text>
                <Text style={styles.longText}>{active.description}</Text>
              </View>
            )}

            {!!active?.actionSuggestion && (
              <View style={{ marginTop: 10 }}>
                <Text style={styles.detailKey}>Suggested action</Text>
                <Text style={styles.longText}>{active.actionSuggestion}</Text>
              </View>
            )}

            {!!imgActive && (
              <View style={{ marginTop: 12 }}>
                <Image source={{ uri: imgActive }} style={styles.modalImage} resizeMode="cover" />
              </View>
            )}

            {(() => {
              const loc = pickLocationText(active || {});
              return loc ? (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.detailKey}>Area / Location</Text>
                  <Text style={styles.longText}>{loc}</Text>
                </View>
              ) : null;
            })()}

            {(active?.locationText || hasCoordsActive) && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.detailKey}>Coordinates</Text>
                <Text style={styles.longText}>
                  {hasCoordsActive
                    ? `${active.coords.latitude.toFixed(5)}, ${active.coords.longitude.toFixed(5)}`
                    : ''}
                </Text>

                {hasCoordsActive ? (
                  <Pressable
                    onPress={() => openInMaps(active.coords.latitude, active.coords.longitude)}
                    style={styles.mapsBtn}
                  >
                    <Text style={styles.mapsBtnText}>Open in Maps</Text>
                  </Pressable>
                ) : null}
              </View>
            )}

            <Pressable onPress={closeDetails} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
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

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing(2),
    marginBottom: spacing(1.5),
  },
  cardTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },

  kpiText: { color: colors.muted, marginTop: 10, fontWeight: '800' },
  kpiStrong: { color: colors.text, fontWeight: '900' },

  tableWrap: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    overflow: 'hidden',
  },
  tableHeaderRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#F1F5F9',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  th: { color: colors.text, fontWeight: '900', fontSize: 12 },

  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  td: { color: colors.muted, fontWeight: '800', fontSize: 13 },

  note: { color: colors.muted, marginTop: 12, fontWeight: '700', lineHeight: 18 },

  row: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 12,
  },
  rowTitle: { color: colors.text, fontWeight: '900', fontSize: 14 },
  rowMeta: { color: colors.muted, fontWeight: '700', marginTop: 3, fontSize: 12 },

  countPill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#F8FAFC',
  },
  countPillText: { color: colors.text, fontWeight: '900', fontSize: 12 },

  pdfBtn: {
    marginTop: spacing(0.5),
    marginBottom: spacing(2),
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  pdfBtnText: { color: '#06130A', fontWeight: '900', fontSize: 14 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: spacing(2),
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    padding: spacing(2),
  },
  modalTitle: { color: colors.text, fontWeight: '900', fontSize: 16 },
  modalSub: { color: colors.muted, fontWeight: '800', marginTop: 6 },

  detailLine: { flexDirection: 'row', gap: 10, marginTop: 10 },
  detailKey: { color: colors.muted, fontWeight: '900', width: 110 },
  detailVal: { color: colors.text, fontWeight: '800', flex: 1 },

  longText: { color: colors.text, fontWeight: '700', marginTop: 6, lineHeight: 20 },

  modalImage: {
    width: '100%',
    height: 200,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },

  mapsBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#0F1720',
  },
  mapsBtnText: { color: '#E5E7EB', fontWeight: '900', fontSize: 12 },

  closeBtn: {
    marginTop: 14,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  closeBtnText: { color: '#06130A', fontWeight: '900' },
});