// functions/index.js
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const REGION = 'us-central1';
const DAILY_REQUEST_CAP = 200;
const CACHE_COLLECTION = 'aiPlans';
const USAGE_COLLECTION = 'system/openai_usage/days';

// Reveal hour for assessments (local server time); override via env
const REVEAL_HOUR = Number(process.env.ASSESS_REVEAL_HOUR || 19); // 19:00 (7pm)

// ---------- helpers ----------
const asStr = (v) => (typeof v === 'string' ? v.trim() : '');

function padToTen(arr, pool = []) {
  const out = (Array.isArray(arr) ? arr : [])
    .filter(Boolean).map(String).map((s) => s.trim()).filter(Boolean);
  const base = out.slice(0, 10);
  let i = 0;
  while (base.length < 10 && i < pool.length) {
    const item = String(pool[i++] || '').trim();
    if (item && !base.includes(item)) base.push(item);
  }
  return base.slice(0, 10);
}

function normalizePlan(raw) {
  const plan = {};
  const toStrArr = (x) => (Array.isArray(x) ? x : [])
    .map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);

  plan.checklist = toStrArr(raw?.checklist).slice(0, 24);

  const dosPool = [
    'Keep walkways clear','Use correct tool for the job','Stop if unsure and ask',
    'Confirm radio channel and hand signals','Keep good posture while lifting',
    'Store cylinders upright and secured','Barricade work area where needed',
    'Verify permits and isolations','Keep area tidy during work','Hand over safely at end of task'
  ];
  const dontPool = [
    'Don’t rush—plan first','Don’t remove machine guards','Don’t defeat interlocks',
    'Don’t improvise slings/rigging','Don’t ignore early signs of fatigue',
    'Don’t block emergency exits','Don’t enter restricted zones without permit',
    'Don’t stand under suspended loads','Don’t operate untrained','Don’t bypass PPE'
  ];
  plan.dos = padToTen(toStrArr(raw?.dos), dontPool);
  plan.donts = padToTen(toStrArr(raw?.donts), dontPool);

  plan.risks = toStrArr(raw?.risks).slice(0, 24);
  plan.wellness = toStrArr(raw?.wellness).slice(0, 24);
  plan.ppe = Array.from(new Set(toStrArr(raw?.ppe))).slice(0, 24);

  const hc = Array.isArray(raw?.hazardsControls) ? raw.hazardsControls : [];
  plan.hazardsControls = hc
    .map((h) => ({ hazard: asStr(h?.hazard), control: asStr(h?.control) }))
    .filter((x) => x.hazard && x.control)
    .slice(0, 24);

  return plan;
}

