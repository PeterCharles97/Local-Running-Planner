// Planner code map:
// - Constants, dates, and saved state
// - Pace/heart-rate helpers, training phases, and race planning
// - Cycle generation, activity history, and recommendations
// - Startup, rendering, and user interactions
// - Onboarding, offline support, and installation help

// ══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const STORAGE_KEY = 'rolling_training_platform_v1';
const RETENTION_DAYS = 14;

const TAGS = {
  quality:{bg:'var(--co-bg)',tx:'var(--co-tx)',l:'Quality'},
  easy:{bg:'var(--tl-bg)',tx:'var(--tl-tx)',l:'Easy run'},
  long:{bg:'var(--bl-bg)',tx:'var(--bl-tx)',l:'Long run'}
};

// Effort guide is generated from the active cycle's paces rather than a
// static table, so it stays in sync as pacing progresses cycle to cycle.
function effortGuideRows(){
  const cw = findCurrentWeek();
  const paces = safePaces((cw && cw.paces) ? cw.paces : DB.workspace.paces);
  const strideCenter = Math.max(2.4, paces.qualityMin - 0.5);
  return [
    {l:'Easy / Long run', e:paceRangeStr(paces.easyMin,0.25), n:'Fully conversational — no pushing (RPE 4–5)'},
    {l:'Steady / Fartlek', e:paceRangeStr(paces.easyMin-0.4,0.15), n:'Aerobic push, comfortably controlled (RPE 6)'},
    {l:'Quality / Threshold', e:paceRangeStr(paces.qualityMin,0.083), n:'Controlled hard, sustainable for the set duration (RPE 7–8)'},
    {l:'Strides', e:decToClock(roundPace(strideCenter))+'/km ish', n:'Short and relaxed, 20–30 sec bursts only (RPE 8–9)'}
  ];
}

const STATUS_OPTIONS = [
  {v:'healthy', l:'Healthy'},
  {v:'sick', l:'Sick'},
  {v:'returning', l:'Returning'},
  {v:'injured', l:'Injured / sensitive'},
  {v:'fatigued', l:'Fatigued'}
];

// Optional weekly wellbeing symptoms (opt-in). Any flagged symptom holds
// progression for that week — never blocks training, just doesn't pile load on.
const SYMPTOM_OPTIONS = [
  {v:'rough', l:'Feeling rough'},
  {v:'poorSleep', l:'Poor sleep'},
  {v:'lowEnergy', l:'Low energy'},
  {v:'cramps', l:'Cramps / aches'}
];

// ══════════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ══════════════════════════════════════════════════════════════════════════
// Format a Date as YYYY-MM-DD using the LOCAL calendar date. Using
// toISOString() here would convert to UTC and can land on the wrong day for
// users ahead of UTC (e.g. Australia) once local time passes the UTC rollover.
function isoDate(d){
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth()+1).padStart(2,'0');
  const day = String(x.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
// Parse a stored "YYYY-MM-DD" string as LOCAL midnight. Plain new Date("YYYY-MM-DD")
// parses as UTC midnight, which shifts to the previous/next local day in non-UTC
// timezones and misaligns the calendar. Always parse stored dates through here.
function parseDate(s){
  if(s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const [y,m,d] = String(s).split('-').map(Number);
  return new Date(y, (m||1)-1, d||1);
}
function addDays(d,n){ const r=new Date(d); r.setDate(r.getDate()+n); return r; }
function mondayOf(d){ const x=new Date(d); const wd=(x.getDay()+6)%7; x.setDate(x.getDate()-wd); x.setHours(0,0,0,0); return x; }
function round1(n){ return Math.round(n*10)/10; }
function round2(n){ return Math.round(n*100)/100; }
function fmtRange(startIso,endIso){
  const s=parseDate(startIso), e=parseDate(endIso);
  const opt={month:'short',day:'numeric'};
  const sStr=s.toLocaleDateString('en-US',opt), eStr=e.toLocaleDateString('en-US',opt);
  return sStr+' – '+eStr;
}

// ══════════════════════════════════════════════════════════════════════════
// DATA MODEL / DEFAULT STATE
// ── Separated concerns: workspace settings, generated weeks, templates are
// produced procedurally (not hardcoded arrays), rolling adaptation summary,
// temporary linked results, and planner status all live in their own slice.
// ══════════════════════════════════════════════════════════════════════════
function defaultDB(){
  return {
    workspace: {
      name: 'Athlete',
      goal: '5k base build',
      frequency: 4,
      preferredDays: ['Tue','Thu','Sat','Sun'],
      longRunDay: 'Sun',
      conservatism: 'standard',        // standard | conservative
      returnToRunMode: false,          // injury sensitivity
      focus: 'balanced',               // distance | speed | balanced — biases how "progress" cycles split volume vs pace
      phase: 'build',                  // base | build | maintenance | raceprep | return — shapes progression rules while keeping 3:1
      otherSportLoad: 'light',         // light | moderate | heavy — bike/swim/gym load this cycle; dampens run progression
      status: 'healthy',               // healthy | sick | returning | injured | fatigued
      baselines: { longKm: 8, qualityKm: 5, easyKm: 4 },
      paces: { easyMin: 6.0, qualityMin: 5.0, longMin: 6.0 }, // minutes per km, decimal (5.5 = 5:30/km)
      hr: { maxHr: null, restHr: null, customZones: null },   // customZones: [z1max,z2max,z3max,z4max] bpm, or null to derive via HR reserve
      trackSymptoms: false,            // opt-in weekly wellbeing check (off by default)
      symptomWeek: null,               // ISO Monday of the week the current symptoms apply to
      symptoms: [],                    // e.g. ['rough','poorSleep','lowEnergy','cramps'] for symptomWeek
      qualityRotation: {},             // per-phase index into that phase's quality pool, advances each generated cycle
      raceDate: null,                  // ISO date of target race, or null
      raceDist: null,                  // '5k'|'10k'|'half'|'marathon'|'ultra'|'tri'|'custom'
      raceGoal: null,                  // 'finish' | 'time'
      raceTargetTime: null,            // target finish time in minutes (decimal), when raceGoal==='time'
      raceCustomKm: null               // number, when raceDist==='custom'
    },
    cycles: [],   // {number, mode, baselines, paces, createdAt}
    weeks: [],    // generated week objects (see generateCycle)
    extras: [],   // user-added non-running workouts {id, weekId, day, type, notes, done}
    overrides: { days:{}, done:{}, notes:{} },  // per-session-id day move / completion / note overrides
    results: [],  // temporary linked/unlinked completed-activity results (Garmin scaffold)
    rolling: {
      completionRate: null,
      keySessionsCompletedLastCycle: null,
      lastLongRunKm: null,
      lastQualityType: null,
      deloadRecommended: false,
      disruption: false,
      stableReturnWeeksCompleted: 0,
      recentQualityPaceDeltaMin: null, // avg (actual - target) min/km across logged quality sessions; negative = ran faster than target
      recentSessionsCutShort: 0,       // count of logged sessions markedly shorter than planned despite being marked done
      recentStrainHigh: false,         // logged RPE / "rough" feel / HR-over-zone suggest the athlete is over-reaching
      // Block history: one compact summary per finalized week, so next-block
      // decisions consider the WHOLE block rather than only the last week.
      // Pruned to the last 6 entries. { cycleNumber, weekIndex, type, rate, keyDone, qualityPaceDeltaMin, cutShort, strain }
      weekHistory: []
    },
    meta: { lastPruneAt: null, onboarded: false, prevStatus: null, prevStableReturnWeeks: null, pendingSettingNote: null, datesRealigned: true, installPromptSeen: false }
  };
}

let DB = null;

function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    DB = raw ? JSON.parse(raw) : defaultDB();
  } catch(e){ DB = defaultDB(); }
  // shallow-fill any missing slices (forward compatible with older saves)
  const d = defaultDB();
  for(const k in d) if(!(k in DB)) DB[k] = d[k];
  for(const k in d.workspace) if(!(k in DB.workspace)) DB.workspace[k] = d.workspace[k];
  if(!DB.workspace.paces) DB.workspace.paces = { ...d.workspace.paces };
  for(const k in d.workspace.paces) if(!(k in DB.workspace.paces)) DB.workspace.paces[k] = d.workspace.paces[k];
  if(!DB.workspace.baselines) DB.workspace.baselines = { ...d.workspace.baselines };
  for(const k in d.workspace.baselines) if(!(k in DB.workspace.baselines)) DB.workspace.baselines[k] = d.workspace.baselines[k];
  if(!DB.workspace.hr) DB.workspace.hr = d.workspace.hr;
  for(const k in d.workspace.hr) if(!(k in DB.workspace.hr)) DB.workspace.hr[k] = d.workspace.hr[k];
  for(const k in d.rolling) if(!(k in DB.rolling)) DB.rolling[k] = d.rolling[k];
  // A save that predates the date-realignment flag needs the one-time migration.
  // Mark it as not-yet-realigned BEFORE the generic meta fill would default it to true.
  if(DB.meta && !('datesRealigned' in DB.meta)) DB.meta.datesRealigned = false;
  for(const k in d.meta) if(!(k in DB.meta)) DB.meta[k] = d.meta[k];

  // Heal older saved data: weeks and cycles created before pacing existed have
  // no `paces`. Backfill them so rendering and rebuilds never hit undefined.
  migrateLegacyData();
}

// Backfills missing paces on stored cycles and weeks (and other post-v1 fields
// the session builders now expect). Safe to run every load.
function migrateLegacyData(){
  const wsPaces = safePaces(DB.workspace.paces);
  (DB.cycles || []).forEach(c=>{
    if(!c.paces) c.paces = { ...wsPaces };
    else c.paces = safePaces(c.paces);
    if(!c.baselines) c.baselines = safeBaselines(DB.workspace.baselines);
  });
  (DB.weeks || []).forEach(w=>{
    if(!w.paces){
      const cyc = (DB.cycles || []).find(c=>c.number===w.cycleNumber);
      w.paces = safePaces(cyc ? cyc.paces : DB.workspace.paces);
    } else {
      w.paces = safePaces(w.paces);
    }
    // Older sessions may lack numeric pace targets used by activity linking.
    (w.sessions || []).forEach(s=>{
      if(s.paceTargetMin == null){
        s.paceTargetMin = s.role==='quality'
          ? (w.type==='build' ? w.paces.qualityMin : w.paces.easyMin)
          : (s.role==='long' ? w.paces.longMin : w.paces.easyMin);
      }
    });
  });

  // One-time date realignment. Weeks generated by an earlier build used a
  // UTC-based date formatter, so stored startDates can be off by a day in
  // non-UTC timezones (e.g. Australia), which shifts the whole calendar and the
  // "today" highlight. Snap every week to its correct LOCAL Monday, preserving
  // ordering. Runs once; a flag prevents re-running.
  if(!DB.meta.datesRealigned && (DB.weeks || []).length){
    // Snap each stored start to the NEAREST Monday (may round up or down).
    // A date shifted to the preceding Sunday must round FORWARD to Monday, so
    // rounding to nearest (not the preceding Monday) is required here.
    const nearestMonday = (d) => {
      const base = mondayOf(d);              // Monday on/before d (local)
      const diff = (d - base) / 86400000;    // 0..6 days after that Monday
      return diff >= 4 ? addDays(base, 7) : base; // >=Fri rounds up to next Monday
    };
    DB.weeks.forEach(w=>{
      const aligned = nearestMonday(parseDate(w.startDate));
      w.startDate = isoDate(aligned);
      w.endDate = isoDate(addDays(aligned, 6));
    });
    DB.meta.datesRealigned = true;
  }
}
let storageWorks = true;
function save(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
    // Verify it actually persisted (some in-app browsers silently no-op).
    if(localStorage.getItem(STORAGE_KEY)==null) storageWorks = false;
  }catch(e){ storageWorks = false; }
}
function checkStorage(){
  try{
    const k='__rtp_test__';
    localStorage.setItem(k,'1');
    const ok = localStorage.getItem(k)==='1';
    localStorage.removeItem(k);
    return ok;
  }catch(e){ return false; }
}

function getDay(id,def){ return DB.overrides.days[id] || def; }
function getDone(id){ return !!DB.overrides.done[id]; }
function setDone(id,val){ DB.overrides.done[id] = val; }

// ══════════════════════════════════════════════════════════════════════════
// PLAN GENERATION — reusable rolling 4-week cycles (3 build + 1 deload)
// Structured so other block types (taper / race / maintenance / recovery)
// slot in as additional entries in `types` below.
// ══════════════════════════════════════════════════════════════════════════
function roundKm(n){ return Math.max(1, Math.round(n)); } // nearest whole km, min 1
function buildWeekDistance(peak, weekIdx){
  const factor = [0.85, 0.93, 1.0][weekIdx] ?? 1.0;
  return roundKm(peak*factor);
}
function weekDistancesFor(baselines, type){
  if(type==='deload')   return { long: roundKm(baselines.longKm*0.55), quality: roundKm(baselines.qualityKm*0.6), easy: roundKm(baselines.easyKm*0.7) };
  if(type==='recovery') return { long: roundKm(baselines.longKm*0.5),  quality: roundKm(baselines.qualityKm*0.5), easy: roundKm(baselines.easyKm*0.6) };
  return null;
}

// ── Pacing ────────────────────────────────────────────────────────────────
// Paces are stored as decimal minutes/km (5.75 = 5:45/km) so they're easy to
// do arithmetic on, and only converted to "m:ss/km" strings for display.
function roundPace(m){ return Math.round(m*12)/12; } // nearest 5 seconds
function decToClock(m){ const mi=Math.floor(m); const s=Math.round((m-mi)*60); return mi+':'+String(s).padStart(2,'0'); }
function clockToDec(str){
  const parts = String(str).trim().split(':').map(Number);
  if(parts.length!==2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] + parts[1]/60;
}
function paceRangeStr(centerMin, spreadMin){
  const lo = roundPace(centerMin - spreadMin), hi = roundPace(centerMin + spreadMin);
  return decToClock(lo)+'–'+decToClock(hi)+'/km';
}

// ── Heart rate zones ────────────────────────────────────────────────────────
// If the athlete gives custom zones we use them; otherwise zones are derived
// from heart-rate reserve (Karvonen): zoneBpm = restHr + pct*(maxHr - restHr).
// Standard 5-zone split by %HRR: Z1<60, Z2 60–70, Z3 70–80, Z4 80–90, Z5 90+.
const HRR_ZONE_TOPS = [0.60, 0.70, 0.80, 0.90]; // upper bound of Z1..Z4; Z5 is above
function hrZones(hr){
  if(!hr) return null;
  if(Array.isArray(hr.customZones) && hr.customZones.length===4) return hr.customZones.map(Math.round);
  if(!hr.maxHr || !hr.restHr || hr.maxHr<=hr.restHr) return null;
  const reserve = hr.maxHr - hr.restHr;
  return HRR_ZONE_TOPS.map(p => Math.round(hr.restHr + p*reserve));
}
// Returns 1..5 for a given avg-HR reading, or null if zones unknown.
function hrZoneOf(bpm, hr){
  const zones = hrZones(hr);
  if(!zones || !bpm) return null;
  for(let i=0;i<zones.length;i++) if(bpm <= zones[i]) return i+1;
  return 5;
}
// The intended zone for each session role (what the effort *should* sit in).
function intendedZone(role){ return role==='quality' ? 4 : 2; }

// Cycle-to-cycle pace progression — same rule-based approach as distance:
// progress tightens (faster) quality pace a little, reduce/recovery relax it.
// When real logged quality-session paces are available (paceDeltaMin), they
// nudge the step size within safe bounds — consistently beating target pace
// pushes the next step a bit further; consistently missing it pulls back.
function nextPaces(current, mode, conservative, paceDeltaMin, focus){
  const c = { ...current };
  const baseStep = conservative ? 0.05 : 0.1; // minutes/km per cycle
  const phase = currentPhase();
  focus = phase.focusBias || focus || 'balanced';
  if(mode==='progress'){
    let step = baseStep;
    if(paceDeltaMin!=null){
      const adjust = Math.max(-0.05, Math.min(0.08, -paceDeltaMin*0.3));
      step = Math.max(0.03, baseStep + adjust);
    }
    // Speed focus pushes pace harder; distance focus eases off pace to prioritise volume.
    const focusMult = focus==='speed' ? 1.6 : focus==='distance' ? 0.5 : 1.0;
    // Phase pace-emphasis + other-sport dampening scale the pace step too.
    step = step * focusMult * phase.paceEmphasis * otherSportGrowthFactor();
    c.qualityMin = current.qualityMin - step;
    c.easyMin = current.easyMin - step*0.3;
    // In base/distance-led phases, let long-run pace drift slightly easier than
    // easy pace over time (long runs get longer, so a touch more relaxed).
    if(phase.focusBias==='distance') c.longMin = roundPace((current.longMin||current.easyMin) + 0.02);
  }
  else if(mode==='reduce'){ c.qualityMin = current.qualityMin + baseStep; }
  else if(mode==='recovery'){ c.qualityMin = current.qualityMin + baseStep*1.5; c.easyMin = current.easyMin + baseStep*0.5; }
  // 'hold' / 'forceDeload' → unchanged
  c.qualityMin = roundPace(Math.max(2.5, c.qualityMin));
  c.easyMin = roundPace(Math.max(c.qualityMin+0.4, c.easyMin));
  // long pace tracks easy unless we nudged it above; keep it within a sane band
  if(c.longMin==null) c.longMin = c.easyMin;
  c.longMin = roundPace(Math.max(c.easyMin, Math.min(c.longMin, c.easyMin+0.3)));
  return c;
}

