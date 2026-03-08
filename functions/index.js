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
  // ✅ fix: dos uses dosPool, donts uses dontPool
  plan.dos = padToTen(toStrArr(raw?.dos), dosPool);
  plan.donts = padToTen(toStrArr(raw?.donts), dontPool);

  plan.risks = toStrArr(raw?.risks).slice(0, 24);
  plan.wellness = toStrArr(raw?.wellness).slice(0, 24);
  plan.ppe = Array.from(new Set(toStrArr(raw?.ppe))).slice(0, 24);

  // NEW: permits (exact names, short)
  plan.permits = Array.from(new Set(toStrArr(raw?.permits))).slice(0, 12);

  const hc = Array.isArray(raw?.hazardsControls) ? raw.hazardsControls : [];
  plan.hazardsControls = hc
    .map((h) => ({ hazard: asStr(h?.hazard), control: asStr(h?.control) } ))
    .filter((x) => x.hazard && x.control)
    .slice(0, 24);

  return plan;
}

// ---------- offline plan + chat fallbacks ----------
function offlinePlan(task, details) {
  const text = `${task}\n${details}`.toLowerCase();

  const BASE_CHECKS = [
    'Area inspected; hazards removed/barricaded',
    'Tools & equipment inspected (guards/tags/cables)',
    'LOTO/isolations applied and verified where needed',
    'Emergency access clear; first aid & extinguisher available',
    'Good housekeeping — clear walkways, no trip hazards',
    'Communications set (radio channel, spotter, hand signals)',
  ];

  const add = (arr, ...items) => items.forEach((i) => { if (i && !arr.includes(i)) arr.push(i); });
  const hc = (list, hazard, control) => list.push({ hazard, control });

  const dos = [], donts = [], risks = [], wellness = [], ppe = [], hazardsControls = [], permits = [];

  // generic
  add(dos, 'Brief team on roles & signals','Set exclusion zones where needed','Report hazards/near-misses immediately');
  add(donts, 'Bypass guards or PPE','Work alone on high-risk tasks');
  add(risks, 'Pinch points & line-of-fire','Slips/trips on uneven ground');
  add(wellness, 'Hydrate every 30–45 minutes','Take micro-breaks to reset focus');
  add(ppe, 'Hard hat','Safety glasses','Hearing protection (if noisy)','Steel-toe boots','High-vis vest','Work gloves');

  // specific
  if (/(weld|hot work|cut|grind|torch)/.test(text)) {
    add(permits, 'Hot Work');
    add(ppe, 'Welding helmet/filtered visor','Face shield (grinding)','FR long sleeves & pants','Leather welding gloves');
    add(dos, 'Assign fire watch (during + 30 min after job)','Shield sparks; clear flammables ≥10 m');
    add(donts, 'Leave smoldering material unattended');
    add(risks, 'Fire, hot slag, eye injuries');
    hc(hazardsControls, 'Sparks & hot slag', 'Spark containment; remove combustibles; extinguisher within 5 m; fire watch');
  }
  if (/(confined|tank|vessel|manhole|silo)/.test(text)) {
    add(permits, 'Confined Space');
    add(ppe, 'Rescue harness','Gas monitor','Respirator per gas test');
    add(dos, 'Gas test (O₂/LEL/H₂S/CO) & continuous monitoring','Ventilate; standby attendant; rescue plan ready');
    add(donts, 'Enter without permit or rescue plan');
    add(risks, 'Asphyxiation, toxic gases, entrapment');
    hc(hazardsControls, 'Toxic/low oxygen atmosphere', 'Continuous monitoring; forced ventilation; stop if alarm');
  }
  if (/(height|ladder|scaffold|roof|platform)/.test(text)) {
    add(permits, 'Working at Height');
    add(ppe, 'Full-body harness','Double lanyard with shock absorber','Anchorage certified','Non-slip boots');
    add(dos, 'Guardrails/toeboards or fall arrest in place','Ladder secured 1:4; three points of contact');
    add(donts, 'Overreach beyond guardrails','Stand on top two rungs');
    add(risks, 'Falls, dropped objects');
    hc(hazardsControls, 'Fall from height', 'Certified anchor; inspected lanyard; tool lanyards; exclusion zone below');
  }
  if (/(electrical|panel|cable|breaker|live)/.test(text)) {
    add(permits, 'Electrical Work');
    add(ppe, 'Insulated gloves (rated)','Arc-rated face shield/hood','FR clothing','Insulated tools');
    add(dos, 'Isolate & lock/tag; verify absence of voltage','Respect approach boundaries; arc barriers');
    add(donts, 'Assume it is dead — test first');
    add(risks, 'Shock, arc flash, burns');
    hc(hazardsControls, 'Shock/arc flash', 'LOTO; test before touch; barriers; competent person');
  }
  if (/(lift|crane|rig|hoist|forklift|sling)/.test(text)) {
    add(permits, 'Lifting Operations');
    add(ppe, 'Helmet with chin strap','Gloves','High-vis vest','Safety boots');
    add(dos, 'Inspect slings/shackles; verify SWL','Use tag lines; assign spotter/signal person');
    add(donts, 'Stand under suspended loads','Exceed rated capacity');
    add(risks, 'Dropped loads, swing, crush injuries');
    hc(hazardsControls, 'Dropped load', 'Lift plan; clear path; exclusion zone; trained rigger');
  }
  if (/(excavat|trench|dig|pit)/.test(text)) {
    add(permits, 'Excavation/Trenching');
    add(ppe, 'Hi-vis vest','Safety boots');
    add(dos, 'Locate services; shore/slope trenches; ladder every 7.5 m','Keep spoil ≥1 m from edge');
    add(donts, 'Enter unsupported trench >1.2 m');
    add(risks, 'Collapse, engulfment, striking utilities');
    hc(hazardsControls, 'Trench wall collapse', 'Shoring/shielding or slope; inspections after rain');
  }
  if (/(chemic|solvent|acid|paint)/.test(text)) {
    add(permits, 'Chemical Handling');
    add(ppe, 'Chemical-resistant gloves','Goggles + face shield','APR/respirator as required','Chemical apron');
    add(dos, 'Read SDS; provide spill kit & ventilation');
    add(donts, 'Mix incompatible chemicals');
    add(risks, 'Chemical burns, inhalation, reactions');
    hc(hazardsControls, 'Chemical splash/exposure', 'Closed containers; eyewash nearby; fume extraction');
  }
  if (/(drive|truck|haul|traffic|vehicle)/.test(text)) {
    add(ppe, 'Hi-vis vest','Safety boots');
    add(dos, 'Pre-start checks; seatbelt on','Follow site speed; use designated routes');
    add(donts, 'Use phone while driving','Tailgate on haul roads');
    add(risks, 'Collisions, rollovers, pedestrian strikes');
    hc(hazardsControls, 'Pedestrian strike', 'Spotters; horns/lights; one-way systems; designated crossings');
    add(wellness, 'Plan rest >2h driving — fatigue risk');
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
    permits: Array.from(new Set(permits)),
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
  if (plan.permits?.length) bits.push(`Permits:\n- ${plan.permits.slice(0,3).join('\n- ')}`);
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
    // Housekeeping & waste/environment
    'Use the right bin: recycle where available; keep waste off the floor.',
    'Clean as you go — cables coiled, spill kits returned, tools put away.',
    'Report spills immediately and contain safely; protect drains.',
    'Store chemicals in labeled, compatible containers; lids on.',
    // Health & wellness
    'Hydrate every 30–45 minutes; heat and fatigue build quietly.',
    'Stretch before repetitive work; take micro-breaks to reset focus.',
    'Wear hearing protection in noisy areas — tinnitus is permanent.',
    // Respect & behavior
    'Respect colleagues — zero tolerance for bullying and harassment.',
    'Stop work and speak up if something feels unsafe — you’ll be backed.',
    // Core safety practices
    'Keep walkways clear and exits unblocked.',
    'Use spotters and signals around moving equipment.',
    'Lock out, tag out, verify zero energy before maintenance.',
    'Three points of contact on ladders; avoid top two rungs.',
    'Hot work: permit, shields, extinguisher, fire watch.',
    'Know your muster point and emergency routes.',
    'Report hazards and near-misses; learning prevents incidents.',
  ];
  // return first 10 distinct items
  return Array.from(new Set(pool)).slice(0, 10);
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

      // ---------- assessmentDaily ----------
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
          'Provide exactly 10 concise, practical tips with broad variety. Avoid repeating themes in one run.',
          'Cover a spread across: housekeeping, waste & environmental care (e.g., bins/spill control), health & hydration/fatigue, respect/behavior (zero bullying/harassment), emergency readiness, reporting hazards/near-misses, vehicle/traffic, line-of-fire, LOTO/maintenance, PPE selection/use.',
          'Keep each tip short and action-focused.',
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
        'Return ONLY valid JSON with keys: checklist, dos, donts, risks, wellness, ppe, permits, hazardsControls.',
        'Rules:',
        '- checklist: short pre-task checks (array of strings). Keep them concise and task-relevant.',
        '- dos: EXACTLY 10 short, action-focused items.',
        '- donts: EXACTLY 10 short, action-focused items.',
        '- risks: concise risk cues (array of strings).',
        '- wellness: hydration/fatigue/heat/cold tips (array).',
        '- ppe: exact, task-specific PPE items (array of strings). Be explicit (e.g., "Welding helmet/filtered visor", not "correct PPE").',
        '- permits: exact permit names needed (array of short strings), e.g., "Hot Work", "Confined Space", "Working at Height".',
        '- hazardsControls: array of { "hazard": "...", "control": "..." }.',
        'Keep items concise and practical. No medical advice.',
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