// ---------- offline plan + chat fallbacks ----------
function offlinePlan(task, details) {
  const text = `${task}\n${details}`.toLowerCase();
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
  const add = (arr, ...items) => items.forEach((i) => { if (!arr.includes(i)) arr.push(i); });
  const hc = (list, hazard, control) => list.push({ hazard, control });

  const dos = [], donts = [], risks = [], wellness = [], ppe = [], hazardsControls = [];
  add(dos, 'Brief team on roles & signals','Keep exclusion zones/barriers in place','Report near-misses immediately');
  add(donts, 'Bypass guards or PPE','Work alone on high-risk tasks');
  add(risks, 'Pinch points & line-of-fire','Slips/trips on uneven ground');
  add(wellness, 'Hydrate every 30–45 minutes','Take micro-breaks to reset focus');
  add(ppe, 'Hard hat','Safety glasses','Hearing protection','Steel-toe boots','High-vis vest','Work gloves');

  if (/(height|ladder|scaffold|roof|platform)/.test(text)) {
    add(dos, 'Use fall-arrest (harness, lanyard, anchor)','Maintain 3-point contact on ladders');
    add(donts, 'Overreach beyond guardrails','Stand on top two rungs');
    add(risks, 'Falls, dropped objects, unguarded edges');
    hc(hazardsControls, 'Fall from height', 'Certified anchor + inspected lanyard; guardrails/toeboards; tool lanyards');
    add(ppe, 'Full-body harness & shock-absorbing lanyard');
  }
  if (/(confined|tank|vessel|manhole|silo)/.test(text)) {
    add(dos, 'Confined space permit & gas test (O₂, LEL, H₂S)','Ventilation & standby attendant');
    add(donts, 'Enter without rescue plan','Block entry with hoses/cables');
    add(risks, 'Asphyxiation, toxic gases, entrapment');
    hc(hazardsControls, 'Toxic/low oxygen atmosphere', 'Continuous gas monitoring; forced ventilation; stop if alarm');
    add(ppe, 'Rescue harness','Respirator (per gas test)','Portable gas detector');
  }
  if (/(electrical|panel|cable|breaker|live)/.test(text)) {
    add(dos, 'Isolate & lock/tag — verify zero energy','Use insulated tools & arc-rated PPE');
    add(donts, 'Assume it’s dead — test first');
    add(risks, 'Shock, arc flash, burns');
    hc(hazardsControls, 'Shock/arc flash', 'LOTO; test before touch; approach distances; arc barriers');
    add(ppe, 'Arc-rated face shield/hood','Insulated gloves (rated)','FR clothing');
  }
  if (/(weld|hot work|cut|grind|torch)/.test(text)) {
    add(dos, 'Hot-work permit & fire watch','Shield sparks; extinguisher nearby');
    add(donts, 'Hot-work near flammables','Leave smoldering materials');
    add(risks, 'Fire, eye injuries, flying particles');
    hc(hazardsControls, 'Sparks & hot slag', 'Fire watch 30 min after; spark containment; remove combustibles');
    add(ppe, 'Welding helmet/face shield','Leather gauntlet gloves','FR jacket/apron');
  }
  if (/(lift|crane|rig|hoist|forklift|sling)/.test(text)) {
    add(dos, 'Inspect slings/hooks, verify SWL','Set exclusion zone & use spotter');
    add(donts, 'Stand under suspended loads','Exceed rated capacity');
    add(risks, 'Dropped loads, swing, crush injuries');
    hc(hazardsControls, 'Dropped load', 'Tag lines; clear path; trained rigger; stay within SWL');
    add(ppe, 'Hard hat (chin strap if windy)','Safety boots');
  }
  if (/(excavat|trench|dig|pit)/.test(text)) {
    add(dos, 'Locate services, shore/slope trenches','Keep spoil ≥1 m from edge');
    add(donts, 'Enter unsupported trench >1.2 m','Park machines near edges');
    add(risks, 'Collapse, engulfment, striking utilities');
    hc(hazardsControls, 'Trench wall collapse', 'Shoring/shielding or slope; ladder every 7.5 m; inspect after rain');
    add(ppe, 'Hi-vis vest','Safety boots');
  }
  if (/(chemic|solvent|acid|paint)/.test(text)) {
    add(dos, 'Read SDS & use specified PPE','Provide ventilation & spill kit');
    add(donts, 'Mix chemicals unless specified','Store incompatibles together');
    add(risks, 'Chemical burns, inhalation, reactions');
    hc(hazardsControls, 'Chemical exposure/splash', 'Closed containers; eyewash nearby; decant with funnels; fume extraction');
    add(ppe, 'Chemical-resistant gloves','Goggles + face shield','APR/respirator as required','Chemical apron');
  }
  if (/(drive|truck|haul|traffic|vehicle)/.test(text)) {
    add(dos, 'Pre-start checks; seatbelt on','Follow site speed & right-of-way');
    add(donts, 'Use phone while driving','Tailgate on haul roads');
    add(risks, 'Collisions, rollovers, pedestrians in path');
    hc(hazardsControls, 'Pedestrian strike', 'Spotters; horns/lights; one-way systems; haul roads only');
    add(wellness, 'Plan rest >2h driving — fatigue risk');
    add(ppe, 'Hi-vis vest','Safety boots');
  }
  if (/(blast|explosive)/.test(text)) {
    add(dos, 'Clearance zones & sirens as plan','Account for personnel before firing');
    add(donts, 'Re-enter until all-clear','Handle misfires without procedure');
    add(risks, 'Flyrock, overpressure, misfires');
    hc(hazardsControls, 'Flyrock/overpressure', 'Evacuate to safe distance; shelter; radio discipline');
    add(ppe, 'Hard hat','Hearing protection','Safety glasses');
  }
  if (/(maintain|service|repair|lockout|loto)/.test(text)) {
    add(dos, 'Zero-energy test after isolation','Bleed pressure & block movement');
    add(donts, 'Rely on a switch alone','Remove others’ locks/tags');
    add(risks, 'Unexpected start, stored energy release');
    hc(hazardsControls, 'Unexpected start-up', 'Apply LOTO; verify zero energy; try-start test');
  }

  const dosPool = [
    'Keep walkways clear','Use correct tool for the job','Stop if unsure and ask',
    'Confirm radio channel and hand signals','Keep good posture while lifting',
    'Store cylinders upright and secured','Barricade work area where needed',
    'Verify permits and isolations','Keep area tidy during work','Hand over safely at end of task'
  ];
  const dontPool = [
    'Don’t rush—plan first','Don’t remove machine guards','Don’t defeat interlocks',
    'Don’t improvise slings/rigging','Don’t ignore early signs of fatigue',
    'Don’t block emergency exits','Don’t enter restricted zones without permit',
    'Don’t stand under suspended loads','Don’t operate untrained','Don’t bypass PPE'
  ];

  return {
    checklist: BASE_CHECKS,
    dos: padToTen(dos, dosPool),
    donts: padToTen(donts, dontPool),
    risks,
    wellness,
    ppe: Array.from(new Set(ppe)),
    hazardsControls,
  };
}