function makeLongSession(week, day){
  const dist = week.dist.long;
  const paceStr = paceRangeStr(week.paces.longMin, 0.25);
  return {
    id: week.id+'_long', role:'long', day, def:day,
    title:'Long run', shortDesc: dist+' km · '+paceStr,
    warmup:null, main: dist+' km continuous at an easy, conversational effort.', cooldown:null,
    targetDistanceKm: dist, targetDurationMin:null, targetPace: paceStr, paceTargetMin: week.paces.longMin,
    effortNote:'Fully conversational — no pushing. Target '+paceStr+'.',
    cautionNote: week.type==='deload' ? 'Deload week — this consolidates the last block\'s adaptations.' :
                 week.type==='recovery' ? 'Re-entry week — distance is intentionally reduced. Stop early if anything feels off.' : '',
    priority:'key',
    reducedVersion: dist>4 ? Math.max(3,round1(dist*0.6))+' km if legs feel flat' : null
  };
}
// ── Quality session library ────────────────────────────────────────────────
// Each template develops a specific quality (system), and takes the week index
// (0..2 within a build cycle) so reps/duration still progress across the three
// build weeks. Phases draw from different pools so base/build/race-prep feel
// genuinely distinct, and a deterministic per-cycle rotation stops consecutive
// cycles repeating — varied but predictable and reviewable.
const QUALITY_LIBRARY = {
  fartlek: { label:'Fartlek', system:'aerobic power',
    build:(i,q,e)=>[`Fartlek: 6×1 min at ${q} / 1 min easy (${e}).`,`Fartlek: 5×2 min at ${q} / 90 sec easy.`,`Fartlek: 4×3 min at ${q} / 2 min easy.`][i] },
  threshold: { label:'Threshold', system:'lactate threshold',
    build:(i,q,e)=>[`Threshold: 2×6 min at ${q} / 90 sec easy (${e}).`,`Threshold: 2×8 min at ${q} / 2 min easy.`,`Threshold: 3×8 min at ${q} / 2 min easy.`][i] },
  cruise: { label:'Cruise intervals', system:'threshold-repeat',
    build:(i,q,e)=>[`Cruise intervals: 4×1 km at ${q} / 1 min easy (${e}).`,`Cruise intervals: 5×1 km at ${q} / 1 min easy.`,`Cruise intervals: 4×1.5 km at ${q} / 90 sec easy.`][i] },
  vo2: { label:'VO2 intervals', system:'VO2 max',
    build:(i,q,e)=>[`VO2: 6×400 m hard (${q}) / 400 m easy jog (${e}).`,`VO2: 5×800 m hard / 400 m easy jog.`,`VO2: 6×800 m hard / 400 m easy jog.`][i] },
  hills: { label:'Hill reps', system:'strength & power',
    build:(i,q,e)=>[`Hills: 8×45 sec uphill hard, jog-down recovery. Controlled form.`,`Hills: 10×45 sec uphill hard, jog-down recovery.`,`Hills: 8×60 sec uphill hard, jog-down recovery.`][i] },
  sustained: { label:'Sustained tempo', system:'tempo endurance',
    build:(i,q,e)=>[`Tempo: 12 min continuous at ${q}.`,`Tempo: 16 min continuous at ${q}.`,`Tempo: 20 min continuous at ${q}.`][i] },
  race: { label:'Race-pace reps', system:'race-specific',
    build:(i,q,e)=>[`Race-pace: 4×1 km at goal pace (${q}) / 90 sec easy (${e}).`,`Race-pace: 3×2 km at goal pace / 2 min easy.`,`Race-pace: 5×1 km at goal pace / 60 sec easy.`][i] },
  strides: { label:'Strides & steady', system:'neuromuscular / aerobic',
    build:(i,q,e)=>[`Steady running (${e}) with 6×20 sec relaxed strides woven in.`,`Steady running with 8×20 sec relaxed strides.`,`Steady running with 8×25 sec relaxed strides.`][i] }
};
// Which templates each phase rotates through (in order).
// Base: aerobic & controlled, tempo de-emphasised so it stays distinct from build.
// Build: the broadest working pool. Race-prep: race-pace led, VO2 as selective sharpener.
const PHASE_QUALITY_POOLS = {
  base:        ['fartlek','hills','strides','sustained'],
  build:       ['threshold','cruise','fartlek','vo2','hills','sustained'],
  raceprep:    ['race','cruise','vo2'],
  maintenance: ['sustained','fartlek'],
  return:      ['strides','fartlek'],
  deload:      ['strides'],
  recovery:    ['strides']
};
// Deterministic pick using a stored per-phase rotation index (advances each
// generated cycle). Cycle-level real-life flags — heavy cross-training load —
// bake a gentler substitute at generation time. Transient day-to-day flags
// (status changes, weekly symptoms) are handled live by sessionAdjustment()
// so they can soften the current week without being frozen into future weeks.
function softSubstituteReason(week){
  if(week.type==='deload' || week.type==='recovery') return null; // handled separately in maker
  if(DB.workspace.otherSportLoad==='heavy') return 'cross-training';
  return null;
}
// Resolve the quality pool for a phase. In race-prep with a race set, the pool
// becomes event-specific (5k=sharp, marathon=long race-pace), and the goal
// shifts emphasis: "just finish" favours durability, "target time" favours the
// sharper/race-pace end.
function qualityPoolFor(phaseKey){
  if(phaseKey==='raceprep'){
    const race = currentRace();
    if(race && race.prep && race.prep.length){
      let pool = race.prep.slice();
      if(DB.workspace.raceGoal==='finish'){
        // durability bias: drop the sharpest (vo2) if a gentler option exists
        const gentler = pool.filter(t=>t!=='vo2');
        if(gentler.length) pool = gentler;
      } else if(DB.workspace.raceGoal==='time'){
        // sharpening bias: lead with race/vo2 if present
        pool = pool.slice().sort((a,b)=>{
          const rank = t => (t==='race'?0 : t==='vo2'?1 : 2);
          return rank(a)-rank(b);
        });
      }
      return pool;
    }
  }
  return PHASE_QUALITY_POOLS[phaseKey] || PHASE_QUALITY_POOLS.build;
}
function pickQualityTemplate(phaseKey){
  const pool = qualityPoolFor(phaseKey);
  const rot = (DB.workspace.qualityRotation && DB.workspace.qualityRotation[phaseKey]) || 0;
  const idx = ((rot % pool.length) + pool.length) % pool.length;
  return QUALITY_LIBRARY[pool[idx]];
}
// Advance the rotation for a phase — called once per generated cycle so the
// NEXT cycle in that phase lands on a different workout.
function advanceQualityRotation(phaseKey){
  if(!DB.workspace.qualityRotation) DB.workspace.qualityRotation = {};
  const pool = qualityPoolFor(phaseKey);
  const cur = DB.workspace.qualityRotation[phaseKey] || 0;
  DB.workspace.qualityRotation[phaseKey] = (cur + 1) % pool.length;
}

function makeQualitySession(week, day){
  const dist = week.dist.quality;
  const qPace = paceRangeStr(week.paces.qualityMin, 0.083);
  const ePace = paceRangeStr(week.paces.easyMin, 0.25);
  let title, main, tmplLabel = null;
  const softReason = softSubstituteReason(week);
  if(week.type==='deload'){ title='Quality — strides only'; main='Easy running ('+ePace+') with 6×20 sec relaxed strides woven in. No sustained effort.'; }
  else if(week.type==='recovery'){ title='Quality — light strides'; main='Very easy running ('+ePace+') with a few gentle strides only if it feels good. Skip entirely if not.'; }
  else if(softReason){
    // Cycle-level flag (heavy cross-training): bake a gentler substitute.
    tmplLabel = 'Strides & steady';
    title = 'Quality — eased';
    main = `Easy running (${ePace}) with a few relaxed strides only if it feels good — cross-training is heavy this cycle, so keep running easy. Skip the hard session.`;
  }
  else {
    const phaseKey = (DB.workspace && DB.workspace.phase) ? DB.workspace.phase : 'build';
    const tmpl = pickQualityTemplate(phaseKey);
    tmplLabel = tmpl.label;
    title = 'Quality — ' + tmpl.label;
    main = `Warm-up easy (${ePace}), then ${tmpl.build(Math.min(week.cycleWeekIndex,2), qPace, ePace)} Cool-down easy.`;
  }
  const eased = !!softReason && week.type!=='deload' && week.type!=='recovery';
  return {
    id: week.id+'_qual', role:'quality', day, def:day,
    title, shortDesc: dist+' km · '+ ((week.type==='build' && !eased) ? qPace : ePace),
    warmup:'~1 km easy', main, cooldown:'~1 km easy', qualityType: tmplLabel,
    targetDistanceKm: dist, targetDurationMin:null, targetPace: (week.type==='build' && !eased) ? qPace : ePace,
    paceTargetMin: (week.type==='build' && !eased) ? week.paces.qualityMin : week.paces.easyMin,
    effortNote: (week.type==='build' && !eased) ? 'Controlled, not desperate. Target '+qPace+' for the hard portions.' : 'Relaxed — this is not a hard session.',
    cautionNote:'Keep 48–72 hrs clear of heavy strength work before this session.',
    priority:'key',
    reducedVersion:'Strides-only easy version if fatigued or sore'
  };
}
function makeEasySession(week, day, idx){
  const dist = Math.max(2, round1(week.dist.easy - idx*0.5));
  const paceStr = paceRangeStr(week.paces.easyMin, 0.25);
  return {
    id: week.id+'_easy'+idx, role:'easy', day, def:day,
    title:'Easy run', shortDesc: dist+' km · '+paceStr,
    warmup:null, main: dist+' km at an easy, relaxed pace.', cooldown:null,
    targetDistanceKm: dist, targetDurationMin:null, targetPace: paceStr, paceTargetMin: week.paces.easyMin,
    effortNote:'Conversational throughout. Target '+paceStr+'.', cautionNote:'',
    priority:'optional', reducedVersion:null
  };
}
function buildWeekSessions(week, ws){
  const freq = Math.max(1, ws.frequency || 1);
  // 1 run/week: a single session — the long run on the chosen day, which for a
  // build week carries a light quality flavour so the one run still develops fitness.
  if(freq === 1){
    const day = ws.longRunDay || (ws.preferredDays && ws.preferredDays[0]) || 'Sat';
    return [ makeLongSession(week, day) ];
  }
  const dayCount = Math.max(2, Math.min(freq, ws.preferredDays.length || 2));
  let days = ws.preferredDays.slice(0, dayCount);
  if(days.length===0) days = ['Tue','Thu','Sun'];
  if(!days.includes(ws.longRunDay)) days[days.length-1] = ws.longRunDay;
  days = Array.from(new Set(days));
  const others = days.filter(d=>d!==ws.longRunDay);
  const qualityDay = week.type==='recovery' ? null : others[0];
  const easyDays = others.filter(d=>d!==qualityDay);

  const sessions = [ makeLongSession(week, ws.longRunDay) ];
  if(qualityDay) sessions.push(makeQualitySession(week, qualityDay));
  easyDays.forEach((d,i)=> sessions.push(makeEasySession(week, d, i)));
  return sessions;
}

function escapeManualText(value){
  return String(value).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[ch]);
}
function manualRunsForWeek(weekPlan,plan){
  const priorRuns = Array.isArray(weekPlan.runs) ? weekPlan.runs : [];
  const qualityPace = paceRangeStr(safePaces(DB.workspace.paces).qualityMin,0.083);
  return plan.days.map((day,index)=>{
    const role = day===plan.longRunDay ? 'long' : day===plan.qualityDay ? 'quality' : 'easy';
    const prior = priorRuns.find(run=>run.day===day);
    if(plan.preserveRoles && !prior) return null;
    const resolvedRole = plan.preserveRoles && prior ? prior.role : role;
    const legacyDistance = resolvedRole==='long' ? weekPlan.longKm
      : resolvedRole==='quality' ? weekPlan.qualityKm : weekPlan.easyKm;
    return {
      ...prior, day, role:resolvedRole,
      distanceKm:prior ? prior.distanceKm : legacyDistance,
      details:prior ? (prior.details || '') : resolvedRole==='long'
        ? (weekPlan.longDescription || plan.longDescription || 'Comfortable, conversational effort.')
        : resolvedRole==='easy' ? (weekPlan.easyDescription || plan.easyDescription || 'Relaxed effort; finish feeling fresh.') : '',
      workoutType:prior ? (prior.workoutType || 'Intervals') : 'Intervals',
      intervalStructure:prior ? (prior.intervalStructure || weekPlan.qualityDescription || '')
        : weekPlan.qualityDescription || (index===3
          ? 'Easy running with a few relaxed strides only.'
          : 'Controlled quality work; keep the hard portions sustainable.'),
      targetPace:prior ? (prior.targetPace || qualityPace) : qualityPace
    };
  }).filter(Boolean);
}
function summarizeManualRuns(runs){
  const totalFor = role=>round1(runs.filter(run=>run.role===role)
    .reduce((total,run)=>total+(parseFloat(run.distanceKm)||0),0));
  const easyRuns = runs.filter(run=>run.role==='easy');
  return {
    longKm:totalFor('long'),
    qualityKm:totalFor('quality'),
    easyKm:easyRuns.length
      ? round1(easyRuns.reduce((total,run)=>total+(parseFloat(run.distanceKm)||0),0)/easyRuns.length)
      : 0
  };
}
function parseManualPace(value,fallback){
  const paceText = String(value).trim();
  const clockPaces = Array.from(paceText.matchAll(/(\d{1,2}):([0-5]\d)/g))
    .map(match=>Number(match[1])+Number(match[2])/60);
  if(clockPaces.length) return clockPaces.reduce((sum,pace)=>sum+pace,0)/clockPaces.length;
  const decimalPaces = Array.from(paceText.matchAll(/(?:^|[^\d])(\d+(?:\.\d+)?)(?=$|[^\d])/g))
    .map(match=>Number(match[1])).filter(pace=>pace>0&&pace<30);
  return decimalPaces.length
    ? decimalPaces.reduce((sum,pace)=>sum+pace,0)/decimalPaces.length
    : fallback;
}
function buildManualWeekSessions(week, plan, weekPlan){
  return manualRunsForWeek(weekPlan,plan).map((run,index)=>{
    const distance = round1(parseFloat(run.distanceKm)||0);
    let session;
    if(run.role==='long'){
      session = makeLongSession(week,run.day);
      session.title = 'Long run';
      session.shortDesc = `${distance} km`;
      session.main = `${distance} km. ${escapeManualText(run.details)}`;
      session.effortNote = '';
    } else if(run.role==='quality'){
      const pace = run.targetPace.trim() || paceRangeStr(week.paces.qualityMin,0.083);
      session = makeQualitySession(week,run.day);
      session.title = 'Quality run';
      session.shortDesc = `${distance} km · ${escapeManualText(pace)}`;
      session.main = `${distance} km. ${escapeManualText(run.workoutType)}: ${escapeManualText(run.intervalStructure)}. Target pace: ${escapeManualText(pace)}.`;
      session.qualityType = escapeManualText(run.workoutType);
      session.targetPace = escapeManualText(pace);
      session.paceTargetMin = parseManualPace(pace,week.paces.qualityMin);
      session.cautionNote = 'Keep 48–72 hrs clear of heavy strength work before this session.';
    } else {
      session = makeEasySession(week,run.day,index);
      session.title = 'Easy run';
      session.shortDesc = `${distance} km · ${paceRangeStr(week.paces.easyMin,0.25)}`;
      session.main = `${distance} km. ${escapeManualText(run.details)}`;
      session.effortNote = '';
    }
    session.id = run.sessionId || `${week.id}_${run.role}_${index}`;
    session.day = run.day;
    session.def = run.day;
    session.targetDistanceKm = distance;
    session.priority = run.role==='quality' ? 'key' : 'optional';
    return session;
  });
}

function weekVolume(week){
  const longTotal = week.sessions.filter(s=>s.role==='long').reduce((a,s)=>a+s.targetDistanceKm,0);
  const qualityTotal = week.sessions.filter(s=>s.role==='quality').reduce((a,s)=>a+s.targetDistanceKm,0);
  const easyTotal = week.sessions.filter(s=>s.role==='easy').reduce((a,s)=>a+s.targetDistanceKm,0);
  const total = round1(longTotal + qualityTotal + easyTotal);
  return { tot: total+' km', q: round1(qualityTotal)+' km', lr: round1(longTotal)+' km' };
}

// ── Day-one calibration ──────────────────────────────────────────────────
// Instead of launching every athlete on flat generic baselines, an intake
// step converts a few real recent-training answers into starting numbers.
const EXPERIENCE_PRESETS = {
  new:        { label:'New to running',             conservatism:'conservative', returnToRunMode:false, status:'healthy',   longFactor:0.80, qualFactor:0.85, paceOffset:0.7 },
  consistent: { label:'Consistent base already',     conservatism:'standard',     returnToRunMode:false, status:'healthy',   longFactor:0.90, qualFactor:0.95, paceOffset:1.0 },
  break:      { label:'Returning after a break',     conservatism:'conservative', returnToRunMode:false, status:'returning', longFactor:0.75, qualFactor:0.80, paceOffset:0.75 },
  injury:     { label:'Returning from injury',       conservatism:'conservative', returnToRunMode:true,  status:'injured',   longFactor:0.65, qualFactor:0.70, paceOffset:0.6 }
};
// Baselines are deliberately set a little below what was actually just done —
// leaves room for the first cycle to build rather than starting at a ceiling.
function computeIntakeBaselines(presetKey, longestRunKm, typicalEasyKm, hardEffortKm){
  const p = EXPERIENCE_PRESETS[presetKey] || EXPERIENCE_PRESETS.consistent;
  const longKm = round1(Math.max(2, (longestRunKm||typicalEasyKm||5) * p.longFactor));
  const easyKm = round1(Math.max(2, typicalEasyKm||4));
  const effortAnchor = (hardEffortKm && hardEffortKm>0) ? Math.min(hardEffortKm, easyKm*1.2) : easyKm;
  const qualityKm = round1(Math.max(2, effortAnchor * p.qualFactor));
  return { longKm, qualityKm, easyKm };
}
// If the athlete gives a known weekly volume, scale session baselines so a
// typical build week's total lands near that number — matching real load
// rather than a total inferred from piecemeal session distances.
function scaleBaselinesToVolume(baselines, targetWeeklyKm, frequency){
  if(!targetWeeklyKm || targetWeeklyKm<=0) return baselines;
  const easyRuns = Math.max(1, frequency - 2); // long + quality + rest easy
  const impliedTotal = baselines.longKm + baselines.qualityKm + easyRuns*baselines.easyKm;
  if(impliedTotal<=0) return baselines;
  const factor = targetWeeklyKm / impliedTotal;
  return {
    longKm: round1(Math.min(baselines.longKm*factor, targetWeeklyKm*0.45)), // long can't swallow the week
    qualityKm: round1(baselines.qualityKm*factor),
    easyKm: round1(baselines.easyKm*factor)
  };
}
// Convert a recent race (distance + time) into an estimated quality/threshold
// pace. Quality sits a touch slower than all-out race pace, so add a margin.
function raceToQualityPaceMin(raceKm, raceTimeMin){
  if(!raceKm || raceKm<=0 || !raceTimeMin || raceTimeMin<=0) return null;
  return roundPace(raceTimeMin/raceKm + 0.15); // ~9 sec/km easier than race pace
}
// If a quality/threshold pace isn't given directly, estimate it as a preset-
// based offset from easy pace — a rough starting point, editable any time.
function computeIntakePaces(presetKey, easyPaceMin, qualityPaceMin){
  const p = EXPERIENCE_PRESETS[presetKey] || EXPERIENCE_PRESETS.consistent;
  const easyMin = roundPace(easyPaceMin || DB.workspace.paces.easyMin);
  const qualityMin = roundPace(qualityPaceMin && qualityPaceMin>0 ? qualityPaceMin : Math.max(2.5, easyMin - p.paceOffset));
  return { easyMin, qualityMin, longMin: easyMin };
}
function fitPreferredDaysToFrequency(days, freq, longRunDay){
  let d = [...days];
  if(!d.includes(longRunDay)) d.push(longRunDay);
  if(d.length > freq){
    d = d.filter(x=>x!==longRunDay).slice(0, Math.max(0,freq-1));
    d.push(longRunDay);
  } else if(d.length < freq){
    const remaining = DAYS.filter(x=>!d.includes(x));
    while(d.length<freq && remaining.length) d.push(remaining.shift());
  }
  return Array.from(new Set(d));
}

// `focus` biases how a "progress" cycle grows: 'distance' pushes volume,
// 'speed' trims volume slightly so harder quality can be absorbed safely,
// 'balanced' does a bit of both. Only affects the 'progress' mode.
// ── Phase modes ─────────────────────────────────────────────────────────────
// Phases keep the 3:1 rhythm but reshape HOW progression happens. Each defines
// a growth multiplier (applied to distance/pace steps), whether progression is
// allowed at all, and a preferred focus bias. Transparent + rule-based.
const PHASES = {
  base:        { label:'Base',        growth:0.7, allowProgress:true,  focusBias:'distance', paceEmphasis:0.5,
                 note:'Aerobic base — steady volume, gentle pace. Long/easy running prioritised over hard speed.' },
  build:       { label:'Build',       growth:1.0, allowProgress:true,  focusBias:null,       paceEmphasis:1.0,
                 note:'Standard build — distance and pace progress together per your focus setting.' },
  maintenance: { label:'Maintenance', growth:0.0, allowProgress:false, focusBias:null,       paceEmphasis:0.0,
                 note:'Holding fitness — load stays flat, no progression. Good for travel or unstable routines.' },
  raceprep:    { label:'Race prep',   growth:0.8, allowProgress:true,  focusBias:'speed',    paceEmphasis:1.5,
                 note:'Sharpening — pace is the priority, volume trims slightly to stay fresh.' },
  return:      { label:'Return',      growth:0.5, allowProgress:true,  focusBias:'distance', paceEmphasis:0.3,
                 note:'Staged return — rebuild consistency and volume first; pace comes back last.' }
};
function currentPhase(){ return PHASES[DB.workspace.phase] || PHASES.build; }

// ── Race planning ───────────────────────────────────────────────────────────
// Given a target race date, work backward to suggest which phase the athlete
// should be in now. Anchored to the DATE (weeks-to-go), not the cycle count, so
// it adapts to however far out they are — including late entries where there's
// no time to build and the honest answer is "sharpen and taper only".
// Race distances: each sets a taper length (weeks) and a race-prep quality pool
// suited to the event. Shorter races taper briefly and sharpen (VO2/short reps);
// longer races taper longer and rehearse race pace over distance.
const RACE_DISTANCES = {
  '5k':       { label:'5k / parkrun',        km:5,     taperWeeks:0.7, prep:['vo2','cruise','threshold'] },
  '10k':      { label:'10k',                 km:10,    taperWeeks:0.7, prep:['vo2','threshold','cruise'] },
  'half':     { label:'Half marathon',       km:21.1,  taperWeeks:1,   prep:['threshold','race','cruise'] },
  'marathon': { label:'Marathon',            km:42.2,  taperWeeks:2,   prep:['race','sustained','threshold'] },
  'ultra':    { label:'Ultra',               km:50,    taperWeeks:2,   prep:['sustained','race','fartlek'] },
  'tri':      { label:'Triathlon (run leg)', km:null,  taperWeeks:0.7, prep:['race','cruise','fartlek'] },
  'custom':   { label:'Custom distance',     km:null,  taperWeeks:1,   prep:['threshold','race','cruise'] }
};
function currentRace(){
  const d = DB.workspace.raceDist;
  if(!d) return null;
  const base = RACE_DISTANCES[d] || RACE_DISTANCES.half;
  // Custom distance derives sensible taper/pool from the entered km.
  if(d==='custom'){
    const km = DB.workspace.raceCustomKm || 15;
    if(km <= 12) return { ...base, km, taperWeeks:0.7, prep:['vo2','threshold','cruise'] };
    if(km <= 30) return { ...base, km, taperWeeks:1,   prep:['threshold','race','cruise'] };
    return { ...base, km, taperWeeks:2, prep:['race','sustained','threshold'] };
  }
  return base;
}
function raceLabel(){
  const r = currentRace(); if(!r) return '';
  if(DB.workspace.raceDist==='custom' && DB.workspace.raceCustomKm) return DB.workspace.raceCustomKm+' km race';
  return r.label;
}
// The race distance in km (resolves custom).
function raceKm(){
  const r = currentRace(); if(!r) return null;
  if(DB.workspace.raceDist==='custom') return DB.workspace.raceCustomKm || null;
  return r.km;
}
// Required race pace (min/km) implied by the target time.
function targetRacePaceMin(){
  const t = DB.workspace.raceTargetTime, km = raceKm();
  if(!t || !km) return null;
  return t / km;
}
// Riegel race-equivalency: T2 = T1 * (D2/D1)^1.06. Predicts time at a new
// distance from a known race performance. Returns predicted minutes or null.
function riegelPredict(knownKm, knownMin, targetKm){
  if(!knownKm || !knownMin || !targetKm) return null;
  return knownMin * Math.pow(targetKm/knownKm, 1.06);
}
// Honest achievability check for a target time. Compares the required pace with
// what the athlete looks currently capable of — from a recent race if given
// (Riegel), else from current quality pace as a rough proxy. Also weighs the
// time available. Returns { verdict, tone, text } or null. Never promises.
function raceAchievability(){
  if(DB.workspace.raceGoal!=='time') return null;
  const km = raceKm(), reqPace = targetRacePaceMin(), weeks = weeksUntilRace();
  if(!km || !reqPace) return null;

  // Estimate current-capable time at the race distance.
  let predMin = null, basis = '';
  const rk = DB.workspace.calibRaceKm, rt = DB.workspace.calibRaceTimeMin;
  if(rk && rt){
    predMin = riegelPredict(rk, rt, km);
    basis = 'your recent '+rk+' km time';
  } else if(DB.workspace.paces && DB.workspace.paces.qualityMin){
    // Quality pace ≈ threshold; race pace for most distances sits near it.
    // Rough: predict race time as quality pace × km, adjusted slightly by distance.
    const distFactor = km<=10 ? 0.98 : km<=21.1 ? 1.03 : 1.10; // longer races run slower than threshold
    predMin = DB.workspace.paces.qualityMin * km * distFactor;
    basis = 'your current training paces';
  }
  if(predMin==null) return null;

  const predPace = predMin/km;
  const gap = (predPace - reqPace) / predPace; // >0 means target is faster than predicted (harder)
  const reqStr = decToClock(reqPace), tgtStr = fmtDuration(DB.workspace.raceTargetTime);

  // Time-available softener: more runway makes a stretch more attainable.
  const runwayOk = weeks == null || weeks >= 8;

  let verdict, tone, text;
  if(gap <= 0.01){
    verdict='in reach'; tone='default';
    text=`Target ${tgtStr} needs about ${reqStr}/km. Based on ${basis}, that looks within reach — hold your training and sharpen toward it.`;
  } else if(gap <= 0.05){
    verdict='a stretch'; tone='default';
    text=`Target ${tgtStr} needs about ${reqStr}/km — a bit faster than ${basis} suggests you're at right now, but a realistic stretch${runwayOk?' with the weeks you have':' though the timeframe is tight'}. Nail your race-pace sessions.`;
  } else if(gap <= 0.10){
    verdict='ambitious'; tone='warn';
    text=`Target ${tgtStr} needs about ${reqStr}/km, which is meaningfully faster than ${basis} suggests. It's ambitious${runwayOk?'':' — and the short timeframe makes it harder'}. Reachable for some, but treat it as a stretch goal, not a plan.`;
  } else {
    verdict='very ambitious'; tone='warn';
    text=`Target ${tgtStr} needs about ${reqStr}/km — well beyond what ${basis} points to for now. Honestly, that's a big ask${runwayOk?'':' in this timeframe'}; consider a more conservative time, a "just finish" goal, or a longer runway. This is an estimate, not a limit — but plan around what's likely.`;
  }
  return { verdict, tone, text, reqPace, predPace };
}
// Format decimal minutes as H:MM:SS or MM:SS.
function fmtDuration(min){
  if(min==null) return '';
  const totalSec = Math.round(min*60);
  const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60), s = totalSec%60;
  return h>0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}
// Parse "H:MM:SS" or "MM:SS" or "M" into decimal minutes.
function parseDuration(str){
  if(!str) return null;
  const parts = String(str).trim().split(':').map(Number);
  if(parts.some(isNaN)) return null;
  if(parts.length===3) return parts[0]*60 + parts[1] + parts[2]/60;
  if(parts.length===2) return parts[0] + parts[1]/60;
  if(parts.length===1) return parts[0];
  return null;
}
function weeksUntilRace(){
  if(!DB.workspace.raceDate) return null;
  const race = parseDate(DB.workspace.raceDate);
  const today = parseDate(isoDate(new Date()));
  return Math.round((race - today) / (7*86400000) * 10) / 10; // weeks, 1 decimal
}
// Returns null (no race set) or a guidance object with the suggested phase and
// a plain-language rationale. Suggests only — the athlete confirms transitions.
function raceGuidance(){
  const w = weeksUntilRace();
  if(w == null) return null;
  const race = currentRace() || RACE_DISTANCES.half;
  const taper = race.taperWeeks;
  const goalTxt = DB.workspace.raceGoal==='finish' ? ' Your goal is to finish strong, so prep favours durability over sharpening.'
                : DB.workspace.raceGoal==='time' ? ' Your goal is a target time, so prep favours race-pace precision and sharpening.' : '';
  const label = raceLabel();

  if(w < 0)
    return { weeks:w, phase:null, passed:true, text:`Your ${label} has passed. Nice work getting to the line. When you're ready for the next goal, clear the race and pick a base or build phase.` };

  const taperWord = taper < 1 ? 'few days' : taper===1 ? 'week' : taper+' weeks';
  if(w <= taper + 0.5)
    return { weeks:w, phase:'raceprep', taper:true,
      text:`About ${fmtWeeks(w)} to your ${label} — taper territory. Keep a little sharpness but let volume drop so you arrive fresh. Consider forcing a deload/recovery cycle for race week.${goalTxt}` };

  if(w <= 6)
    return { weeks:w, phase:'raceprep',
      text:`About ${fmtWeeks(w)} to your ${label} — race-prep phase suits you now: event-specific quality work with volume easing back. Taper follows in the last ${taperWord}.${goalTxt}` };

  if(w <= 12)
    return { weeks:w, phase:'build',
      text:`About ${fmtWeeks(w)} to your ${label} — build phase is the priority: progress load and quality now, then sharpen from ~6 weeks out and taper at the end.` };

  return { weeks:w, phase:'base',
    text:`About ${fmtWeeks(w)} to your ${label} — plenty of runway. Base phase now to build aerobic foundation; build from ~12 weeks out, sharpen from ~6, taper at the end.` };
}
// Honest note for late entries where there isn't time for a full progression.
function raceEntryNote(){
  const w = weeksUntilRace();
  if(w == null || w < 0) return null;
  const race = currentRace() || RACE_DISTANCES.half;
  if(w <= race.taperWeeks + 0.5)
    return 'You\'re very close to race day — there isn\'t time to build fitness now, so this is purely a sharpen-and-taper plan to get you to the line fresh rather than fitter.';
  if(w <= 6)
    return 'You\'re inside the sharpening window with no time for a full build block — the plan focuses on race-specific pace and getting you fresh, not on adding fitness that wouldn\'t consolidate in time.';
  if(w <= 12)
    return 'There isn\'t time for a dedicated base phase, so the plan goes straight into building — that\'s the right call at this range.';
  return null;
}
function fmtWeeks(w){ const r = Math.round(w); return r <= 1 ? 'a week' : r+' weeks'; }

// Other-sport (bike/swim/gym) load dampens run progression — a heavy tri week
// shouldn't let the run plan pile on. Returns a 0..1 growth multiplier.
const OTHER_SPORT_DAMPEN = { light:1.0, moderate:0.6, heavy:0.25 };
function otherSportGrowthFactor(){ return OTHER_SPORT_DAMPEN[DB.workspace.otherSportLoad] ?? 1.0; }

// Combined progression scale: phase growth × other-sport dampening.
function progressionScale(){ return currentPhase().growth * otherSportGrowthFactor(); }

// Symptoms are scoped to the current week (its Monday). If the stored symptom
// week isn't this week, they're stale and treated as none.
function thisWeekMondayIso(){ return isoDate(mondayOf(new Date())); }
function activeSymptoms(){
  const ws = DB.workspace;
  if(!ws.trackSymptoms) return [];
  if(ws.symptomWeek !== thisWeekMondayIso()) return [];
  return ws.symptoms || [];
}

function nextBaselines(current, mode, focus){
  const c = { ...current };
  const conservative = DB.workspace.conservatism==='conservative' || DB.workspace.returnToRunMode;
  const phase = currentPhase();
  // Phase can force a focus bias (e.g. race-prep leans speed, base leans distance).
  focus = phase.focusBias || focus || 'balanced';
  // Maintenance (or dampened-to-zero) → no growth at all.
  const scale = progressionScale();
  switch(mode){
    case 'progress':
      if(scale<=0){ break; } // maintenance / fully dampened: hold flat
      if(focus==='speed'){
        // Slightly reduce volume to make room for harder quality work.
        c.longKm = round1(current.longKm * (1 - 0.03*scale));
        c.qualityKm = round1(current.qualityKm + (conservative?0.25:0.5)*scale);
        c.easyKm = round1(current.easyKm * (1 - 0.03*scale));
      } else if(focus==='distance'){
        c.longKm = round1(current.longKm + (conservative?0.5:1.2)*scale);
        c.qualityKm = round1(current.qualityKm + (conservative?0.25:0.5)*scale);
        c.easyKm = round1(current.easyKm + (conservative?0.4:0.7)*scale);
      } else { // balanced
        c.longKm = round1(current.longKm + (conservative?0.4:0.8)*scale);
        c.qualityKm = round1(current.qualityKm + (conservative?0.25:0.5)*scale);
        c.easyKm = round1(current.easyKm + 0.4*scale);
      }
      break;
    case 'reduce':
      c.longKm = round1(current.longKm*0.85);
      c.qualityKm = round1(current.qualityKm*0.85);
      c.easyKm = round1(current.easyKm*0.9);
      break;
    case 'recovery':
      c.longKm = round1(current.longKm*0.7);
      c.qualityKm = round1(current.qualityKm*0.6);
      c.easyKm = round1(current.easyKm*0.8);
      break;
    // 'hold' → unchanged
  }
  return c;
}

function nextCycleAnchor(){
  if(DB.weeks.length===0) return mondayOf(new Date());
  const last = [...DB.weeks].sort((a,b)=>b.endDate.localeCompare(a.endDate))[0];
  return addDays(parseDate(last.endDate), 1);
}

// Always return a complete paces / baselines object. Older saved cycles and
// weeks (created before pacing existed) may be missing these fields entirely,
// so we fall back through: provided value → workspace value → hard default.
// This is what prevents "Cannot read properties of undefined (reading 'longMin')".
function safePaces(p){
  const d = defaultDB().workspace.paces;
  const ws = (DB.workspace && DB.workspace.paces) ? DB.workspace.paces : d;
  const src = p || ws || d;
  return {
    easyMin: src.easyMin != null ? src.easyMin : d.easyMin,
    qualityMin: src.qualityMin != null ? src.qualityMin : d.qualityMin,
    longMin: src.longMin != null ? src.longMin : (src.easyMin != null ? src.easyMin : d.longMin)
  };
}
function safeBaselines(b){
  const d = defaultDB().workspace.baselines;
  const ws = (DB.workspace && DB.workspace.baselines) ? DB.workspace.baselines : d;
  const src = b || ws || d;
  return {
    longKm: src.longKm != null ? src.longKm : d.longKm,
    qualityKm: src.qualityKm != null ? src.qualityKm : d.qualityKm,
    easyKm: src.easyKm != null ? src.easyKm : d.easyKm
  };
}

// Core generator. `mode` is one of: progress | hold | reduce | recovery | forceDeload
function generateCycle(mode){
  const ws = DB.workspace;
  const conservative = ws.conservatism==='conservative' || ws.returnToRunMode;

  // "Force a deload" and "recovery" are course-corrections you want NOW — not
  // after every already-scheduled future cycle finishes. So for these, clear any
  // weeks scheduled beyond the current one and slot the new block in right after
  // the current week. Normal progress/hold/reduce keep appending after the plan.
  const immediate = (mode==='forceDeload' || mode==='recovery');
  if(immediate){
    const cw = findCurrentWeek();
    if(cw){
      // Snapshot the plan (weeks + cycles) before we alter it, so an accidental
      // force-deload / recovery can be reverted in one tap.
      DB.meta.planUndo = {
        mode,
        weeks: JSON.parse(JSON.stringify(DB.weeks)),
        cycles: JSON.parse(JSON.stringify(DB.cycles)),
        rotation: JSON.parse(JSON.stringify(DB.workspace.qualityRotation || {}))
      };
      // Keep the current week and everything up to it; drop later weeks.
      DB.weeks = DB.weeks.filter(w => w.startDate <= cw.startDate);
      // Drop cycle records that no longer have any weeks.
      const liveCycleNums = new Set(DB.weeks.map(w=>w.cycleNumber));
      DB.cycles = DB.cycles.filter(c => liveCycleNums.has(c.number));
    }
  }

  const lastCycle = DB.cycles[DB.cycles.length-1];
  const baseBaselines = safeBaselines(lastCycle ? lastCycle.baselines : ws.baselines);
  const basePaces = safePaces(lastCycle ? lastCycle.paces : ws.paces);
  const baselines = (mode==='forceDeload') ? baseBaselines : nextBaselines(baseBaselines, mode, ws.focus);
  const blockForPace = blockSummary();
  const paceDeltaForProgression = (blockForPace && blockForPace.avgQualityPaceDelta!=null)
    ? blockForPace.avgQualityPaceDelta : DB.rolling.recentQualityPaceDeltaMin;
  const paces = (mode==='forceDeload') ? basePaces : nextPaces(basePaces, mode, conservative, paceDeltaForProgression, ws.focus);
  const cycleNumber = lastCycle ? lastCycle.number+1 : 1;
  const anchor = nextCycleAnchor();

  const types = mode==='forceDeload' ? ['deload']
              : mode==='recovery'    ? ['recovery','build','build','deload']
              : ['build','build','build','deload'];

  const newWeeks = types.map((type,i)=>{
    const start = addDays(anchor, i*7);
    const end = addDays(start, 6);
    const dist = type==='build'
      ? { long: buildWeekDistance(baselines.longKm,i), quality: buildWeekDistance(baselines.qualityKm,i), easy: buildWeekDistance(baselines.easyKm,i) }
      : weekDistancesFor(baselines, type);
    const week = {
      id: 'w'+Date.now()+'_'+i+'_'+Math.random().toString(36).slice(2,6),
      cycleNumber, cycleWeekIndex:i, type,
      startDate: isoDate(start), endDate: isoDate(end),
      dist, paces, finalized:false, sessions:[]
    };
    week.sessions = buildWeekSessions(week, ws);
    return week;
  });

  DB.cycles.push({ number:cycleNumber, mode, baselines, paces, createdAt:isoDate(new Date()) });
  DB.weeks.push(...newWeeks);
  // Advance this phase's quality rotation so the NEXT generated cycle in the
  // same phase lands on a different workout type (deterministic variety).
  advanceQualityRotation(ws.phase || 'build');
  save();
}

function rebuildCurrentBlock(){
  const cw = findCurrentWeek() || [...DB.weeks].sort((a,b)=>b.endDate.localeCompare(a.endDate))[0];
  if(!cw){ generateCycle('hold'); return; }
  const cycleNumber = cw.cycleNumber;
  const cycleEntry = DB.cycles.find(c=>c.number===cycleNumber);
  const oldWeeks = DB.weeks.filter(w=>w.cycleNumber===cycleNumber).sort((a,b)=>a.startDate.localeCompare(b.startDate));
  if(oldWeeks.length===0) return;
  if(cycleEntry && cycleEntry.manualPlan){
    const plan = cycleEntry.manualPlan;
    const paces = safePaces(cycleEntry.paces);
    const activeWeek=findCurrentWeek();
    const editableFrom=activeWeek ? activeWeek.startDate : isoDate(new Date());
    const rebuilt = oldWeeks.map(oldWeek=>{
      if(oldWeek.startDate<editableFrom||oldWeek.finalized) return oldWeek;
      const weekIndex = oldWeek.cycleWeekIndex;
      const weekPlan = plan.weeks[weekIndex];
      if(!weekPlan) return oldWeek;
      const currentRuns=manualRunsForWeek(weekPlan,plan).map(run=>{
        const existing=oldWeek.sessions.find(session=>session.role===run.role&&session.def===run.day);
        return {...run,sessionId:run.sessionId||(existing&&existing.id),completed:existing?getDone(existing.id):false};
      });
      const editablePlan={...plan,days:currentRuns.map(run=>run.day)};
      const rebuiltWeekPlan={...weekPlan,runs:currentRuns};
      const distances = summarizeManualRuns(currentRuns);
      const week = {
        ...oldWeek,
        dist:{long:distances.longKm, quality:distances.qualityKm, easy:distances.easyKm},
        paces, sessions:[], manual:true
      };
      const generated=buildManualWeekSessions(week,editablePlan,rebuiltWeekPlan);
      const generatedIds=new Set(generated.map(session=>session.id));
      const completed=oldWeek.sessions.filter(session=>getDone(session.id));
      const untouched=oldWeek.sessions.filter(session=>!generatedIds.has(session.id));
      week.sessions=[...generated.filter(session=>!getDone(session.id)),...completed,...untouched];
      return week;
    });
    DB.weeks = DB.weeks.filter(w=>w.cycleNumber!==cycleNumber).concat(rebuilt);
    save();
    return;
  }
  const anchor = parseDate(oldWeeks[0].startDate);
  const types = oldWeeks.map(w=>w.type);
  const baselines = safeBaselines(cycleEntry ? cycleEntry.baselines : DB.workspace.baselines);
  const paces = safePaces(cycleEntry ? cycleEntry.paces : DB.workspace.paces);

  DB.weeks = DB.weeks.filter(w=>w.cycleNumber!==cycleNumber);
  const rebuilt = types.map((type,i)=>{
    const start = addDays(anchor, i*7);
    const end = addDays(start,6);
    const dist = type==='build'
      ? { long: buildWeekDistance(baselines.longKm,i), quality: buildWeekDistance(baselines.qualityKm,i), easy: buildWeekDistance(baselines.easyKm,i) }
      : weekDistancesFor(baselines, type);
    const week = { id:'w'+Date.now()+'_'+i+'_'+Math.random().toString(36).slice(2,6), cycleNumber, cycleWeekIndex:i, type, startDate:isoDate(start), endDate:isoDate(end), dist, paces, finalized:false, sessions:[] };
    week.sessions = buildWeekSessions(week, DB.workspace);
    return week;
  });
  DB.weeks.push(...rebuilt);
  save();
}