function offlineChatAnswer(question, task) {
  const plan = offlinePlan(task || 'General', question || '');
  const bits = [];
  bits.push('Here’s practical guidance:');
  if (plan.dos?.length) bits.push(`Do:\n- ${plan.dos.slice(0,5).join('\n- ')}`);
  if (plan.donts?.length) bits.push(`Don’t:\n- ${plan.donts.slice(0,5).join('\n- ')}`);
  if (plan.ppe?.length) bits.push(`PPE:\n- ${plan.ppe.slice(0,6).join('\n- ')}`);
  if (plan.hazardsControls?.length) {
    const top = plan.hazardsControls.slice(0,2).map(h => `• ${h.hazard} → ${h.control}`);
    bits.push(`Hazards & controls:\n${top.join('\n')}`);
  }
  bits.push('This guidance complements your site procedures — follow supervisor instructions and permits.');
  return bits.join('\n\n');
}

// ---------- offline tips ----------
function offlineDailyTips() {
  const pool = [
    'Wear the right PPE for the task—don’t guess, check the SDS/permit.',
    'Inspect tools before use: guards on, cables intact, tags current.',
    'Keep walkways clear—housekeeping prevents slips and trips.',
    'Use spotters and signals when moving vehicles or lifting loads.',
    'Hydrate every 30–45 minutes; heat and fatigue build up quietly.',
    'Lock out, tag out, and verify zero energy before maintenance.',
    'Maintain three points of contact on ladders; no top-two rungs.',
    'Shield sparks for hot work; keep extinguishers and a fire watch.',
    'Know your emergency routes; don’t block extinguishers or exits.',
    'Stop and ask if unsure—nothing is urgent enough to skip safety.',
    'Set exclusion zones for overhead work; secure tools against drops.',
    'Use correct lifting posture; get help or a device for heavy items.',
    'Gas test confined spaces and ventilate—don’t enter without a plan.',
    'Drive defensively on site roads; seatbelt on, phone off.',
  ];
  return pool.slice(0, 10);
}