// ── Undo over-generation ────────────────────────────────────────────────
// Only removes cycles that haven't started yet, so active/past weeks (and
// their completion history) are never touched.
function removeCycle(cycleNumber){
  const today = isoDate(new Date());
  const weeksInCycle = DB.weeks.filter(w=>w.cycleNumber===cycleNumber);
  if(weeksInCycle.length===0) return false;
  if(weeksInCycle.some(w=>w.startDate<=today)) return false; // already started — protect it
  DB.weeks = DB.weeks.filter(w=>w.cycleNumber!==cycleNumber);
  DB.cycles = DB.cycles.filter(c=>c.number!==cycleNumber);
  save();
  return true;
}
function removeAllUpcomingCycles(){
  const today = isoDate(new Date());
  const cw = findCurrentWeek();
  let keepCycleNumber;
  if(cw){ keepCycleNumber = cw.cycleNumber; }
  else {
    const futureWeeks = DB.weeks.filter(w=>w.startDate>today);
    if(futureWeeks.length===0){ alert('No upcoming cycles to remove.'); return; }
    keepCycleNumber = Math.min(...futureWeeks.map(w=>w.cycleNumber));
  }
  const removable = [...new Set(DB.weeks.filter(w=>w.startDate>today && w.cycleNumber!==keepCycleNumber).map(w=>w.cycleNumber))];
  if(removable.length===0){ alert('No extra upcoming cycles to remove — just the one ahead.'); return; }
  if(!confirm(`Remove ${removable.length} extra upcoming cycle(s), keeping just the next one? This can't be undone.`)) return;
  removable.forEach(removeCycle);
  renderAll();
}
function removeCycleUI(cycleNumber){
  if(!confirm("Remove this generated cycle? This can't be undone.")) return;
  const ok = removeCycle(cycleNumber);
  if(!ok) alert("That cycle has already started, so it can't be removed.");
  renderAll();
}

// ══════════════════════════════════════════════════════════════════════════
// CURRENT-WEEK SOFTENING (non-destructive overlay)
// The athlete's status can soften how THIS week's sessions are shown, WITHOUT
// editing the stored plan. Reverting the status restores everything, because
// nothing was ever overwritten — this is just a display-time adjustment.
// ══════════════════════════════════════════════════════════════════════════
function isCurrentWeek(week){
  const w = findCurrentWeek();
  return !!(w && w.id === week.id);
}
// Returns null (show normally) or an adjustment describing how to soften a
// session given the current status. Only ever applies to the current week and
// only to hard (key/quality/long) sessions.
function sessionAdjustment(s, week){
  if(!isCurrentWeek(week)) return null;
  const status = DB.workspace.status;
  const isHard = s.role==='quality' || (s.role==='long' && s.priority==='key');
  if(status==='sick'){
    if(isHard) return { mode:'paused', label:'Paused — sick', note:'Skip while you\'re unwell. Rest is the priority; only very easy movement if it feels genuinely fine.' };
    return { mode:'ease', label:'Optional — sick', note:'Optional and only if you feel up to it. No pressure to run.' };
  }
  if(status==='injured'){
    if(s.role==='quality') return { mode:'paused', label:'Paused — injury', note:'Hold hard efforts while this is sensitive.' };
    if(s.role==='long' && s.priority==='key') return { mode:'ease', label:'Ease — injury', note:'Keep it short and easy; stop if anything provokes the injury.' };
    return null;
  }
  if(status==='returning'){
    if(s.role==='quality') return { mode:'ease', label:'Ease back', note:'First week back — swap hard efforts for easy running plus a few relaxed strides if it feels good.' };
    if(s.role==='long' && s.priority==='key' && s.reducedVersion) return { mode:'ease', label:'Reduced', note:'Take the reduced option this week: '+s.reducedVersion+'.' };
    return null;
  }
  if(status==='fatigued'){
    if(s.role==='quality') return { mode:'ease', label:'Ease — fatigued', note:'Drop the hard portions this session; keep it easy until you feel fresher.' };
    return null;
  }
  return null;
}
// A week is "disrupted" for display purposes if it's the current week and the
// athlete is in a non-healthy status that softens sessions.
function weekDisruptedLabel(week){
  if(!isCurrentWeek(week)) return null;
  return ({ sick:'Disrupted — sick', injured:'Modified — injury', returning:'Re-entry week', fatigued:'Eased — fatigued' })[DB.workspace.status] || null;
}

// ══════════════════════════════════════════════════════════════════════════
// TRANSPARENT RULE-BASED RECOMMENDATION ENGINE (deterministic, easy to read)
// ══════════════════════════════════════════════════════════════════════════
function computeRecommendation(){
  const ws = DB.workspace, r = DB.rolling;

  if(ws.status==='sick')
    return { action:'suppressHard', tone:'warn', text:'Sick is flagged right now — hard sessions are paused. Rest is the priority; easy movement only if it feels good.' };

  if(ws.status==='injured')
    return { action:'holdConservative', tone:'warn', text:'Injury/sensitivity is flagged — load is held flat and conservative until this clears.' };

  if(ws.status==='fatigued')
    return { action:'hold', tone:'warn', text:'Fatigued is flagged — holding load steady and skipping any pace increase this cycle until you\'re feeling fresher.' };

  // Maintenance phase never progresses — it exists to hold fitness (e.g. travel).
  if(ws.phase==='maintenance')
    return { action:'hold', tone:'default', text:'Maintenance phase — holding load steady to keep fitness ticking over without building. Switch phase in settings when you\'re ready to progress again.' };

  if(ws.status==='returning'){
    if(r.stableReturnWeeksCompleted < 1)
      return { action:'reentry', tone:'warn', text:'Welcome back. This is a normal re-entry week — one stable week before progression resumes.' };
    return { action:'resumeProgress', tone:'default', text:'A stable return week is done — resuming normal progression next cycle.' };
  }

  if(r.disruption)
    return { action:'reentry', tone:'warn', text:'Training was interrupted recently — that\'s a completely normal thing to happen. The next cycle will start with an easier re-entry week rather than picking back up where the plan left off.' };

  // Heavy other-sport load: don't add run load on top of a big bike/swim block.
  if(ws.otherSportLoad==='heavy')
    return { action:'hold', tone:'warn', text:'Other-sport load is set to heavy — holding run load steady this cycle so bike/swim/gym work and running don\'t stack up. Lower it in settings when the cross-training eases.' };

  // Optional weekly wellbeing symptoms: any flagged symptom holds progression
  // this week. It never blocks training — just doesn't add load while you're
  // not feeling right. Sits below the serious status flags above.
  const syms = activeSymptoms();
  if(syms.length){
    const labels = syms.map(v=>(SYMPTOM_OPTIONS.find(o=>o.v===v)?.l || v).toLowerCase()).join(', ');
    return { action:'hold', tone:'warn', text:`You've flagged symptoms this week (${labels}) — holding progression steady rather than building. Keep sessions comfortable and don't force anything.` };
  }

  if(r.recentStrainHigh)
    return { action:'hold', tone:'alert', text:'Logged effort has been high — several sessions came in at high RPE, a rough feel, or heart rate above the intended zone. Holding load steady this cycle rather than progressing, to let things settle.' };

  if(r.recentSessionsCutShort >= 2)
    return { action:'reduce', tone:'alert', text:r.recentSessionsCutShort+' recent sessions were logged noticeably shorter than planned even though marked complete — easing load back next cycle rather than progressing on paper only.' };

  // Block-aware decision: when we have a summary of the whole recent block,
  // judge on the block (average completion, worst week, key-session misses,
  // strain across weeks) rather than only the single most recent week.
  const block = blockSummary();
  if(block){
    const paceHint = block.avgQualityPaceDelta!=null && block.avgQualityPaceDelta < -0.1
        ? ' Across the block, logged quality paces beat target, so pace nudges forward a bit more.'
      : block.avgQualityPaceDelta!=null && block.avgQualityPaceDelta > 0.1
        ? ' Across the block, quality paces ran a touch slow, so the pace step stays modest.' : '';

    if(block.strainWeeks >= 2)
      return { action:'hold', tone:'alert', text:`Effort ran high across ${block.strainWeeks} weeks of the block — holding load steady this cycle to let things settle.` };
    if(block.totalCutShort >= 2)
      return { action:'reduce', tone:'alert', text:`${block.totalCutShort} sessions across the block came in short of plan — easing load back rather than progressing on paper.` };
    if(block.avgRate >= 0.85 && !block.anyKeyMissed && block.worstRate >= 0.6)
      return { action:'progress', tone:'default', text:`Strong block — averaged ${(block.avgRate*100).toFixed(0)}% completion with key sessions landing. Progressing load next cycle.`+paceHint };
    if(block.anyKeyMissed && block.avgRate >= 0.6)
      return { action:'hold', tone:'default', text:'Solid block overall, but a key session was missed along the way — holding load steady rather than progressing.' };
    if(block.avgRate >= 0.6)
      return { action:'hold', tone:'default', text:`Block completion averaged ${(block.avgRate*100).toFixed(0)}% — holding load steady this cycle.` };
    return { action:'reduce', tone:'alert', text:`Block completion averaged only ${(block.avgRate*100).toFixed(0)}% — easing load back next cycle.` };
  }

  // Fallback (no block history yet): week-scoped logic.
  if(r.completionRate == null)
    return { action:'progress', tone:'default', text:'No recent completion data yet — starting with standard progression.' };

  if(r.completionRate >= 0.85 && r.keySessionsCompletedLastCycle){
    const paceHint = (r.recentQualityPaceDeltaMin!=null && r.recentQualityPaceDeltaMin < -0.1)
      ? ' Logged quality paces have been faster than target too, so pace nudges forward a bit more this cycle.'
      : (r.recentQualityPaceDeltaMin!=null && r.recentQualityPaceDeltaMin > 0.1)
      ? ' Logged quality paces have been a touch slower than target, so the pace step stays modest.'
      : '';
    return { action:'progress', tone:'default', text:'Recent completion was strong and key sessions landed — progressing load next cycle.'+paceHint };
  }

  if(r.completionRate >= 0.6)
    return { action:'hold', tone:'default', text:'Recent completion was mixed — holding load steady rather than progressing.' };

  return { action:'reduce', tone:'alert', text:'Quality or long sessions were repeatedly missed or cut short — easing load back next cycle.' };
}

function describeAction(action){
  return ({
    progress:'progress load slightly', hold:'hold the current load steady', reduce:'ease load back a bit',
    reentry:'start with a gentle re-entry week', resumeProgress:'resume normal progression',
    suppressHard:'keep hard sessions paused', holdConservative:'hold load conservatively'
  })[action] || 'continue as normal';
}
function modeForAction(action){
  return ({ progress:'progress', hold:'hold', reduce:'reduce', reentry:'recovery', resumeProgress:'progress', suppressHard:'hold', holdConservative:'hold' })[action] || 'hold';
}

// ══════════════════════════════════════════════════════════════════════════
// WEEK FINALIZATION (rolling metrics) + RETENTION / PRUNING
// ══════════════════════════════════════════════════════════════════════════
function finalizeIfPast(week){
  if(week.finalized) return;
  if(new Date() <= new Date(week.endDate+'T23:59:59')) return;

  const extras = DB.extras.filter(e=>e.weekId===week.id);
  const items = [...week.sessions, ...extras];
  const total = items.length;
  const doneCount = items.filter(it => it.role ? getDone(it.id) : it.done).length;
  const rate = total ? doneCount/total : null;

  const keySessions = week.sessions.filter(s=>s.priority==='key');
  const keyDone = keySessions.length ? keySessions.every(s=>getDone(s.id)) : true;
  const longSess = week.sessions.find(s=>s.role==='long');
  const qualSess = week.sessions.find(s=>s.role==='quality');

  DB.rolling.completionRate = rate;
  DB.rolling.keySessionsCompletedLastCycle = keyDone;
  if(longSess && getDone(longSess.id)) DB.rolling.lastLongRunKm = longSess.targetDistanceKm;
  if(qualSess && getDone(qualSess.id)) DB.rolling.lastQualityType = qualSess.title;
  DB.rolling.deloadRecommended = rate!==null && rate < 0.5;
  DB.rolling.disruption = rate!==null && rate < 0.35;
  if(DB.workspace.status==='returning' && rate!==null && rate>=0.7){
    DB.rolling.stableReturnWeeksCompleted += 1;
  }

  // Fold in logged-activity detail (actual pace/distance vs target), not just
  // the done/not-done checkbox — this is what lets real training performance,
  // not just completion, feed into future pace and load decisions.
  // Only overwrite these logged-data-derived stats when THIS week actually had
  // linked results; otherwise a later week with no logged data (e.g. a deload)
  // would wipe out the signal captured from an earlier week in the block.
  const sessionIds = new Set(week.sessions.map(s=>s.id));
  const weekResults = DB.results.filter(r=>r.sessionId && sessionIds.has(r.sessionId));
  if(weekResults.length){
    const qualityDeltas = weekResults
      .map(r=>({ r, s: week.sessions.find(s=>s.id===r.sessionId) }))
      .filter(x=>x.s && x.s.role==='quality' && x.r.paceDeltaMin!=null)
      .map(x=>x.r.paceDeltaMin);
    if(qualityDeltas.length){
      DB.rolling.recentQualityPaceDeltaMin = round2(qualityDeltas.reduce((a,b)=>a+b,0)/qualityDeltas.length);
    }
    DB.rolling.recentSessionsCutShort = weekResults.filter(r=>r.cutShort).length;

    // Strain signals: high perceived effort, "rough" feel, or heart rate sitting
    // above the intended zone all suggest the athlete is working harder than the
    // plan intends — a guard so a speed focus (or any progression) can't quietly
    // dig a hole even when paces and completion look fine on paper.
    const strainFlags = weekResults.filter(r =>
      (r.rpe!=null && r.rpe>=8) || (r.feel==='rough') || r.hrOverZone
    ).length;
    DB.rolling.recentStrainHigh = strainFlags >= 2;
  }

  // Append a compact summary of THIS week to the block history, so the next
  // block's decision can weigh the whole block, not just the most recent week.
  const weekResultsForHist = DB.results.filter(r=>r.sessionId && new Set(week.sessions.map(s=>s.id)).has(r.sessionId));
  const qDeltas = weekResultsForHist
    .map(r=>({r, s: week.sessions.find(s=>s.id===r.sessionId)}))
    .filter(x=>x.s && x.s.role==='quality' && x.r.paceDeltaMin!=null)
    .map(x=>x.r.paceDeltaMin);
  DB.rolling.weekHistory.push({
    cycleNumber: week.cycleNumber,
    weekIndex: week.cycleWeekIndex,
    type: week.type,
    rate: rate,
    keyDone: keyDone,
    qualityPaceDeltaMin: qDeltas.length ? round2(qDeltas.reduce((a,b)=>a+b,0)/qDeltas.length) : null,
    cutShort: weekResultsForHist.filter(r=>r.cutShort).length,
    strain: weekResultsForHist.filter(r=>(r.rpe!=null&&r.rpe>=8)||r.feel==='rough'||r.hrOverZone).length >= 2
  });
  if(DB.rolling.weekHistory.length > 6) DB.rolling.weekHistory = DB.rolling.weekHistory.slice(-6);

  week.finalized = true;
}

// Block-level view of the most recent full block (the weeks belonging to the
// latest cycle number present in history). Returns null if no history yet.
function blockSummary(){
  const h = DB.rolling.weekHistory;
  if(!h || !h.length) return null;
  const latestCycle = Math.max(...h.map(w=>w.cycleNumber));
  const block = h.filter(w=>w.cycleNumber===latestCycle);
  const buildWeeks = block.filter(w=>w.type==='build' && w.rate!=null);
  const rates = block.filter(w=>w.rate!=null).map(w=>w.rate);
  if(!rates.length) return null;
  const avgRate = rates.reduce((a,b)=>a+b,0)/rates.length;
  const worstRate = Math.min(...rates);
  const anyKeyMissed = block.some(w=>w.rate!=null && w.keyDone===false);
  const totalCutShort = block.reduce((a,w)=>a+(w.cutShort||0),0);
  const strainWeeks = block.filter(w=>w.strain).length;
  const qDeltas = block.filter(w=>w.qualityPaceDeltaMin!=null).map(w=>w.qualityPaceDeltaMin);
  const avgQualityPaceDelta = qDeltas.length ? round2(qDeltas.reduce((a,b)=>a+b,0)/qDeltas.length) : null;
  return { latestCycle, weeks: block.length, avgRate, worstRate, anyKeyMissed, totalCutShort, strainWeeks, avgQualityPaceDelta };
}

function finalizePastWeeks(){
  [...DB.weeks].sort((a,b)=>a.endDate.localeCompare(b.endDate)).forEach(finalizeIfPast);
}

// Keep detailed data only for the previous/current week and the active block;
// older detail is pruned automatically. Rolling summary stats (above) already
// survive pruning because they're extracted before a week is dropped.
function pruneOldData(){
  const cutoffIso = isoDate(addDays(new Date(), -RETENTION_DAYS));
  const keptIds = new Set();
  DB.weeks = DB.weeks.filter(w=>{
    const keep = !w.finalized || w.endDate >= cutoffIso;
    if(keep) keptIds.add(w.id);
    return keep;
  });
  DB.extras = DB.extras.filter(e=>keptIds.has(e.weekId));
  DB.results = DB.results.filter(r=>r.date >= cutoffIso);
  DB.meta.lastPruneAt = isoDate(new Date());
}

function findCurrentWeek(){
  const today = isoDate(new Date());
  return DB.weeks.find(w => w.startDate<=today && today<=w.endDate);
}

// ══════════════════════════════════════════════════════════════════════════
// GARMIN-READY SCAFFOLD — mock/manual import + heuristic linking today,
// real sync can plug into importGarminActivities() later.
// ══════════════════════════════════════════════════════════════════════════
function dateForSessionDay(week, session){
  const idx = DAYS.indexOf(getDay(session.id, session.def));
  return addDays(parseDate(week.startDate), idx);
}
function candidateMatches(activity){
  const targetDate = parseDate(activity.date);
  return DB.weeks.flatMap(w => w.sessions.map(s=>({s,w})))
    .map(({s,w})=>{
      const sessDate = dateForSessionDay(w,s);
      const dayDiff = Math.abs((targetDate - sessDate)/86400000);
      const distDiff = s.targetDistanceKm ? Math.abs(s.targetDistanceKm - (activity.distanceKm||0))/s.targetDistanceKm : 1;
      return { s, w, dayDiff, distDiff, score: dayDiff*2 + distDiff*3 };
    })
    .filter(c=>c.dayDiff<=4)
    .sort((a,b)=>a.score-b.score);
}
// Links a result to a session and computes how it actually compared to the
// plan — not just done/not-done. This is what powers pace/load adjustments
// based on real performance rather than a completion checkbox alone.
function linkResultToSession(result, session){
  result.sessionId = session.id;
  result.status = 'linked';
  result.targetDistanceKm = session.targetDistanceKm || null;
  result.cutShort = !!(session.targetDistanceKm && result.distanceKm && result.distanceKm < session.targetDistanceKm*0.8);
  if(result.distanceKm>0 && result.durationMin>0 && session.paceTargetMin){
    const actualPaceMin = result.durationMin/result.distanceKm;
    result.actualPaceMin = round2(actualPaceMin);
    result.paceDeltaMin = round2(actualPaceMin - session.paceTargetMin); // negative = ran faster than target
  } else {
    result.actualPaceMin = null; result.paceDeltaMin = null;
  }
  // Compare logged avg-HR zone to the zone the session was meant to sit in.
  const zone = hrZoneOf(result.avgHr, DB.workspace.hr);
  result.hrZone = zone;
  result.intendedZone = intendedZone(session.role);
  result.hrOverZone = (zone!=null && zone > result.intendedZone); // e.g. easy run run in Z3+
  setDone(session.id, true);
}
function importActivity(activity){
  const candidates = candidateMatches(activity);
  const best = candidates[0];
  const confident = best && best.dayDiff<=1 && best.distDiff<=0.3;
  const result = {
    id:'r'+Date.now(), date:activity.date, distanceKm:activity.distanceKm, durationMin:activity.durationMin,
    avgHr: activity.avgHr||null, maxHr: activity.maxHr||null, rpe: activity.rpe||null, feel: activity.feel||null,
    notes:activity.notes||'', source:'manual', sessionId:null, status:'unlinked'
  };
  if(confident) linkResultToSession(result, best.s);
  DB.results.push(result);
  save();
  return { result, candidates: candidates.slice(0,4), confident };
}
function manualLink(resultId, sessionId){
  const res = DB.results.find(r=>r.id===resultId); if(!res) return;
  const session = DB.weeks.flatMap(w=>w.sessions).find(s=>s.id===sessionId);
  if(!session) return;
  linkResultToSession(res, session);
  save();
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════════════════════
let openSet = new Set();

function boot(){
  load();
  if(!checkStorage() && typeof setTimeout!=='undefined' && typeof alert!=='undefined'){
    // Storage is blocked (e.g. some in-app HTML viewers / private mode). The
    // app will run but nothing will be saved — tell the person plainly.
    setTimeout(()=>{ try{ alert('Heads up: this viewer can\'t save data, so your plan won\'t persist after you close it.\n\nFor it to work properly (and offline), open this in Safari or Chrome and add it to your home screen. See Settings → Install / use offline.'); }catch(e){} }, 400);
  }
  finalizePastWeeks();
  pruneOldData();
  const cw = findCurrentWeek();
  openSet = new Set(cw ? [cw.id] : []);
  save();
  renderAll();
  if(!DB.meta.onboarded && DB.weeks.length===0){
    openOnboarding(true);
  } else {
    // Not in onboarding — offer the install tutorial once (skips if installed).
    maybeShowInstallTutorial();
  }
}

function renderAll(){
  renderHeader();
  renderStatusRow();
  renderRecommendation();
  renderEffort();
  renderControls();
  renderWeeksAndPreview();
  renderRules();
  refreshProgress();
}

function renderHeader(){
  document.getElementById('h-title').textContent = DB.workspace.name;
  const ph = currentPhase().label;
  const heavy = DB.workspace.otherSportLoad==='heavy' ? ' · cross-training heavy' : DB.workspace.otherSportLoad==='moderate' ? ' · cross-training moderate' : '';
  document.getElementById('h-sub').textContent = `${DB.workspace.goal} · ${ph} phase${heavy}`;
}

function renderStatusRow(){
  document.getElementById('status-row').innerHTML = STATUS_OPTIONS.map(o=>
    `<button class="status-pill ${o.v} ${DB.workspace.status===o.v?'on':''}" onclick="setStatus('${o.v}')">${o.l}</button>`
  ).join('');
  renderSymptomRow();
}

function renderSymptomRow(){
  const el = document.getElementById('symptom-row');
  if(!DB.workspace.trackSymptoms){ el.innerHTML = ''; return; }
  const active = activeSymptoms();
  const pills = SYMPTOM_OPTIONS.map(o=>
    `<button class="symptom-pill ${active.includes(o.v)?'on':''}" onclick="toggleSymptom('${o.v}')">${o.l}</button>`
  ).join('');
  el.innerHTML = `<div class="symptom-wrap">
    <div class="symptom-label">This week${active.length?' · flagged':''}</div>
    <div class="symptom-pills">${pills}</div>
  </div>`;
}

function toggleSymptom(v){
  const ws = DB.workspace;
  const wk = thisWeekMondayIso();
  // If the stored symptoms are from a previous week, start fresh for this week.
  if(ws.symptomWeek !== wk){ ws.symptomWeek = wk; ws.symptoms = []; }
  const i = ws.symptoms.indexOf(v);
  if(i>=0) ws.symptoms.splice(i,1); else ws.symptoms.push(v);
  save(); renderAll();
}

function setStatus(v){
  // Remember what we're changing from, so an accidental tap can be reverted.
  if(DB.workspace.status !== v){
    DB.meta.prevStatus = DB.workspace.status;
    DB.meta.prevStableReturnWeeks = DB.rolling.stableReturnWeeksCompleted;
  }
  DB.workspace.status = v;
  if(v==='returning') DB.rolling.stableReturnWeeksCompleted = 0;
  save(); renderAll();
}
function revertStatus(){
  if(DB.meta.prevStatus == null) return;
  DB.workspace.status = DB.meta.prevStatus;
  if(DB.meta.prevStableReturnWeeks != null) DB.rolling.stableReturnWeeksCompleted = DB.meta.prevStableReturnWeeks;
  DB.meta.prevStatus = null;
  DB.meta.prevStableReturnWeeks = null;
  save(); renderAll();
}

function renderRecommendation(){
  const rec = computeRecommendation();
  const cls = rec.tone==='warn' ? 'warn' : rec.tone==='alert' ? 'alert' : '';
  const ico = rec.tone==='alert' ? '⚠️' : rec.tone==='warn' ? '💡' : '✅';
  const undo = (DB.meta.prevStatus != null)
    ? `<button class="undo-btn" onclick="revertStatus()">Undo — back to “${STATUS_OPTIONS.find(o=>o.v===DB.meta.prevStatus)?.l || DB.meta.prevStatus}”</button>`
    : '';
  let html = `<div class="rec-banner ${cls}"><span class="rec-ico">${ico}</span><span>${rec.text}${undo}</span></div>`;

  // Settings-changed note: progression settings only affect the NEXT generated
  // cycle, so we tell the athlete rather than silently doing nothing on rebuild.
  const pending = DB.meta.pendingSettingNote;
  if(pending && pending.length){
    const label = pending.length===1 ? pending[0].charAt(0).toUpperCase()+pending[0].slice(1) : 'Those settings';
    html += `<div class="settings-note"><span class="rec-ico">🛠️</span><span>${label} updated — this applies to your <strong>next generated cycle</strong>, not the current block. The plan you're in now stays as-is.<button class="undo-btn" onclick="dismissSettingNote()">Got it</button></span></div>`;
  }
  // Race-planning banner: suggests the phase for how far out the race is, and
  // offers a one-tap switch. Suggests only — never changes phase on its own.
  const rg = raceGuidance();
  if(rg){
    if(rg.passed){
      html += `<div class="race-note"><span class="rec-ico">🏁</span><span>${rg.text}<button class="undo-btn" onclick="clearRace()">Clear race</button></span></div>`;
    } else {
      const needSwitch = rg.phase && DB.workspace.phase !== rg.phase;
      const switchBtn = needSwitch
        ? `<button class="undo-btn" onclick="applyRacePhase('${rg.phase}')">Switch to ${PHASES[rg.phase].label}</button>`
        : '';
      html += `<div class="race-note"><span class="rec-ico">🏁</span><span>${rg.text}${switchBtn}</span></div>`;
      // Honest note when there isn't time for a full progression (late entry).
      const entryNote = raceEntryNote();
      if(entryNote){
        html += `<div class="race-note warn"><span class="rec-ico">⏳</span><span>${entryNote}</span></div>`;
      }
      // Achievability check for a target time.
      const ach = raceAchievability();
      if(ach){
        const icon = ach.tone==='warn' ? '⚠️' : '🎯';
        html += `<div class="race-note ${ach.tone==='warn'?'warn':''}"><span class="rec-ico">${icon}</span><span>${ach.text}</span></div>`;
      }
    }
  }

  // Plan course-correction undo (force deload / recovery slotted in).
  if(DB.meta.planUndo){
    const what = DB.meta.planUndo.mode==='forceDeload' ? 'deload week' : 'recovery cycle';
    html += `<div class="settings-note"><span class="rec-ico">↩️</span><span>A ${what} was slotted in right after your current week. Changed your mind?<button class="undo-btn" onclick="revertPlanChange()">Undo — restore previous plan</button></span></div>`;
  }

  document.getElementById('rec-root').innerHTML = html;
}
function applyRacePhase(phaseKey){
  DB.meta.prevStatus = DB.meta.prevStatus; // leave status-undo untouched
  DB.workspace.phase = phaseKey;
  DB.meta.pendingSettingNote = ['phase'];
  save(); renderAll();
}
function clearRace(){
  DB.workspace.raceDate = null; DB.workspace.raceDist = null;
  DB.workspace.raceGoal = null; DB.workspace.raceCustomKm = null;
  DB.workspace.raceTargetTime = null;
  save(); renderAll();
}
function onRaceDistChange(){
  const v = document.getElementById('set-racedist').value;
  const wrap = document.getElementById('set-customkm-wrap');
  if(wrap) wrap.style.display = (v==='custom') ? '' : 'none';
  updateAchievabilityNote();
}
function onRaceGoalChange(){
  const v = document.getElementById('set-racegoal').value;
  const wrap = document.getElementById('set-targettime-wrap');
  if(wrap) wrap.style.display = (v==='time') ? '' : 'none';
  updateAchievabilityNote();
}
// Live reality-check as the user types a target time — reads directly from the
// current inputs so it updates before saving.
function updateAchievabilityNote(){
  const el = document.getElementById('set-achieve-note');
  if(!el) return;
  const dist = document.getElementById('set-racedist').value;
  const goal = document.getElementById('set-racegoal').value;
  const t = parseDuration(document.getElementById('set-targettime').value);
  if(goal!=='time' || !dist || t==null){ el.textContent = ''; return; }
  // Temporarily reflect the in-progress inputs so raceAchievability sees them.
  const ws = DB.workspace;
  const snapshot = { raceDist:ws.raceDist, raceGoal:ws.raceGoal, raceTargetTime:ws.raceTargetTime, raceCustomKm:ws.raceCustomKm };
  ws.raceDist = dist; ws.raceGoal = 'time'; ws.raceTargetTime = t;
  ws.raceCustomKm = parseFloat(document.getElementById('set-racecustomkm').value) || ws.raceCustomKm;
  const a = raceAchievability();
  Object.assign(ws, snapshot); // restore — don't persist until Save
  if(a){
    const pace = decToClock(a.reqPace);
    el.textContent = `That's ${pace}/km. ${a.text.replace(/^.*?needs about [^ ]+\/km[.,]?\s*/,'')}`;
  } else {
    const km = dist==='custom' ? (parseFloat(document.getElementById('set-racecustomkm').value)||null) : (RACE_DISTANCES[dist]||{}).km;
    el.textContent = km ? `That's about ${decToClock(t/km)}/km required.` : '';
  }
}
function dismissSettingNote(){
  DB.meta.pendingSettingNote = null;
  save(); renderRecommendation();
}

function renderEffort(){
  document.getElementById('eff-grid').innerHTML = effortGuideRows().map(e =>
    `<div class="eff-card"><div class="eff-lbl">${e.l}</div><div class="eff-val">${e.e}</div><div class="eff-note">${e.n}</div></div>`
  ).join('');
}

function renderControls(){
  const manualBlockExists = DB.cycles.some(c=>c.manualPlan);
  const buttons = [
    {l:'Generate next cycle (recommended)', fn:`generateNextCycle()`},
    {l:'Progress next cycle', fn:`generateNextCycle('progress')`},
    {l:'Repeat current load', fn:`generateNextCycle('hold')`},
    {l:'Reduce next cycle', fn:`generateNextCycle('reduce')`},
    {l:'Force a deload week', fn:`generateNextCycle('forceDeload')`},
    {l:'Recovery / re-entry cycle', fn:`generateNextCycle('recovery')`},
    {l:'Rebuild current block', fn:`rebuildCurrentBlockUI()`, danger:true},
    {l:'Recalibrate from current level', fn:`openOnboarding(false)`},
    {l:'Remove extra upcoming cycles', fn:`removeAllUpcomingCycles()`, danger:true}
  ];
  buttons.push({l:'Create a manual block', fn:`openManualBlock('new')`});
  if(manualBlockExists) buttons.push({l:'Draft next block from manual block', fn:`openManualBlock('next')`});
  document.getElementById('ctrl-grid').innerHTML = buttons.map(b=>
    `<button class="ctrl-btn ${b.danger?'danger':''}" onclick="${b.fn}">${b.l}</button>`
  ).join('');
}

let manualBuilderKind = 'new';
let manualBuilderSource = null;
let manualSelectedDays = [];
let manualWorkingPlan = null;

function latestManualCycle(){
  return DB.cycles.filter(c=>c.manualPlan).sort((a,b)=>b.number-a.number)[0] || null;
}
function editablePlanFromCycle(cycle,currentWeek){
  const cycleWeeks = DB.weeks.filter(week=>week.cycleNumber===cycle.number)
    .sort((a,b)=>a.cycleWeekIndex-b.cycleWeekIndex);
  const days = DAYS.filter(day=>cycleWeeks.some(week=>week.sessions.some(session=>session.def===day)));
  const longRunDay = days.find(day=>cycleWeeks.some(week=>week.sessions.some(session=>session.def===day&&session.role==='long')))
    || days[days.length-1];
  const qualityDay = days.find(day=>day!==longRunDay&&cycleWeeks.some(week=>week.sessions.some(session=>session.def===day&&session.role==='quality')))
    || days.find(day=>day!==longRunDay) || null;
  const weeks = cycleWeeks.map(week=>{
    const readOnly=week.startDate<currentWeek.startDate||week.finalized;
    const runs=week.sessions.map(session=>{
      const effectiveRole=session.role==='long'||session.role==='quality' ? session.role : 'easy';
      const main=String(session.main||'').replace(/^\s*\d+(?:\.\d+)?\s*km\.\s*/i,'');
      const intervalStructure=effectiveRole==='quality'
        ? main.replace(/\s*Target pace:.*$/i,'').replace(/^\s*[^:]+:\s*/,'').trim()
        : '';
      return {
        sessionId:session.id,
        day:session.def,
        scheduledDay:getDay(session.id,session.def),
        role:effectiveRole,
        distanceKm:session.targetDistanceKm,
        details:effectiveRole==='quality'?'':main,
        workoutType:session.qualityType||'Intervals',
        intervalStructure,
        targetPace:session.targetPace||paceRangeStr(week.paces.qualityMin,0.083),
        completed:getDone(session.id)
      };
    });
    const summary=summarizeManualRuns(runs);
    return {
      ...summary,
      qualityDescription:(runs.find(run=>run.role==='quality')||{}).intervalStructure||'',
      runs,readOnly,
      label:`Week ${week.cycleWeekIndex+1}${week.type==='deload'?' · Deload':week.type==='recovery'?' · Re-entry':''}`
    };
  });
  const baselines=safeBaselines(cycle.baselines);
  return {
    days,longRunDay,qualityDay,baselines,weeks,preserveRoles:true,
    paces:safePaces(cycle.paces)
  };
}
function openCurrentBlockEditor(cycleNumber){
  const currentWeek=findCurrentWeek();
  if(!currentWeek||currentWeek.cycleNumber!==cycleNumber){
    alert('The current week could not be found. Open this editor from the active block.');
    return;
  }
  const cycle=DB.cycles.find(entry=>entry.number===cycleNumber);
  if(!cycle){
    alert('The training block could not be found.');
    return;
  }
  manualBuilderKind='edit';
  manualBuilderSource=cycle;
  manualWorkingPlan=editablePlanFromCycle(cycle,currentWeek);
  manualSelectedDays=manualWorkingPlan.days.slice();
  document.getElementById('manual-title').textContent='Edit this training block';
  document.getElementById('manual-sub').textContent='Changes apply to unfinished runs from this week onward. Completed runs and prior weeks stay unchanged.';
  document.getElementById('manual-save-btn').textContent='Save block edits';
  document.getElementById('manual-mode-wrap').style.display='none';
  document.getElementById('manual-day-settings').style.display='none';
  document.getElementById('manual-longday').innerHTML=manualSelectedDays.map(day=>`<option value="${day}">${day}</option>`).join('');
  document.getElementById('manual-qualityday').innerHTML=manualSelectedDays.filter(day=>day!==manualWorkingPlan.longRunDay)
    .map(day=>`<option value="${day}">${day}</option>`).join('')||'<option value="">Not scheduled</option>';
  document.getElementById('manual-longday').value=manualWorkingPlan.longRunDay||'';
  document.getElementById('manual-qualityday').value=manualWorkingPlan.qualityDay||'';
  document.getElementById('manual-weeks').innerHTML='';
  manualWorkingPlan.weeks.forEach(week=>{
    week.runs.forEach(run=>{
      run.completed=!!run.completed;
    });
  });
  renderManualWeeks(manualWorkingPlan.weeks);
  document.getElementById('manual-schedule-note').textContent='Completed runs and weeks before the current week are preserved. Save updates the remaining runs in this block without adding another block.';
  document.getElementById('manualBlockModal').classList.add('open');
}
function defaultManualPlan(){
  const ws = DB.workspace;
  const days = DAYS.filter(day=>(ws.preferredDays || []).includes(day));
  const selectedDays = days.length ? days : ['Tue','Thu','Sat','Sun'];
  const longRunDay = selectedDays.includes(ws.longRunDay) ? ws.longRunDay : selectedDays[selectedDays.length-1];
  const qualityDay = selectedDays.find(day=>day!==longRunDay) || null;
  const baselines = safeBaselines(ws.baselines);
  const distances = [0.85, 0.93, 1].map(factor=>({
    longKm:round1(baselines.longKm*factor),
    qualityKm:round1(baselines.qualityKm*factor),
    easyKm:round1(baselines.easyKm*factor)
  }));
  distances.push({
    longKm:round1(baselines.longKm*0.55),
    qualityKm:round1(baselines.qualityKm*0.6),
    easyKm:round1(baselines.easyKm*0.7)
  });
  const plan = {days:selectedDays,longRunDay,qualityDay,baselines:{...distances[2]},weeks:[]};
  plan.weeks = distances.map((dist,index)=>{
    const weekPlan = {
      ...dist,
      qualityDescription:index===3
        ? 'Easy running with a few relaxed strides only.'
        : 'Controlled quality work; keep the hard portions sustainable.'
    };
    weekPlan.runs = manualRunsForWeek(weekPlan,plan);
    return weekPlan;
  });
  return plan;
}
function manualPlanForMode(mode){
  if(!manualBuilderSource) return defaultManualPlan();
  const source = manualBuilderSource.manualPlan;
  const previousBaselines = safeBaselines(source.baselines || manualBuilderSource.baselines);
  const previousPaces = safePaces(manualBuilderSource.paces);
  const baselines = nextBaselines(previousBaselines, mode, DB.workspace.focus);
  const paceDelta = DB.rolling.recentQualityPaceDeltaMin;
  const paces = nextPaces(
    previousPaces, mode,
    DB.workspace.conservatism==='conservative' || DB.workspace.returnToRunMode,
    paceDelta, DB.workspace.focus
  );
  const weeks = source.weeks.map(week=>{
    const {readOnly,label,...weekData}=week;
    return {
    ...weekData,
    runs:manualRunsForWeek(week,source).map(run=>{
      const previousBase = run.role==='long' ? previousBaselines.longKm
        : run.role==='quality' ? previousBaselines.qualityKm : previousBaselines.easyKm;
      const nextBase = run.role==='long' ? baselines.longKm
        : run.role==='quality' ? baselines.qualityKm : baselines.easyKm;
      const {sessionId,completed,scheduledDay,...runData}=run;
      return {...runData,sessionId:null,completed:false,distanceKm:round1(run.distanceKm*nextBase/Math.max(previousBase,0.1))};
    })
  };});
  weeks.forEach(week=>Object.assign(week,summarizeManualRuns(week.runs)));
  return {...source, baselines, paces, weeks, preserveRoles:false};
}
function renderManualWeeks(weeks){
  const labels = ['Build week 1','Build week 2','Build week 3','Deload week'];
  if(!manualWorkingPlan) return;
  manualWorkingPlan.weeks = weeks;
  document.getElementById('manual-weeks').innerHTML = weeks.map((week,index)=>{
    const runs = manualWorkingPlan.days.length
      ? manualRunsForWeek(week,manualWorkingPlan)
      : [];
    if(manualWorkingPlan.days.length){
      const inactiveRuns = (week.runs || []).filter(run=>!manualWorkingPlan.days.includes(run.day));
      week.runs = [...runs,...inactiveRuns];
    }
    const weekDisabled = week.readOnly ? 'disabled' : '';
    return `<div class="manual-week-card">
      <div class="manual-week-title">${escapeManualText(week.label || labels[index] || `Week ${index+1}`)}</div>
      ${week.readOnly ? '<div class="manual-edit-note">This week is already complete and will not be changed.</div>' : ''}
      <div class="manual-week-total" id="manual-week-total-${index}"></div>
      <div class="manual-run-list">${runs.map(run=>`
        <section class="manual-run-card">
          <div class="manual-run-title">${run.scheduledDay&&run.scheduledDay!==run.day?`${run.scheduledDay} (moved) · `:''}${run.day} · ${run.role==='long'?'Long run':run.role==='quality'?'Quality run':'Easy run'}</div>
          ${run.completed ? '<div class="manual-edit-note">Completed run — kept as-is.</div>' : ''}
          <div class="manual-run-distance">
            <label class="form-lbl" for="manual-distance-${index}-${run.day}">Distance (km)</label>
            <input class="textinput" id="manual-distance-${index}-${run.day}" type="number" step="0.1" min="0.1" value="${escapeManualText(run.distanceKm)}" oninput="updateManualWeekTotal(${index})" ${weekDisabled}${run.completed?' disabled':''}>
          </div>
          ${run.role==='quality' ? `
            <label class="form-lbl" for="manual-quality-type-${index}-${run.day}">Workout type</label>
            <select class="select-input" id="manual-quality-type-${index}-${run.day}" ${weekDisabled}${run.completed?' disabled':''}>
              ${Array.from(new Set(['Intervals','Tempo / threshold','Hills','Fartlek','Strides','Other',run.workoutType])).map(type=>`<option value="${escapeManualText(type)}" ${run.workoutType===type?'selected':''}>${escapeManualText(type)}</option>`).join('')}
            </select>
            <label class="form-lbl" for="manual-intervals-${index}-${run.day}">Intervals and execution</label>
            <textarea class="notesfield" id="manual-intervals-${index}-${run.day}" rows="2" placeholder="e.g. 5 × 1 km, 2 min easy jog recovery" ${weekDisabled}${run.completed?' disabled':''}>${escapeManualText(run.intervalStructure)}</textarea>
            <label class="form-lbl manual-sub-label" for="manual-pace-${index}-${run.day}">Target pace</label>
            <input class="textinput" id="manual-pace-${index}-${run.day}" type="text" value="${escapeManualText(run.targetPace)}" placeholder="e.g. 4:45–5:00 min/km" ${weekDisabled}${run.completed?' disabled':''}>
          ` : `
            <label class="form-lbl" for="manual-details-${index}-${run.day}">${run.role==='long'?'Long-run execution':'Easy-run notes'}</label>
            <textarea class="notesfield" id="manual-details-${index}-${run.day}" rows="2" placeholder="${run.role==='long'?'e.g. Easy first 8 km, then steady finish':'e.g. Keep this one short and relaxed'}" ${weekDisabled}${run.completed?' disabled':''}>${escapeManualText(run.details)}</textarea>
          `}
        </section>
      `).join('')}</div>
    </div>`;
  }).join('');
  weeks.forEach((week,index)=>updateManualWeekTotal(index));
}
function updateManualWeekTotal(index){
  const total = manualSelectedDays.reduce((sum,day)=>{
    const input = document.getElementById(`manual-distance-${index}-${day}`);
    return sum+(input ? parseFloat(input.value)||0 : 0);
  },0);
  document.getElementById('manual-week-total-'+index).textContent = `Planned total: ${round1(total)} km this week`;
}
function updateManualTotals(){
  for(let i=0;i<4;i++) updateManualWeekTotal(i);
  const easyCount = Math.max(0, manualSelectedDays.length - (manualSelectedDays.length ? 1 : 0) - (manualSelectedDays.length>1 ? 1 : 0));
  const types = manualSelectedDays.length===1 ? 'long run only'
    : `1 long, 1 quality, ${easyCount} easy`;
  document.getElementById('manual-days-note').textContent =
    `${manualSelectedDays.length} run${manualSelectedDays.length===1?'':'s'} per week · ${types}.`;
}
function captureManualWeeksFromForm(){
  if(!manualWorkingPlan) return [];
  return manualWorkingPlan.weeks.map((week,index)=>{
    const runs = manualWorkingPlan.days.map(day=>{
      const previous = (week.runs || []).find(run=>run.day===day);
      if(manualWorkingPlan.preserveRoles && !previous) return null;
      const role = manualWorkingPlan.preserveRoles ? previous.role
        : day===document.getElementById('manual-longday').value ? 'long'
        : day===document.getElementById('manual-qualityday').value ? 'quality' : 'easy';
      const read = suffix=>document.getElementById(`manual-${suffix}-${index}-${day}`);
      const distanceInput = read('distance');
      const detailsInput = read('details');
      const qualityTypeInput = read('quality-type');
      const intervalsInput = read('intervals');
      const paceInput = read('pace');
      return {
        ...previous,
        day,role,
        distanceKm:distanceInput ? parseFloat(distanceInput.value) : (previous ? previous.distanceKm : 0),
        details:detailsInput ? detailsInput.value : (previous ? previous.details : ''),
        workoutType:qualityTypeInput ? qualityTypeInput.value : (previous ? previous.workoutType : 'Intervals'),
        intervalStructure:intervalsInput ? intervalsInput.value : (previous ? previous.intervalStructure : ''),
        targetPace:paceInput ? paceInput.value : (previous ? previous.targetPace : '')
      };
    });
    const capturedRuns = runs.filter(Boolean);
    const inactiveRuns = (week.runs || []).filter(run=>!manualWorkingPlan.days.includes(run.day));
    const activeRuns = capturedRuns.filter(run=>manualWorkingPlan.days.includes(run.day));
    const summary = summarizeManualRuns(activeRuns);
    return {
      ...week,...summary,runs:[...activeRuns,...inactiveRuns],
      qualityDescription:(activeRuns.find(run=>run.role==='quality')||{}).intervalStructure||''
    };
  });
}
function updateManualScheduleNote(start){
  const end = addDays(start,27);
  let note = `Scheduled ${fmtRange(isoDate(start),isoDate(end))} after all weeks already in your plan.`;
  if(DB.workspace.raceDate){
    const race = parseDate(DB.workspace.raceDate);
    note += ' Race dates are a reminder only; manual blocks do not automatically taper or stop on race day.';
    if(race>=start && race<=end){
      note += ' This block overlaps your race date—adjust the weeks so the plan does not schedule runs after the event.';
    } else if(race<start){
      note += ' This block starts after your saved race date.';
    }
  }
  document.getElementById('manual-schedule-note').textContent = note;
}
function updateManualDayOptions(){
  if(manualWorkingPlan && manualWorkingPlan.days.length) manualWorkingPlan.weeks = captureManualWeeksFromForm();
  const longSelect = document.getElementById('manual-longday');
  const qualitySelect = document.getElementById('manual-qualityday');
  const previousLong = longSelect.value;
  const previousQuality = qualitySelect.value;
  const options = manualSelectedDays.map(day=>`<option value="${day}">${day}</option>`).join('');
  longSelect.innerHTML = options || '<option value="">Choose run days first</option>';
  if(manualSelectedDays.includes(previousLong)) longSelect.value = previousLong;
  else if(manualSelectedDays.length) longSelect.value = manualSelectedDays[manualSelectedDays.length-1];

  const otherDays = manualSelectedDays.filter(day=>day!==longSelect.value);
  qualitySelect.innerHTML = otherDays.map(day=>`<option value="${day}">${day}</option>`).join('')
    || '<option value="">Not scheduled</option>';
  if(otherDays.includes(previousQuality)) qualitySelect.value = previousQuality;
  else if(otherDays.length) qualitySelect.value = otherDays[0];
  document.getElementById('manual-qualityday-wrap').style.display = otherDays.length ? '' : 'none';
  if(manualWorkingPlan){
    manualWorkingPlan.days = manualSelectedDays.slice();
    manualWorkingPlan.longRunDay = longSelect.value;
    manualWorkingPlan.qualityDay = qualitySelect.value || null;
    renderManualWeeks(manualWorkingPlan.weeks);
  }
  updateManualTotals();
}
function toggleManualDay(btn,day){
  if(manualWorkingPlan && manualWorkingPlan.days.length) manualWorkingPlan.weeks = captureManualWeeksFromForm();
  if(manualSelectedDays.includes(day)) manualSelectedDays = manualSelectedDays.filter(value=>value!==day);
  else manualSelectedDays.push(day);
  manualSelectedDays = DAYS.filter(value=>manualSelectedDays.includes(value));
  document.querySelectorAll('#manual-days button').forEach(button=>{
    const buttonDay = DAYS.find(value=>button.textContent===value.slice(0,2));
    button.classList.toggle('on', manualSelectedDays.includes(buttonDay));
  });
  updateManualDayOptions();
}
function openManualBlock(kind){
  manualBuilderKind = kind;
  manualBuilderSource = kind==='next' ? latestManualCycle() : null;
  if(kind==='next' && !manualBuilderSource){
    alert('Create a manual block first before drafting its next block.');
    return;
  }
  let plan;
  if(kind==='next'){
    const action = computeRecommendation().action;
    const suggestedMode = modeForAction(action);
    const mode = ['progress','hold','reduce'].includes(suggestedMode) ? suggestedMode : 'hold';
    document.getElementById('manual-mode').value = mode;
    document.getElementById('manual-mode-wrap').style.display = '';
    plan = manualPlanForMode(mode);
    document.getElementById('manual-title').textContent = 'Review the next-block draft';
    document.getElementById('manual-sub').textContent = 'The previous manual block is copied and adjusted from the current recommendation. Edit every value before adding it.';
    document.getElementById('manual-save-btn').textContent = 'Add reviewed block';
    document.getElementById('manual-schedule-note').textContent = 'This is a draft, not a medical recommendation. Review the distances and workout details; the block is added after all weeks already in your plan.';
  } else {
    plan = defaultManualPlan();
    document.getElementById('manual-mode-wrap').style.display = 'none';
    document.getElementById('manual-title').textContent = 'Create a manual block';
    document.getElementById('manual-sub').textContent = 'Choose your weekly running pattern and edit each week before adding this four-week block.';
    document.getElementById('manual-save-btn').textContent = 'Add block to plan';
    document.getElementById('manual-schedule-note').textContent = 'The block is scheduled after the weeks already in your plan. Distances are your inputs; review the weekly total before saving.';
  }
  document.getElementById('manual-day-settings').style.display='';
  manualWorkingPlan = plan;
  manualSelectedDays = DAYS.filter(day=>plan.days.includes(day));
  document.getElementById('manual-weeks').innerHTML = '';
  document.querySelectorAll('#manual-days button').forEach(button=>{
    const buttonDay = DAYS.find(value=>button.textContent===value.slice(0,2));
    button.classList.toggle('on', manualSelectedDays.includes(buttonDay));
  });
  document.getElementById('manual-longday').innerHTML = '';
  document.getElementById('manual-qualityday').innerHTML = '';
  const longOptions = manualSelectedDays.map(day=>`<option value="${day}">${day}</option>`).join('');
  document.getElementById('manual-longday').innerHTML = longOptions;
  document.getElementById('manual-qualityday').innerHTML = manualSelectedDays
    .filter(day=>day!==plan.longRunDay).map(day=>`<option value="${day}">${day}</option>`).join('')
    || '<option value="">Not scheduled</option>';
  document.getElementById('manual-longday').value = plan.longRunDay;
  document.getElementById('manual-qualityday').value = plan.qualityDay || '';
  updateManualDayOptions();
  updateManualTotals();

  updateManualScheduleNote(nextCycleAnchor());
  document.getElementById('manualBlockModal').classList.add('open');
}
function updateManualDraftFromMode(){
  if(manualBuilderKind!=='next') return;
  const currentWeeks = captureManualWeeksFromForm();
  const plan = manualPlanForMode(document.getElementById('manual-mode').value);
  plan.weeks.forEach((week,index)=>{
    const currentRuns = new Map((currentWeeks[index].runs || []).map(run=>[run.day,run]));
    week.runs.forEach(run=>{
      const prior = currentRuns.get(run.day);
      if(prior) Object.assign(run,{
        details:prior.details,
        workoutType:prior.workoutType,
        intervalStructure:prior.intervalStructure,
        targetPace:prior.targetPace
      });
    });
  });
  manualWorkingPlan = plan;
  renderManualWeeks(plan.weeks);
  updateManualTotals();
}
function closeManualBlock(){
  document.getElementById('manualBlockModal').classList.remove('open');
  manualBuilderSource = null;
  manualWorkingPlan = null;
  document.getElementById('manual-day-settings').style.display = '';
}
function saveManualBlock(){
  if(!manualSelectedDays.length){ alert('Choose at least one run day.'); return; }
  const longRunDay = document.getElementById('manual-longday').value;
  const qualityDay = manualSelectedDays.length>1 ? document.getElementById('manual-qualityday').value : null;
  if(!manualSelectedDays.includes(longRunDay)){ alert('Choose a long-run day from your selected run days.'); return; }
  if(manualSelectedDays.length>1 && (!qualityDay || qualityDay===longRunDay || !manualSelectedDays.includes(qualityDay))){
    alert('Choose a quality-run day that is different from the long-run day.'); return;
  }
  const weeks = captureManualWeeksFromForm();
  for(let index=0;index<weeks.length;index++){
    const week=weeks[index];
    const activeRuns = week.runs.filter(run=>manualSelectedDays.includes(run.day));
    const editableRuns = activeRuns.filter(run=>!week.readOnly&&!run.completed);
    if(editableRuns.some(run=>!Number.isFinite(run.distanceKm)||run.distanceKm<=0)){
      alert(`Enter a positive distance for every run in week ${index+1}.`);
      return;
    }
    if(editableRuns.some(run=>run.role==='quality'
      && (!run.workoutType.trim()||!run.intervalStructure.trim()||!run.targetPace.trim()))){
      alert(`Add the workout type, intervals, and target pace for the quality run in week ${index+1}.`);
      return;
    }
    activeRuns.forEach(run=>{run.distanceKm=round1(run.distanceKm);});
  }
  const baselineWeek=weeks[Math.min(2,weeks.length-1)];
  const plan = {
    days:manualSelectedDays.slice(), longRunDay, qualityDay,
    baselines:summarizeManualRuns(baselineWeek.runs
      .filter(run=>manualSelectedDays.includes(run.day))),
    weeks,
    preserveRoles:!!manualWorkingPlan.preserveRoles
  };
  if(manualBuilderKind==='edit'){
    saveCurrentBlockEdits(plan);
    return;
  }
  const mode = manualBuilderKind==='next' ? document.getElementById('manual-mode').value : 'manual';
  const paces = manualBuilderKind==='next'
    ? manualPlanForMode(mode).paces
    : safePaces(DB.workspace.paces);
  const cycleNumber = DB.cycles.reduce((largest,cycle)=>Math.max(largest,cycle.number||0),0)+1;
  const anchor = nextCycleAnchor();
  const newWeeks = plan.weeks.map((weekPlan,index)=>{
    const weekStart = addDays(anchor,index*7);
    const type = index===3 ? 'deload' : 'build';
    const distances = summarizeManualRuns(manualRunsForWeek(weekPlan,plan));
    const week = {
      id:'w'+Date.now()+'_'+index+'_'+Math.random().toString(36).slice(2,6),
      cycleNumber, cycleWeekIndex:index, type,
      startDate:isoDate(weekStart), endDate:isoDate(addDays(weekStart,6)),
      dist:{long:distances.longKm, quality:distances.qualityKm, easy:distances.easyKm},
      paces, finalized:false, sessions:[], manual:true
    };
    week.sessions = buildManualWeekSessions(week,plan,weekPlan);
    return week;
  });
  const cycleBaselines = {...plan.baselines};
  DB.cycles.push({
    number:cycleNumber, mode:manualBuilderKind==='next' ? `manual-${mode}` : 'manual',
    baselines:cycleBaselines, paces, createdAt:isoDate(new Date()), manualPlan:plan
  });
  DB.weeks.push(...newWeeks);
  save();
  closeManualBlock();
  renderAll();
}
function saveCurrentBlockEdits(plan){
  const cycle=manualBuilderSource;
  if(!cycle){ alert('The training block could not be found.'); return; }
  const originalWeeks=DB.weeks.filter(week=>week.cycleNumber===cycle.number);
  const weeksByIndex=new Map(originalWeeks.map(week=>[week.cycleWeekIndex,week]));
  plan.weeks.forEach((weekPlan,index)=>{
    const week=weeksByIndex.get(index);
    if(!week||weekPlan.readOnly) return;
    const rebuilt=buildManualWeekSessions(week,plan,weekPlan);
    const newById=new Map(rebuilt.map(session=>[session.id,session]));
    const preserved=week.sessions.filter(session=>getDone(session.id));
    const untouched=week.sessions.filter(session=>!newById.has(session.id));
    week.sessions=[...rebuilt.filter(session=>!getDone(session.id)),...preserved,...untouched];
    const summary=summarizeManualRuns(manualRunsForWeek(weekPlan,plan));
    week.dist={long:summary.longKm,quality:summary.qualityKm,easy:summary.easyKm};
    week.edited=true;
  });
  cycle.manualPlan=plan;
  cycle.baselines={...plan.baselines};
  save();
  closeManualBlock();
  renderAll();
}

function generateNextCycle(explicitMode){
  const rec = computeRecommendation();
  const mode = explicitMode || modeForAction(rec.action);
  // A normal (non-immediate) generation commits any pending course-correction,
  // so clear the plan-undo. Immediate modes set their own fresh undo inside generateCycle.
  if(mode!=='forceDeload' && mode!=='recovery') DB.meta.planUndo = null;
  generateCycle(mode);
  DB.meta.prevStatus = null; DB.meta.prevStableReturnWeeks = null; // commit: status undo no longer applies
  DB.meta.pendingSettingNote = null; // settings now applied to a generated cycle
  save();
  renderAll();
}
function revertPlanChange(){
  const u = DB.meta.planUndo;
  if(!u) return;
  DB.weeks = u.weeks;
  DB.cycles = u.cycles;
  DB.workspace.qualityRotation = u.rotation;
  DB.meta.planUndo = null;
  save(); renderAll();
}
function rebuildCurrentBlockUI(){
  rebuildCurrentBlock();
  renderAll();
}

function renderUpcomingGroups(weeks){
  const today = isoDate(new Date());
  const byCycle = {};
  weeks.forEach(w=>{ (byCycle[w.cycleNumber] = byCycle[w.cycleNumber] || []).push(w); });
  return Object.keys(byCycle).map(Number).sort((a,b)=>a-b).map(num=>{
    const group = byCycle[num];
    const hasStarted = group.some(w=>w.startDate<=today);
    const removeBtn = hasStarted ? '' : `<button class="remove-cycle-btn" onclick="removeCycleUI(${num})">Remove</button>`;
    let html = `<div class="wgroup-lbl" style="display:flex;justify-content:space-between;align-items:center;"><span>Upcoming · Cycle ${num}</span>${removeBtn}</div>`;
    group.forEach(w=> html += renderWeek(w,false,false));
    return html;
  }).join('');
}

function renderWeeksAndPreview(){
  const today = isoDate(new Date());
  const sorted = [...DB.weeks].sort((a,b)=>a.startDate.localeCompare(b.startDate));
  const current = sorted.find(w=>w.startDate<=today && today<=w.endDate);
  let html = '';

  if(current){
    const idx = sorted.indexOf(current);
    const prev = sorted[idx-1];
    if(prev){ html += `<div class="wgroup-lbl">Previous week</div>` + renderWeek(prev,false,true); }
    html += `<div class="wgroup-lbl">This week</div>` + renderWeek(current,true,false);
    const upcoming = sorted.slice(idx+1);
    if(upcoming.length) html += renderUpcomingGroups(upcoming);
  } else if(sorted.length){
    const past = sorted.filter(w=>w.endDate<today);
    const future = sorted.filter(w=>w.startDate>today);
    if(future.length){
      html += renderUpcomingGroups(future);
    } else {
      html += gapCard();
      const lastPast = past[past.length-1];
      if(lastPast){ html += `<div class="wgroup-lbl">Most recent week on record</div>` + renderWeek(lastPast,false,true); }
    }
  }
  document.getElementById('weeks-root').innerHTML = html;

  // Rough next-cycle preview / generate prompt when runway is short
  const last = sorted[sorted.length-1];
  const runwayDays = last ? (parseDate(last.endDate) - parseDate(today))/86400000 : -1;
  const previewEl = document.getElementById('preview-root');
  if(runwayDays < 10 && !(!current && !last)){
    const rec = computeRecommendation();
    previewEl.innerHTML = `<div class="preview-card">
      <div class="preview-title">Next cycle preview</div>
      <div class="preview-txt">Based on recent completion, the next 4-week cycle would likely ${describeAction(rec.action)}. Generate it whenever you're ready — nothing happens automatically.</div>
      <button class="preview-btn" onclick="generateNextCycle()">Generate next cycle</button>
    </div>`;
  } else {
    previewEl.innerHTML = '';
  }
}

function gapCard(){
  return `<div class="gap-card">
    <div class="preview-title">No plan generated for right now</div>
    <div class="preview-txt">It looks like some time has passed since the last generated week — that happens, and it's fine. A re-entry cycle eases back in rather than resuming the old schedule.</div>
    <button class="preview-btn" onclick="generateNextCycle('recovery')">Generate re-entry cycle</button>
  </div>`;
}

function typeBadgeColor(week){
  if(week.type==='deload') return 'var(--bd)';
  if(week.type==='recovery') return 'var(--am-tx)';
  return [ 'var(--p1)','var(--p2)','var(--p3)' ][week.cycleWeekIndex % 3];
}
function typeLabel(week){
  if(week.edited){
    if(week.type==='deload') return 'Edited · Deload';
    if(week.type==='recovery') return 'Edited · Re-entry';
    return `Edited · Cycle ${week.cycleNumber} · Build ${week.cycleWeekIndex+1}`;
  }
  if(week.type==='deload') return week.manual ? 'Manual · Deload' : 'Deload';
  if(week.type==='recovery') return week.manual ? 'Manual · Re-entry' : 'Re-entry';
  return (week.manual ? 'Manual · ' : '')+'Cycle '+week.cycleNumber+' · Build '+(week.cycleWeekIndex+1);
}

function renderWeek(w, isCurrent, isPast){
  const vol = weekVolume(w);
  const col = typeBadgeColor(w);
  const isOpen = openSet.has(w.id);
  return `<div class="wcard ${isPast?'past':''}">
    <div class="whdr" onclick="toggleOpen('${w.id}')">
      <div class="wbar" style="background:${col}"></div>
      <div class="winfo">
        <div class="wlbl" style="color:${w.type==='deload'?'var(--tx3)':col}">${typeLabel(w)} ${isCurrent?'<span class="wcurr-bdg">THIS WEEK</span>':''}</div>
        <div class="wdates">${fmtRange(w.startDate,w.endDate)}</div>
        <div class="wbdgs">
          ${w.type==='deload'?'<span class="bdg bdg-dl">Deload</span>':''}
          ${w.type==='recovery'?'<span class="bdg bdg-rc">Re-entry</span>':''}
          ${weekDisruptedLabel(w) ? `<span class="bdg bdg-disrupt">${weekDisruptedLabel(w)}</span>` : ''}
        </div>
        <div class="wvol">
          <span style="color:var(--co-tx)">Qual ${vol.q}</span>
          <span style="color:var(--bl-tx)">Long ${vol.lr}</span>
          <span style="color:var(--tx3)">Tot ${vol.tot}</span>
        </div>
      </div>
      <div class="wchev${isOpen?' open':''}">▾</div>
    </div>
    <div class="wbody${isOpen?' open':''}" id="wbody-${w.id}">
      ${isCurrent ? `<button class="edit-block-btn" onclick="openCurrentBlockEditor(${w.cycleNumber})">Edit this block</button>` : ''}
      ${renderCalendar(w)}
    </div>
  </div>`;
}

function renderCalendar(w){
  let html = '';
  const today = isoDate(new Date());
  DAYS.forEach(d=>{
    const dayDate = isoDate(dateForSessionDay(w, {id:'_probe',def:d}));
    const isToday = dayDate===today;
    const daySessions = w.sessions.filter(s=>getDay(s.id,s.def)===d);
    const dayExtras = DB.extras.filter(e=>e.weekId===w.id && e.day===d);
    html += `<div class="day-row ${isToday?'is-today':''}"><div class="day-lbl">${d}</div>`;
    if(daySessions.length===0 && dayExtras.length===0){
      html += `<div class="rest-lbl">Rest</div>`;
    } else {
      daySessions.forEach(s=> html += renderSess(s, w, d));
      dayExtras.forEach(e=> html += renderExtra(e, w, d));
    }
    html += `</div>`;
  });
  html += `<button class="add-wk-btn" onclick="openModal('${w.id}')">＋ Add workout</button>`;
  return html;
}

function renderSess(s, w, currentDay){
  const done = getDone(s.id);
  const tag = TAGS[s.role] || TAGS.easy;
  const adj = sessionAdjustment(s, w);
  const moveOpts = DAYS.map(d=>`<option value="${d}" ${d===currentDay?'selected':''}>Move to ${d}</option>`).join('');
  const parts = [s.warmup, s.main, s.cooldown].filter(Boolean).join(' ');
  const softCls = adj ? (adj.mode==='paused' ? 'soft-paused' : 'soft-ease') : '';
  const note = getSessNote(s.id);
  return `<div class="sess ${done?'done':''} ${softCls}">
    <div class="sess-top">
      <span class="stag" style="background:${tag.bg};color:${tag.tx}">${tag.l}</span>
      ${s.priority==='key' ? '<span class="skey">Key session</span>' : ''}
      ${adj ? `<span class="soft-badge ${adj.mode==='paused'?'paused':''}">${adj.label}</span>` : ''}
      <button class="sdone-btn ${done?'on':''}" onclick="toggleDone('${s.id}','${w.id}')">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><polyline points="1.5,6.5 5,10 11.5,3" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="sdesc">${parts}</div>
    ${adj ? `<div class="soft-note">${adj.note}</div>` : ''}
    ${!adj && s.effortNote ? `<div class="seffort">${s.effortNote}</div>` : ''}
    ${!adj && s.cautionNote ? `<div class="scaution">${s.cautionNote}</div>` : ''}
    ${!adj && s.reducedVersion ? `<div class="sreduced">Reduced option: ${s.reducedVersion}</div>` : ''}
    ${note ? `<div class="snote">📝 ${note}</div>` : ''}
    <div class="sess-ctrls">
      <select class="move-sel" onchange="setSessDay('${s.id}', this.value, '${w.id}')">${moveOpts}</select>
      <button class="edit-btn" onclick="editSessNote('${s.id}','${w.id}')">${note ? 'Edit note' : 'Add note'}</button>
    </div>
  </div>`;
}
function getSessNote(id){ return (DB.overrides.notes && DB.overrides.notes[id]) || ''; }
function editSessNote(id, wid){
  const current = getSessNote(id);
  const val = prompt('Add a note to this run (e.g. route, how you want it to feel, reminders):', current);
  if(val===null) return; // cancelled
  if(!DB.overrides.notes) DB.overrides.notes = {};
  const t = val.trim();
  if(t) DB.overrides.notes[id] = t; else delete DB.overrides.notes[id];
  save(); rerenderBody(wid);
}

function renderExtra(e, w, currentDay){
  const moveOpts = DAYS.map(d=>`<option value="${d}" ${d===currentDay?'selected':''}>Move to ${d}</option>`).join('');
  return `<div class="sess ${e.done?'done':''}">
    <div class="sess-top">
      <span class="stag" style="background:var(--am-bg);color:var(--am-tx)">${e.type}</span>
      <button class="sdone-btn ${e.done?'on':''}" onclick="toggleExtraDone('${e.id}','${w.id}')">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><polyline points="1.5,6.5 5,10 11.5,3" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div class="sdesc">${e.notes ? e.notes : 'Additional workout'}</div>
    <div class="sess-ctrls">
      <select class="move-sel" onchange="setExtraDay('${e.id}', this.value, '${w.id}')">${moveOpts}</select>
      <div>
        <button class="edit-btn" onclick="editExtra('${e.id}','${w.id}')" style="margin-right:10px;">Edit</button>
        <button class="del-btn" onclick="deleteExtra('${e.id}','${w.id}')">Remove</button>
      </div>
    </div>
  </div>`;
}

function rerenderBody(wid){
  const w = DB.weeks.find(x=>x.id===wid); if(!w) return;
  const el = document.getElementById('wbody-'+wid);
  if(el) el.innerHTML = renderCalendar(w);
}
function toggleOpen(wid){ openSet.has(wid) ? openSet.delete(wid) : openSet.add(wid); renderWeeksAndPreview(); }

function findSessionById(id){
  for(const w of DB.weeks){
    const s = (w.sessions||[]).find(x=>x.id===id);
    if(s) return { session:s, week:w };
  }
  return null;
}
// Roles that are runs (worth logging pace/HR for). Extras (gym/other) aren't.
function isRunSession(s){ return s && (s.role==='easy' || s.role==='long' || s.role==='quality'); }

function toggleDone(id,wid){
  const wasDone = getDone(id);
  setDone(id, !wasDone);
  save(); rerenderBody(wid); refreshProgress();
  // When marking a RUN complete (not un-marking), offer the optional log popup
  // pre-filled for that session. Details are entirely optional — there's a
  // "just mark done" path — but it's the natural moment to capture pace/feel.
  if(!wasDone){
    const found = findSessionById(id);
    if(found && isRunSession(found.session)){
      openGarminForSession(found.session, found.week);
    }
  }
}
function toggleExtraDone(id,wid){ const e=DB.extras.find(x=>x.id===id); if(!e) return; e.done=!e.done; save(); rerenderBody(wid); refreshProgress(); }
function setSessDay(id,day,wid){ DB.overrides.days[id]=day; save(); rerenderBody(wid); }
function setExtraDay(id,day,wid){ const e=DB.extras.find(x=>x.id===id); if(!e) return; e.day=day; save(); rerenderBody(wid); }
function deleteExtra(id,wid){ DB.extras = DB.extras.filter(x=>x.id!==id); save(); rerenderBody(wid); refreshProgress(); }

function refreshProgress(){
  const cw = findCurrentWeek();
  if(!cw){ document.getElementById('prog-fill').style.width='0%'; document.getElementById('prog-lbl').textContent='- / -'; return; }
  const extras = DB.extras.filter(e=>e.weekId===cw.id);
  const total = cw.sessions.length + extras.length;
  const done = cw.sessions.filter(s=>getDone(s.id)).length + extras.filter(e=>e.done).length;
  const pct = total ? (done/total*100).toFixed(0) : 0;
  document.getElementById('prog-fill').style.width = pct+'%';
  document.getElementById('prog-lbl').textContent = `${done} / ${total} this week`;
}

function renderRules(){
  const ws = DB.workspace;
  const rules = [
    'Rolling 4-week cycles: three build weeks followed by one deload week, repeated indefinitely.',
    'Deload weeks let the body consolidate adaptations — they are never skipped.',
    'Keep 48–72 hours between heavy strength work and quality/long-run sessions.',
    'If key sessions are repeatedly missed or cut short, the next cycle reduces load instead of pushing through.',
    'Logging a completed activity compares actual pace and distance against the plan, not just done/not-done — that real data feeds pace and load decisions for future cycles.',
    'Missing a week — sickness, travel, life — is a normal part of training. The plan re-enters gently rather than picking up exactly where it left off.'
  ];
  if(DB.cycles.some(c=>c.manualPlan)) rules.push('Manual blocks use the run days, distances, and workout descriptions you chose; the next-block draft is editable before it is added.');
  const focusLine = {
    distance: 'Focus is on building distance: each progression cycle grows volume first, with pace nudged gently.',
    speed: 'Focus is on building speed: each progression cycle pushes pace harder and trims volume slightly so the harder quality work can be absorbed safely.',
    balanced: 'Focus is balanced: each progression cycle grows distance and speed together in moderate steps.'
  }[ws.focus || 'balanced'];
  rules.push(focusLine);
  rules.push(`Phase: ${currentPhase().label}. ${currentPhase().note}`);
  if(ws.otherSportLoad!=='light') rules.push(`Cross-training load is ${ws.otherSportLoad} — run progression is dampened so bike/swim/gym work and running don't stack up.`);
  if(ws.trackSymptoms) rules.push('Weekly wellbeing tracking is on: flagging rough symptoms (poor sleep, low energy, cramps, feeling off) holds progression that week. It never stops you training — it just avoids adding load when you\'re not right.');
  rules.push('Logged effort matters: if RPE, "rough" feels, or heart rate above the intended zone pile up, progression holds even when paces look fine — so a speed push can\'t quietly overreach.');
  if(hrZones(ws.hr)) rules.push('Heart-rate zones are set, so logged runs are checked against the zone each session was meant to sit in.');
  if(ws.returnToRunMode) rules.push('Return-to-run / sensitivity mode is on: progression steps are smaller and slower than standard.');
  if(ws.conservatism==='conservative') rules.push('Conservative progression is set: distance increases are kept modest cycle to cycle.');
  document.getElementById('rules-root').innerHTML = `
    <div class="rules-title">How this plan adapts</div>
    ${rules.map(r=>`<div class="rules-rule"><div class="rules-dot"></div>${r}</div>`).join('')}
  `;
}

function toggleSection(name){
  document.getElementById(name+'-body').classList.toggle('open');
  document.getElementById(name+'-chev').classList.toggle('open');
}

// ══════════════════════════════════════════════════════════════════════════
// SETTINGS SHEET
// ══════════════════════════════════════════════════════════════════════════
let settingsDays = [];
function openSettings(){
  const ws = DB.workspace;
  document.getElementById('set-name').value = ws.name;
  document.getElementById('set-goal').value = ws.goal;
  document.getElementById('set-freq').value = ws.frequency;
  document.getElementById('set-longday').value = ws.longRunDay;
  document.getElementById('set-long').value = ws.baselines.longKm;
  document.getElementById('set-qual').value = ws.baselines.qualityKm;
  document.getElementById('set-easy').value = ws.baselines.easyKm;
  document.getElementById('set-easypace').value = decToClock(ws.paces.easyMin);
  document.getElementById('set-qualpace').value = decToClock(ws.paces.qualityMin);
  document.getElementById('set-cons').value = ws.conservatism;
  document.getElementById('set-rtr').checked = ws.returnToRunMode;
  document.getElementById('set-symptoms').checked = ws.trackSymptoms;
  document.getElementById('set-focus').value = ws.focus || 'balanced';
  document.getElementById('set-phase').value = ws.phase || 'build';
  document.getElementById('set-racedate').value = ws.raceDate || '';
  document.getElementById('set-racedist').value = ws.raceDist || '';
  document.getElementById('set-racegoal').value = ws.raceGoal || '';
  document.getElementById('set-targettime').value = ws.raceTargetTime!=null ? fmtDuration(ws.raceTargetTime) : '';
  onRaceGoalChange();
  document.getElementById('set-racecustomkm').value = ws.raceCustomKm || '';
  onRaceDistChange();
  document.getElementById('set-othersport').value = ws.otherSportLoad || 'light';
  document.getElementById('set-maxhr').value = ws.hr.maxHr || '';
  document.getElementById('set-resthr').value = ws.hr.restHr || '';
  updateHrNote();
  updatePhaseNote();
  settingsDays = [...ws.preferredDays];
  document.querySelectorAll('#set-days button').forEach((b,i)=> b.classList.toggle('on', settingsDays.includes(DAYS[i])));
  document.getElementById('set-maxhr').oninput = updateHrNote;
  document.getElementById('set-resthr').oninput = updateHrNote;
  document.getElementById('set-phase').onchange = updatePhaseNote;
  document.getElementById('settingsModal').classList.add('open');
}
function updatePhaseNote(){
  const p = PHASES[document.getElementById('set-phase').value] || PHASES.build;
  document.getElementById('set-phase-note').textContent = p.note;
}
function updateHrNote(){
  const maxHr = parseFloat(document.getElementById('set-maxhr').value)||null;
  const restHr = parseFloat(document.getElementById('set-resthr').value)||null;
  const zones = hrZones({ maxHr, restHr, customZones: DB.workspace.hr.customZones });
  const note = document.getElementById('set-hr-note');
  if(zones){
    note.textContent = `Derived zones (upper bpm): Z1 ≤${zones[0]} · Z2 ≤${zones[1]} · Z3 ≤${zones[2]} · Z4 ≤${zones[3]} · Z5 >${zones[3]}. Logged heart rate is read against these.`;
  } else {
    note.textContent = 'Add both max and resting heart rate to auto-derive training zones (via heart-rate reserve). Optional.';
  }
}
function toggleSetDay(btn,d){
  if(settingsDays.includes(d)) settingsDays = settingsDays.filter(x=>x!==d);
  else settingsDays.push(d);
  btn.classList.toggle('on');
}
function closeSettings(){ document.getElementById('settingsModal').classList.remove('open'); }
function resetEverything(){
  if(!confirm('Reset everything and start fresh? This permanently clears all plans, settings, logged activities, and history. This cannot be undone.')) return;
  // Second confirm — this is destructive.
  if(!confirm('Are you sure? Everything will be erased.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch(e){}
  DB = defaultDB();
  save();
  closeSettings();
  // Re-run the first-time flow.
  boot();
}
function saveSettings(){
  const ws = DB.workspace;
  // Snapshot progression-affecting settings so we can tell the athlete if a
  // change they just made will apply to the next generated cycle (not the
  // current block, which stays stable by design).
  const before = {
    focus: ws.focus, conservatism: ws.conservatism, returnToRunMode: ws.returnToRunMode,
    longKm: ws.baselines.longKm, qualityKm: ws.baselines.qualityKm, easyKm: ws.baselines.easyKm,
    easyMin: ws.paces.easyMin, qualityMin: ws.paces.qualityMin,
    phase: ws.phase, otherSportLoad: ws.otherSportLoad
  };

  ws.name = document.getElementById('set-name').value.trim() || 'Athlete';
  ws.goal = document.getElementById('set-goal').value.trim() || 'General training';
  ws.frequency = parseInt(document.getElementById('set-freq').value,10);
  ws.longRunDay = document.getElementById('set-longday').value;
  ws.preferredDays = settingsDays.length ? DAYS.filter(d=>settingsDays.includes(d)) : ws.preferredDays;
  ws.baselines.longKm = parseFloat(document.getElementById('set-long').value)||ws.baselines.longKm;
  ws.baselines.qualityKm = parseFloat(document.getElementById('set-qual').value)||ws.baselines.qualityKm;
  ws.baselines.easyKm = parseFloat(document.getElementById('set-easy').value)||ws.baselines.easyKm;
  const easyPaceIn = clockToDec(document.getElementById('set-easypace').value);
  const qualPaceIn = clockToDec(document.getElementById('set-qualpace').value);
  if(easyPaceIn) ws.paces.easyMin = roundPace(easyPaceIn);
  if(qualPaceIn) ws.paces.qualityMin = roundPace(qualPaceIn);
  ws.paces.longMin = ws.paces.easyMin;
  ws.conservatism = document.getElementById('set-cons').value;
  ws.returnToRunMode = document.getElementById('set-rtr').checked;
  ws.trackSymptoms = document.getElementById('set-symptoms').checked;
  ws.focus = document.getElementById('set-focus').value;
  ws.phase = document.getElementById('set-phase').value;
  ws.raceDate = document.getElementById('set-racedate').value || null;
  ws.raceDist = document.getElementById('set-racedist').value || null;
  ws.raceGoal = document.getElementById('set-racegoal').value || null;
  ws.raceTargetTime = parseDuration(document.getElementById('set-targettime').value);
  ws.raceCustomKm = parseFloat(document.getElementById('set-racecustomkm').value) || null;
  ws.otherSportLoad = document.getElementById('set-othersport').value;
  ws.hr.maxHr = parseFloat(document.getElementById('set-maxhr').value)||null;
  ws.hr.restHr = parseFloat(document.getElementById('set-resthr').value)||null;

  // Which progression settings actually changed?
  const changed = [];
  if(before.focus !== ws.focus) changed.push('focus');
  if(before.phase !== ws.phase) changed.push('phase');
  if(before.otherSportLoad !== ws.otherSportLoad) changed.push('cross-training load');
  if(before.conservatism !== ws.conservatism) changed.push('progression');
  if(before.returnToRunMode !== ws.returnToRunMode) changed.push('return-to-run mode');
  if(before.longKm !== ws.baselines.longKm || before.qualityKm !== ws.baselines.qualityKm || before.easyKm !== ws.baselines.easyKm) changed.push('baselines');
  if(before.easyMin !== ws.paces.easyMin || before.qualityMin !== ws.paces.qualityMin) changed.push('paces');
  DB.meta.pendingSettingNote = changed.length ? changed : null;

  save(); closeSettings(); renderAll();
}

// ══════════════════════════════════════════════════════════════════════════
// ADD / EDIT EXTRA WORKOUT MODAL
// ══════════════════════════════════════════════════════════════════════════
let mWeekId=null, mDay='Mon', mType='', mEditId=null;
function openModal(wid){
  mWeekId=wid; mDay='Mon'; mType=''; mEditId=null;
  document.getElementById('modal-title').textContent='Add workout';
  document.getElementById('modal-save-btn').textContent='Add workout';
  const w = DB.weeks.find(x=>x.id===wid);
  document.getElementById('modal-sub').textContent = w ? typeLabel(w)+' · '+fmtRange(w.startDate,w.endDate) : '';
  document.getElementById('modal-notes').value='';
  document.querySelectorAll('#modal-dpick button').forEach((b,i)=>b.classList.toggle('on', i===0));
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.remove('on'));
  document.getElementById('modal').classList.add('open');
}
function editExtra(id, wid){
  const e = DB.extras.find(x=>x.id===id); if(!e) return;
  mWeekId=wid; mDay=e.day; mType=e.type; mEditId=id;
  document.getElementById('modal-title').textContent='Edit workout';
  document.getElementById('modal-save-btn').textContent='Save changes';
  const w = DB.weeks.find(x=>x.id===wid);
  document.getElementById('modal-sub').textContent = w ? typeLabel(w)+' · '+fmtRange(w.startDate,w.endDate) : '';
  document.getElementById('modal-notes').value = e.notes || '';
  document.querySelectorAll('#modal-dpick button').forEach(b=>b.classList.toggle('on', b.textContent.startsWith(mDay.substring(0,2))));
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.toggle('on', b.textContent.includes(mType)));
  document.getElementById('modal').classList.add('open');
}
function closeModal(){ document.getElementById('modal').classList.remove('open'); }
function onOverlayClick(e, id){ if(e.target.id===id) document.getElementById(id).classList.remove('open'); }
function pickModalDay(btn,d){ mDay=d; document.querySelectorAll('#modal-dpick button').forEach(b=>b.classList.toggle('on', b===btn)); }
function pickType(btn,t){ mType=t; document.querySelectorAll('.type-btn').forEach(b=>b.classList.toggle('on', b===btn)); }
function saveWorkout(){
  if(!mType){ alert('Please select a workout type.'); return; }
  const notes = document.getElementById('modal-notes').value.trim();
  if(mEditId){
    const e = DB.extras.find(x=>x.id===mEditId);
    if(e){ e.day=mDay; e.type=mType; e.notes=notes; }
  } else {
    DB.extras.push({ id:'e'+Date.now(), weekId:mWeekId, day:mDay, type:mType, notes, done:false });
  }
  save(); closeModal(); rerenderBody(mWeekId); refreshProgress();
}

// ══════════════════════════════════════════════════════════════════════════
// GARMIN MOCK IMPORT MODAL
// ══════════════════════════════════════════════════════════════════════════
let gRpe = null, gFeel = null;
let gLinkSessionId = null, gLinkWeekId = null;
function openGarmin(){
  gLinkSessionId = null;
  gLinkWeekId = null;
  document.getElementById('g-date').value = isoDate(new Date());
  document.getElementById('g-dist').value = '';
  document.getElementById('g-dur').value = '';
  document.getElementById('g-avghr').value = '';
  document.getElementById('g-maxhr').value = '';
  document.getElementById('g-notes').value = '';
  document.getElementById('g-matches').innerHTML = '';
  gRpe = null; gFeel = null;
  document.querySelectorAll('#g-rpe button').forEach(b=>b.classList.remove('on'));
  ['fresh','ok','rough'].forEach(f=>document.getElementById('g-feel-'+f).classList.remove('on'));
  const t = document.getElementById('g-title'); if(t) t.textContent = 'Log activity';
  const sub = document.getElementById('g-sub'); if(sub) sub.textContent = 'Manual entry today, same import path a future Garmin sync would use.';
  const skip = document.getElementById('g-skip'); if(skip) skip.style.display = 'none';
  document.getElementById('garminModal').classList.add('open');
}
// Opened when a run is marked done. Pre-fills the session's date and planned
// distance and pre-links to it, but everything stays optional — the athlete can
// fill in as much or as little as they like, or skip entirely.
function openGarminForSession(session, week){
  openGarmin();
  gLinkSessionId = session.id;
  gLinkWeekId = week.id;
  // Pre-fill the planned date (session's day within its week) and distance.
  const sDate = dateForSessionDay(week, session);
  document.getElementById('g-date').value = isoDate(sDate);
  if(session.targetDistanceKm) document.getElementById('g-dist').value = session.targetDistanceKm;
  const t = document.getElementById('g-title'); if(t) t.textContent = 'Log this run (optional)';
  const sub = document.getElementById('g-sub'); if(sub) sub.textContent = 'Nice work — it\'s already marked done. Add any details you like to sharpen future plans, or skip.';
  const skip = document.getElementById('g-skip'); if(skip) skip.style.display = '';
  document.getElementById('g-matches').innerHTML = '';
}
function pickRpe(btn, v){ gRpe = v; document.querySelectorAll('#g-rpe button').forEach(b=>b.classList.toggle('on', b===btn)); }
function pickFeel(f){ gFeel = f; ['fresh','ok','rough'].forEach(x=>document.getElementById('g-feel-'+x).classList.toggle('on', x===f)); }
function closeGarmin(){ gLinkSessionId = null; gLinkWeekId = null; document.getElementById('garminModal').classList.remove('open'); }
function skipGarminLog(){ closeGarmin(); } // run already marked done; log nothing

function submitGarmin(){
  const enteredDist = parseFloat(document.getElementById('g-dist').value)||0;
  const activity = {
    date: document.getElementById('g-date').value || isoDate(new Date()),
    distanceKm: enteredDist,
    durationMin: parseFloat(document.getElementById('g-dur').value)||0,
    avgHr: parseFloat(document.getElementById('g-avghr').value)||null,
    maxHr: parseFloat(document.getElementById('g-maxhr').value)||null,
    rpe: gRpe, feel: gFeel,
    notes: document.getElementById('g-notes').value.trim()
  };

  // Session-scoped logging (opened from marking a run done): link straight to
  // that session. The distance may be pre-filled from the plan, so "meaningful
  // data" means duration/HR/RPE/feel/notes — something the athlete actually
  // added. If none, just close; the run is already done, logging is optional.
  if(gLinkSessionId){
    const addedData = activity.durationMin>0 || activity.avgHr || activity.maxHr || activity.rpe!=null || activity.feel || activity.notes;
    if(!addedData){ closeGarmin(); return; }
    const found = findSessionById(gLinkSessionId);
    const result = { id:'r'+Date.now()+'_'+Math.random().toString(36).slice(2,6), ...activity, status:'unlinked', sessionId:null };
    DB.results.push(result);
    if(found) linkResultToSession(result, found.session);
    save();
    document.getElementById('g-matches').innerHTML = `<div class="ctrl-note">${linkFeedbackText(result)}</div>`;
    renderAll();
    setTimeout(closeGarmin, 1600);
    return;
  }

  const { result, candidates, confident } = importActivity(activity);
  if(confident){
    document.getElementById('g-matches').innerHTML = `<div class="ctrl-note">${linkFeedbackText(result)}</div>`;
    renderAll();
    setTimeout(closeGarmin, 1600);
  } else {
    const opts = candidates.map(c=>`<button class="match-item" onclick="manualLinkUI('${result.id}','${c.s.id}')">${c.w.startDate} · ${c.s.title} (${c.s.targetDistanceKm||'?'} km)</button>`).join('');
    document.getElementById('g-matches').innerHTML = `<div class="form-grp"><div class="form-lbl">No confident match — link manually, or just log it:</div><div class="match-list">${opts}<button class="match-item" onclick="closeGarmin()">Just log it, no link</button></div></div>`;
  }
}
function linkFeedbackText(result){
  const bits = ['Linked to a matching planned session and marked complete.'];
  if(result.cutShort) bits.push('Logged distance was notably shorter than planned — this is factored into future load decisions.');
  if(result.paceDeltaMin!=null){
    const secDelta = Math.round(Math.abs(result.paceDeltaMin)*60);
    if(result.paceDeltaMin < -0.05) bits.push(`Ran about ${secDelta} sec/km faster than target — noted for future pace progression.`);
    else if(result.paceDeltaMin > 0.05) bits.push(`Ran about ${secDelta} sec/km slower than target — noted too.`);
  }
  if(result.hrOverZone && result.hrZone!=null) bits.push(`Avg heart rate sat in Z${result.hrZone}, above the Z${result.intendedZone} this session was meant for — worth easing off next time.`);
  return bits.join(' ');
}
function manualLinkUI(resultId, sessionId){
  manualLink(resultId, sessionId);
  const result = DB.results.find(r=>r.id===resultId);
  document.getElementById('g-matches').innerHTML = `<div class="ctrl-note">${linkFeedbackText(result)}</div>`;
  renderAll();
  setTimeout(closeGarmin, 1600);
}

// ══════════════════════════════════════════════════════════════════════════
// ONBOARDING / CALIBRATION INTAKE
// Converts a few real recent-training answers into starting baselines,
// instead of launching everyone on the same flat generic numbers.
// ══════════════════════════════════════════════════════════════════════════
let obPreset = 'consistent';
let obDays = [];
let obIsFirstRun = true;

function openOnboarding(isFirstRun){
  obIsFirstRun = !!isFirstRun;
  const ws = DB.workspace;
  document.getElementById('ob-title').textContent = obIsFirstRun ? "Welcome — let's set up your plan" : "Recalibrate from current level";
  document.getElementById('ob-sub').textContent = obIsFirstRun
    ? "This planner builds you a rolling 4-week running schedule that adapts as you go — it progresses when you're consistent, eases off when life or fatigue gets in the way, and never locks you into a rigid plan. A few quick answers get your first cycle starting at the right level."
    : "Update these based on where things stand today — the current block will be rebuilt to match.";
  document.getElementById('ob-skip-btn').textContent = obIsFirstRun ? 'Skip — use general defaults' : 'Cancel';
  // Intro explainer only makes sense on first run.
  const intro = document.getElementById('ob-intro'); if(intro) intro.style.display = obIsFirstRun ? '' : 'none';

  obPreset = 'consistent';
  document.querySelectorAll('#ob-preset button').forEach(b=>b.classList.toggle('on', b.textContent==='Consistent base already'));
  document.getElementById('ob-name').value = (ws.name && ws.name!=='Athlete') ? ws.name : '';
  // Seed day picker from current preferred days.
  obDays = [...(ws.preferredDays || [])];
  document.querySelectorAll('#ob-days button').forEach((b,i)=> b.classList.toggle('on', obDays.includes(DAYS[i])));
  document.getElementById('ob-longest').value = ws.baselines.longKm;
  document.getElementById('ob-easy').value = ws.baselines.easyKm;
  document.getElementById('ob-hard').value = '';
  document.getElementById('ob-hardtime').value = '';
  document.getElementById('ob-volume').value = '';
  document.getElementById('ob-freq').value = ws.frequency;
  document.getElementById('ob-easypace').value = decToClock(ws.paces.easyMin);
  document.getElementById('ob-qualpace').value = '';
  document.getElementById('ob-focus').value = ws.focus || 'balanced';
  document.getElementById('ob-phase').value = ws.phase || 'build';
  document.getElementById('ob-othersport').value = ws.otherSportLoad || 'light';
  document.getElementById('ob-maxhr').value = ws.hr.maxHr || '';
  document.getElementById('ob-resthr').value = ws.hr.restHr || '';
  document.getElementById('ob-niggle').checked = false;

  document.getElementById('onboardModal').classList.add('open');
}
function pickPreset(btn, key){
  obPreset = key;
  document.querySelectorAll('#ob-preset button').forEach(b=>b.classList.toggle('on', b===btn));
}
function toggleObDay(btn, d){
  if(obDays.includes(d)) obDays = obDays.filter(x=>x!==d);
  else obDays.push(d);
  btn.classList.toggle('on', obDays.includes(d));
  // Keep frequency in sync with day count when the user picks days.
  if(obDays.length>0) document.getElementById('ob-freq').value = Math.min(7, obDays.length);
}
function closeOnboarding(){ document.getElementById('onboardModal').classList.remove('open'); }

function skipOnboarding(){
  if(obIsFirstRun){
    DB.meta.onboarded = true;
    if(DB.weeks.length===0) generateCycle('hold');
    save();
  }
  closeOnboarding();
  renderAll();
}

function applyIntakeAndCalibrate(){
  const longest = parseFloat(document.getElementById('ob-longest').value) || DB.workspace.baselines.longKm;
  const easy = parseFloat(document.getElementById('ob-easy').value) || DB.workspace.baselines.easyKm;
  const hard = parseFloat(document.getElementById('ob-hard').value) || 0;
  const freq = parseInt(document.getElementById('ob-freq').value, 10) || DB.workspace.frequency;
  const niggle = document.getElementById('ob-niggle').checked;
  const preset = EXPERIENCE_PRESETS[obPreset] || EXPERIENCE_PRESETS.consistent;
  const easyPaceIn = clockToDec(document.getElementById('ob-easypace').value);
  const qualPaceIn = clockToDec(document.getElementById('ob-qualpace').value);
  const weeklyVol = parseFloat(document.getElementById('ob-volume').value) || 0;
  const raceTime = clockToDec(document.getElementById('ob-hardtime').value); // mm:ss -> decimal min
  const racePaceQual = raceToQualityPaceMin(hard, raceTime);

  let baselines = computeIntakeBaselines(obPreset, longest, easy, hard);
  // If a real weekly volume was given, scale sessions to match it.
  baselines = scaleBaselinesToVolume(baselines, weeklyVol, freq);
  // Race time (if given) sets quality pace; otherwise fall back to typed/estimated.
  const paces = computeIntakePaces(obPreset, easyPaceIn, racePaceQual || qualPaceIn);
  const ws = DB.workspace;
  // Name (optional).
  const nameIn = (document.getElementById('ob-name').value || '').trim();
  if(nameIn) ws.name = nameIn;
  ws.baselines = baselines;
  ws.paces = paces;
  // Store the recent race (distance + time) so the race achievability check can
  // predict times at other distances via Riegel. Only if both were given.
  if(hard > 0 && raceTime) { ws.calibRaceKm = hard; ws.calibRaceTimeMin = raceTime; }
  ws.frequency = freq;
  // If the athlete chose specific days, honour them (in weekday order) and put
  // the long run on the last chosen day. Otherwise keep/fit existing days.
  if(obDays.length > 0){
    ws.preferredDays = DAYS.filter(d=>obDays.includes(d));
    ws.longRunDay = ws.preferredDays[ws.preferredDays.length-1];
  } else {
    ws.preferredDays = fitPreferredDaysToFrequency(ws.preferredDays, freq, ws.longRunDay);
  }
  ws.conservatism = preset.conservatism;
  ws.returnToRunMode = preset.returnToRunMode;
  ws.focus = document.getElementById('ob-focus').value;
  ws.phase = document.getElementById('ob-phase').value;
  ws.otherSportLoad = document.getElementById('ob-othersport').value;
  ws.hr.maxHr = parseFloat(document.getElementById('ob-maxhr').value)||null;
  ws.hr.restHr = parseFloat(document.getElementById('ob-resthr').value)||null;
  ws.status = niggle ? 'injured' : preset.status;
  DB.meta.onboarded = true;

  const cw = findCurrentWeek();
  if(cw){
    const cycleEntry = DB.cycles.find(c=>c.number===cw.cycleNumber);
    if(cycleEntry){
      if(cycleEntry.manualPlan){
        cycleEntry.paces = { ...paces };
      } else {
        cycleEntry.baselines = { ...baselines };
        cycleEntry.paces = { ...paces };
      }
    }
    rebuildCurrentBlock();
  } else if(DB.weeks.length===0){
    generateCycle('hold');
  }
  save();
  closeOnboarding();
  renderAll();
  maybeShowInstallTutorial();
}

// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
// OFFLINE / PWA SUPPORT
// The manifest is generated at runtime. The companion service worker caches
// this page and its external assets so the app opens offline after installation.
// ══════════════════════════════════════════════════════════════════════════
function setupOffline(){
  if(typeof navigator==='undefined' || typeof document==='undefined' || typeof URL==='undefined' || typeof Blob==='undefined') return;
  try {
    const manifest = {
      name: 'Rolling Training Platform',
      short_name: 'Training',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#ffffff',
      start_url: '.',
      icons: [{
        src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" rx="96" fill="#111"/><text x="256" y="352" font-size="300" text-anchor="middle" font-family="sans-serif">🏃</text></svg>'),
        sizes: '512x512', type: 'image/svg+xml'
      }]
    };
    const mBlob = new Blob([JSON.stringify(manifest)], {type:'application/json'});
    const mLink = document.createElement('link');
    mLink.rel = 'manifest';
    mLink.href = URL.createObjectURL(mBlob);
    document.head.appendChild(mLink);
  } catch(e){}

  // Service worker for offline use + background updates. Browsers don't allow
  // registering a SW from an inline blob, so this expects a small companion
  // file `sw.js` uploaded next to this HTML (e.g. in the GitHub Pages repo).
  // If sw.js isn't present, this fails silently and the app still works online.
  if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost')){
    try { navigator.serviceWorker.register('./sw.js').catch(()=>{}); } catch(e){}
  }
}
setupOffline();