// ---------- assessment (DAILY) helpers ----------
function revealAtMsForDate(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setHours(REVEAL_HOUR, 0, 0, 0);
  return d.getTime();
}

function makeStaticDailyAssessmentFallback() {
  // 15 items total: 7 TF + 8 MC (simple, generic mining safety)
  const questions = [
    // TF (7)
    { id:'tf1', type:'tf', text:'Always keep walkways clear to prevent slips and trips.' },
    { id:'tf2', type:'tf', text:'Removing a machine guard briefly is acceptable if supervised.' },
    { id:'tf3', type:'tf', text:'Use three points of contact when climbing ladders.' },
    { id:'tf4', type:'tf', text:'You may enter a confined space without a permit if you can see inside.' },
    { id:'tf5', type:'tf', text:'LOTO is used to isolate energy and verify zero energy before work.' },
    { id:'tf6', type:'tf', text:'Barricades/exclusion zones must be respected at all times.' },
    { id:'tf7', type:'tf', text:'You should report near-misses even if nobody was injured.' },
    // MC (8)
    { id:'mc1', type:'mc', text:'What does LOTO stand for?', options:['Lockout/Tagout','Lookout/Timeout','Lock-on/Tag-over','Loadout/Turnoff'] },
    { id:'mc2', type:'mc', text:'Before hot work you should:', options:['Skip permits','Check wind only','Have permit + fire watch + extinguisher','Remove all PPE'] },
    { id:'mc3', type:'mc', text:'First control for working at height:', options:['Use taller ladder','Eliminate need to work at height','Stand on top rung','Lean ladder on moving vehicle'] },
    { id:'mc4', type:'mc', text:'When handling acids:', options:['Open sandals are fine','Use chemical gloves & face shield','No PPE if careful','Cotton gloves only'] },
    { id:'mc5', type:'mc', text:'Damaged sling with broken strands:', options:['Use for light loads','Double-wrap and use','Remove from service','Only use after lunch'] },
    { id:'mc6', type:'mc', text:'On haul roads, pedestrians should:', options:['Walk anywhere','Use designated crossings/paths','Stand behind trucks','Wave to drivers'] },
    { id:'mc7', type:'mc', text:'Arc-flash hazard requires:', options:['Sunglasses only','Approach distance + arc-rated PPE','Turn back to arc','Work faster'] },
    { id:'mc8', type:'mc', text:'Best housekeeping practice:', options:['Store tools on stairs','Keep walkways clear and tidy','Leave hoses across paths','Pile cables at exits'] },
  ];
  const answerKey = [
    true, false, true, false, true, true, true, // TF (7)
    0, 2, 1, 1, 2, 1, 1, 1                      // MC (8)
  ];
  return { questions, answerKey };
}