// Auto-hide the header when scrolling down (it's tall on mobile and obstructs
// the plan); reveal it the moment the user scrolls back up or nears the top.
(function(){
  if(typeof window==='undefined' || typeof document==='undefined') return;
  let lastY = 0;
  try {
    window.addEventListener('scroll', function(){
      const hdr = document.querySelector('.hdr');
      if(!hdr) return;
      const y = window.scrollY || 0;
      if(y < 60){ hdr.classList.remove('hdr-hidden'); }
      else if(y > lastY + 6){ hdr.classList.add('hdr-hidden'); }      // scrolling down
      else if(y < lastY - 6){ hdr.classList.remove('hdr-hidden'); }   // scrolling up
      lastY = y;
    }, {passive:true});
  } catch(e){}
})();

// ── Install tutorial (device-aware) ─────────────────────────────────────────
// On first open, if the app isn't already installed (running standalone), show
// a short "Add to Home Screen" guide tailored to the person's device.
function isStandalone(){
  if(typeof window==='undefined') return false;
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || (window.navigator && window.navigator.standalone === true);
}
function detectPlatform(){
  if(typeof navigator==='undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  const android = /Android/.test(ua);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  if(iOS) return safari ? 'ios-safari' : 'ios-other';
  if(android) return 'android';
  return 'desktop';
}
function installStepsHtml(){
  const p = detectPlatform();
  const step = (n,t) => `<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;"><span style="flex-shrink:0;width:22px;height:22px;border-radius:50%;background:var(--tx);color:var(--bg);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;">${n}</span><span style="font-size:13.5px;line-height:1.5;">${t}</span></div>`;
  if(p==='ios-safari')
    return step(1,'Tap the <strong>Share</strong> button (the square with an arrow) at the bottom of Safari.')
         + step(2,'Scroll down and tap <strong>Add to Home Screen</strong>.')
         + step(3,'Tap <strong>Add</strong>. The app appears on your home screen and works offline.');
  if(p==='ios-other')
    return `<div class="ctrl-note" style="padding:0;margin-bottom:10px;">For offline use on iPhone, open this page in <strong>Safari</strong> (not this browser), then:</div>`
         + step(1,'In Safari, tap <strong>Share</strong> → <strong>Add to Home Screen</strong>.')
         + step(2,'Tap <strong>Add</strong>. It then works fully offline.');
  if(p==='android')
    return step(1,'Tap the <strong>⋮ menu</strong> (top-right of your browser).')
         + step(2,'Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong>).')
         + step(3,'Confirm. The app installs and works offline.');
  return step(1,'In your browser menu, choose <strong>Install</strong> or <strong>Add to Home screen / Apps</strong>.')
       + step(2,'Once installed it opens in its own window and works offline.')
       + `<div class="ctrl-note" style="padding:0;margin-top:8px;">On desktop you can also just bookmark this page — it saves your plan locally either way.</div>`;
}
function maybeShowInstallTutorial(){
  try {
    if(isStandalone()) return;                 // already installed
    if(DB.meta && DB.meta.installPromptSeen) return; // shown before
    const el = document.getElementById('install-steps');
    if(el) el.innerHTML = installStepsHtml();
    document.getElementById('installModal').classList.add('open');
    if(DB.meta){ DB.meta.installPromptSeen = true; save(); }
  } catch(e){}
}
function dismissInstall(){ document.getElementById('installModal').classList.remove('open'); }
function showInstallHelp(){ // manual trigger from settings
  const el = document.getElementById('install-steps');
  if(el) el.innerHTML = installStepsHtml();
  document.getElementById('installModal').classList.add('open');
}

boot();