// ===== Main HTTPS function (modes: plan | chat | tips | assessmentDaily) =====
exports.generateSafetyPlan = onRequest(
  {
    region: REGION,
    cors: true,
    maxInstances: 5,
    secrets: ['OPENAI_API_KEY'],
    timeoutSeconds: 20,
  },
  async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(204).send('');
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

      res.set('Access-Control-Allow-Origin', '*');

      const mode = asStr(req.body?.mode || 'plan'); // 'plan' | 'chat' | 'tips' | 'assessmentDaily'
      const task = asStr(req.body?.task);
      const details = asStr(req.body?.details);
      const question = asStr(req.body?.question);
      const locale = asStr(req.body?.locale || 'en');
      const date = asStr(req.body?.date); // YYYY-MM-DD
      const revealRequested = req.body?.reveal === true || req.query?.reveal === '1';

      // ---------- assessmentDaily: AI 15 Q once per date ----------
      if (mode === 'assessmentDaily') {
        if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });

        const dateKey = date;
        const revealAtMs = revealAtMsForDate(date);
        const docRef = db.collection('dailyAssessments').doc(dateKey);

        let snap = await docRef.get();
        if (!snap.exists) {
          // rate-limit under the same daily usage doc
          const today = new Date().toISOString().slice(0, 10);
          const usageRef = db.collection(USAGE_COLLECTION).doc(today);
          let allowed = true;
          await db.runTransaction(async (tx) => {
            const us = await tx.get(usageRef);
            const cur = us.exists ? (us.data().requests || 0) : 0;
            if (cur >= DAILY_REQUEST_CAP) { allowed = false; return; }
            tx.set(
              usageRef,
              { requests: cur + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );
          });

          if (!allowed) {
            const fb = makeStaticDailyAssessmentFallback();
            await docRef.set(
              {
                dateKey,
                version: 'v1',
                revealAt: admin.firestore.Timestamp.fromMillis(revealAtMs),
                questions: fb.questions,
                answerKey: fb.answerKey,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                from: 'fallback',
              },
              { merge: false }
            );
            snap = await docRef.get();
          } else {
            try {
              const { default: OpenAI } = await import('openai');
              const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

              const sys = [
                'You are a mining & heavy industry safety trainer.',
                'Return ONLY valid JSON with schema:',
                '{ "questions": [ { "id": string, "type": "tf"|"mc", "text": string, "options"?: [string,string,string,string] } ... exactly 15 items ],',
                '"answerKey": [boolean|number ... exactly 15 items in same order] }',
                'Rules:',
                '- Exactly 15 questions TOTAL for the day.',
                '- Use a mix of True/False and Multiple Choice (A/B/C/D).',
                '- For tf: set "type":"tf" and DO NOT include "options".',
                '- For mc: set "type":"mc" and include "options" array of exactly 4 strings.',
                '- "answerKey" aligns with questions: tf→true/false, mc→0..3.',
                '- Keep questions clear, concise, generic to mines & heavy industry.',
                '- Cover PPE, housekeeping, line-of-fire, LOTO, vehicle interaction, hot work, heights, confined space, emergency readiness, fatigue/heat/cold.',
                'IMPORTANT: JSON only. No commentary.'
              ].join(' ');
              const user = JSON.stringify({ dateKey, locale });

              const completion = await client.chat.completions.create({
                model: 'gpt-4o-mini',
                temperature: 0.2,
                response_format: { type: 'json_object' },
                messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
              });

              let questions = [];
              let answerKey = [];
              try {
                const raw = completion?.choices?.[0]?.message?.content || '{}';
                const parsed = JSON.parse(raw);
                questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
                answerKey = Array.isArray(parsed?.answerKey) ? parsed.answerKey : [];
              } catch (_) {}

              // strict validation
              const valid =
                questions.length === 15 &&
                answerKey.length === 15 &&
                questions.every((q) => q && (q.type === 'tf' || q.type === 'mc') && typeof q.text === 'string') &&
                questions
                  .filter((q) => q.type === 'mc')
                  .every((q) => Array.isArray(q.options) && q.options.length === 4) &&
                answerKey.every((v, i) => {
                  const q = questions[i];
                  return q?.type === 'tf'
                    ? typeof v === 'boolean'
                    : Number.isInteger(v) && v >= 0 && v <= 3;
                });

              if (!valid) {
                const fb = makeStaticDailyAssessmentFallback();
                questions = fb.questions;
                answerKey = fb.answerKey;
              }

              await docRef.set(
                {
                  dateKey,
                  version: 'v1',
                  revealAt: admin.firestore.Timestamp.fromMillis(revealAtMs),
                  questions,
                  answerKey,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  from: valid ? 'ai' : 'fallback',
                },
                { merge: false }
              );
              snap = await docRef.get();
            } catch (e) {
              logger.error('assessmentDaily AI error', e?.message || e);
              const fb = makeStaticDailyAssessmentFallback();
              await docRef.set(
                {
                  dateKey,
                  version: 'v1',
                  revealAt: admin.firestore.Timestamp.fromMillis(revealAtMs),
                  questions: fb.questions,
                  answerKey: fb.answerKey,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  from: 'fallback',
                },
                { merge: false }
              );
              snap = await docRef.get();
            }
          }
        }

        const data = snap.data() || {};
        const now = Date.now();
        const revealMs = data.revealAt?.toMillis ? data.revealAt.toMillis() : revealAtMs;

        return res.json({
          ok: true,
          data: {
            dateKey: data.dateKey || dateKey,
            version: data.version || 'v1',
            revealAt: revealMs,
            questions: data.questions || [],
            answerKey: revealRequested && now >= revealMs ? data.answerKey : undefined,
            from: data.from || 'cache',
          },
        });
      }

      // ---------- existing modes: plan | chat | tips ----------
      if (mode === 'plan' && !task) return res.status(400).json({ error: 'task is required' });
      if (mode === 'chat' && !question) return res.status(400).json({ error: 'question is required' });
      if (mode === 'tips' && !date) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });

      // daily cap
      const today = new Date().toISOString().slice(0, 10);
      const usageRef = db.collection(USAGE_COLLECTION).doc(today);
      let allowed = true;
      await db.runTransaction(async (tx) => {
        const s = await tx.get(usageRef);
        const current = s.exists ? (s.data().requests || 0) : 0;
        if (current >= DAILY_REQUEST_CAP) { allowed = false; return; }
        tx.set(usageRef, { requests: current + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
      if (!allowed) {
        if (mode === 'tips') return res.status(200).json({ fallback: true, data: { tips: offlineDailyTips() } });
        if (mode === 'chat') return res.status(200).json({ fallback: true, data: { answer: offlineChatAnswer(question, task) } });
        return res.status(200).json({ fallback: true, data: offlinePlan(task, details) });
      }

      // cache key
      const keySeed =
        mode === 'tips'
          ? `tips||${locale}||${date}`
          : mode === 'chat'
            ? `chat||${locale}||${task}||${question}`
            : `plan||${locale}||${task}||${details}`;
      const hash = crypto.createHash('sha256').update(keySeed).digest('hex');
      const cacheRef = db.collection(CACHE_COLLECTION).doc(hash);
      const cached = await cacheRef.get();
      if (cached.exists) return res.json({ fromCache: true, data: cached.data().result });

      // dynamic import
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      // moderation (best-effort)
      try {
        const modInput =
          mode === 'tips' ? `Generate 10 daily safety tips for mining & heavy industry. Date: ${date}`
          : mode === 'chat' ? question
          : `${task}\n${details}`;
        const mod = await client.moderations.create({ model: 'omni-moderation-latest', input: modInput });
        if (mod?.results?.[0]?.flagged) {
          const fb =
            mode === 'tips' ? { tips: offlineDailyTips() }
            : mode === 'chat' ? { answer: offlineChatAnswer(question, task) }
            : offlinePlan(task, details);
          return res.status(400).json({ error: 'Content flagged by moderation', fallback: true, data: fb });
        }
      } catch (e) {
        logger.warn('Moderation failed; continuing:', e?.message);
      }

      if (mode === 'tips') {
        const sys = [
          'You are a workplace safety officer for mining & heavy industry.',
          'Return ONLY valid JSON: { "tips": [string, ...] }.',
          'Provide exactly 10 concise, practical safety tips for general site work.',
          'Blend PPE, housekeeping, line-of-fire, LOTO, vehicle interaction, hot work, heights, confined space, emergency readiness, hydration/fatigue.',
          'Avoid medical/legal advice; site-generic best practice.',
          `If locale != "en", translate to that locale (e.g., "zu", "af").`
        ].join(' ');
        const user = JSON.stringify({ date, locale });

        const completion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        });

        let tips = [];
        try {
          const raw = completion?.choices?.[0]?.message?.content || '{}';
          const parsed = JSON.parse(raw);
          tips = Array.isArray(parsed?.tips) ? parsed.tips.map(asStr).filter(Boolean).slice(0, 10) : [];
        } catch (e) {
          logger.error('tips JSON parse failed; fallback', e?.message);
          tips = offlineDailyTips();
        }
        if (tips.length < 10) {
          const padPool = offlineDailyTips();
          while (tips.length < 10 && padPool.length) {
            const t = padPool.shift(); if (t && !tips.includes(t)) tips.push(t);
          }
          tips = tips.slice(0, 10);
        }

        await cacheRef.set({
          key: hash, mode, date, locale,
          result: { tips },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: false });

        return res.json({ fromCache: false, data: { tips } });
      }

      if (mode === 'chat') {
        const sys = [
          'You are a workplace safety officer for mining & heavy industry.',
          'Answer clearly with practical, site-generic guidance.',
          'No medical or legal advice; remind to follow site procedures and supervisor instructions.',
          'Prefer concise paragraphs and short bullet points when helpful.',
          'Keep it under ~180 words.',
          `If locale != "en", answer in that locale (e.g., "zu", "af").`
        ].join(' ');
        const user = JSON.stringify({ question, taskContext: task, locale });

        const completion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.4,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        });

        let answer = (completion?.choices?.[0]?.message?.content || '').trim();
        if (!answer) answer = offlineChatAnswer(question, task);

        await cacheRef.set({
          key: hash, mode, question, task, locale,
          result: { answer },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: false });

        return res.json({ fromCache: false, data: { answer } });
      }

      // -------- plan --------
      const sys = [
        'You are a workplace safety officer for mining & heavy industry.',
        'Return ONLY valid JSON with keys: checklist, dos, donts, risks, wellness, ppe, hazardsControls.',
        'rules:',
        '- checklist: short pre-task checks (array of strings).',
        '- dos: EXACTLY 10 short, action-focused items.',
        '- donts: EXACTLY 10 short, action-focused items.',
        '- risks: concise risk cues (array of strings).',
        '- wellness: hydration/fatigue/heat/cold tips (array).',
        '- ppe: exact, task-specific PPE items (array of strings).',
        '- hazardsControls: array of { "hazard": "...", "control": "..." }.',
        'No medical advice. Keep items concise and practical.',
        `If locale != "en", translate items to that locale (e.g., "zu", "af").`
      ].join(' ');
      const user = JSON.stringify({ task, details, locale });

      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      });

      let plan;
      try {
        const raw = completion?.choices?.[0]?.message?.content || '{}';
        plan = normalizePlan(JSON.parse(raw));
      } catch (e) {
        logger.error('plan JSON parse failed; fallback', e?.message);
        plan = offlinePlan(task, details);
      }

      await cacheRef.set({
        key: hash, mode, task, details, locale,
        result: plan,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: false });

      return res.json({ fromCache: false, data: plan });
    } catch (err) {
      logger.error('generateSafetyPlan error', err?.message);
      const mode = asStr(req.body?.mode || 'plan');

      if (mode === 'tips') {
        return res.status(200).json({ fromCache: false, data: { tips: offlineDailyTips() }, fallback: true });
      }
      if (mode === 'chat') {
        return res.status(200).json({
          fromCache: false,
          data: { answer: offlineChatAnswer(asStr(req.body?.question), asStr(req.body?.task)) },
          fallback: true,
        });
      }
      if (mode === 'assessmentDaily') {
        const dateKey = asStr(req.body?.date) || new Date().toISOString().slice(0,10);
        const revealAt = revealAtMsForDate(dateKey);
        const fb = makeStaticDailyAssessmentFallback();
        return res.status(200).json({
          ok: true,
          data: {
            dateKey,
            version: 'v1',
            revealAt,
            questions: fb.questions,
            from: 'fallback',
          },
          fallback: true,
        });
      }
      // plan fallback
      return res.status(200).json({
        fromCache: false,
        data: offlinePlan(asStr(req.body?.task), asStr(req.body?.details)),
        fallback: true
      });
    }
  }
);
