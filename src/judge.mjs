// The AI judge: a model's opinion of how a build looks, for what software cannot check (lib/benchmark.mjs
// says so in every result). It never passes or fails a build; it is kept apart from the software checks
// and recorded as 'ai-inference', never as observed or verified. Two measures, as BrickBench (arXiv
// 2610.12452) scores agents' brick designs:
//   - prompt questions: the brief is broken into yes/no questions that depend on one another ("is there
//     a dog?" before "is the dog's tail up?"), a model answers them from pictures of the build, and a
//     question counts only when the ones it depends on are yes (Davidsonian scene graphs);
//   - head-to-head ratings: a model picks the better of two builds, for matching the brief ('align') or
//     as a design with no brief ('design'), each pair asked in both orders so the side a build is shown on
//     does not decide it, and Bradley–Terry ratings fitted on the Elo scale with a bootstrap interval.
// BrickBench found its design rating agreed with human raters on 34 of 36 agent pairs; ours is unmeasured
// until people rate a sample, so it is a pointer for designers and the flywheel, not a verdict.
//
// Pure: no DOM, no network, no clock. The requests are { system, text, images, schema }, the shape
// scripts/judge.mjs sends (and makes the calls); the answers are checked here. Randomness is
// seeded, so the same comparisons give the same ratings.

export const JUDGE = { by: 'nooks-ai-judge', version: 1, evidence: 'ai-inference' };
export const MAX_QUESTIONS = 15;
const clip = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- prompt questions

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array', minItems: 1, maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short id, q1, q2, …' },
          text: { type: 'string', description: 'A yes/no question a person could answer from pictures of the build alone.' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier questions that must be yes for this one to make sense.' },
        },
        required: ['id', 'text', 'dependsOn'],
      },
    },
  },
  required: ['questions'],
};

// The brief → its questions. One thing a question; objects first, then their parts, colours, poses and
// how they relate; nothing a picture cannot show (size in real life, what it is made of).
export function questionsRequest(prompt) {
  return {
    system: 'You turn a brief for a model built from toy bricks into yes/no questions that check whether a build matches it. Each question asks one thing a person can see in pictures of the build. Ask first whether each object is there, then about its parts, colours, pose and how objects relate; each of those depends on the question about its object. Do not ask about scale, materials, or anything a picture cannot show. Brick-built shapes are blocky: ask whether a thing reads as itself, not whether it is realistic.',
    text: `The brief:\n${clip(prompt, 4000)}\n\nWrite at most ${MAX_QUESTIONS} questions.`,
    images: [],
    schema: QUESTIONS_SCHEMA,
  };
}

// The model's questions, checked: unique ids, each depending only on earlier ones (so the graph has no
// loops), at most MAX_QUESTIONS. Throws on an answer that cannot be used.
export function checkQuestions(answer) {
  const list = Array.isArray(answer?.questions) ? answer.questions.slice(0, MAX_QUESTIONS) : [];
  const seen = new Set(), out = [];
  for (const q of list) {
    const id = clip(q?.id, 16), text = clip(q?.text, 300);
    if (!id || !text || seen.has(id)) continue;
    out.push({ id, text, dependsOn: [...new Set((Array.isArray(q.dependsOn) ? q.dependsOn : []).map((d) => clip(d, 16)).filter((d) => seen.has(d)))] });
    seen.add(id);
  }
  if (!out.length) throw new Error('The judge wrote no usable questions.');
  return out;
}

const ANSWERS_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, yes: { type: 'boolean' }, why: { type: 'string', description: 'A few words on what in the pictures decided it.' } }, required: ['id', 'yes'] },
    },
  },
  required: ['answers'],
};

// Pictures of one build (data URLs, a few views) and the questions → the request that answers them.
export function answersRequest(questions, images) {
  return {
    system: 'You look at pictures of a model built from toy bricks and answer yes/no questions about it. Answer from what the pictures show. Brick-built shapes are blocky and stylised: say yes when a person would recognise the thing asked about, no when they would not or cannot see it.',
    text: `Answer every question.\n${questions.map((q) => `${q.id}: ${q.text}`).join('\n')}`,
    images: images.filter(Boolean).slice(0, 4),
    schema: ANSWERS_SCHEMA,
  };
}

// The score: the share of questions answered yes whose own dependencies are all yes (a question about
// the dog's tail does not count when there is no dog). A question left unanswered is a no.
export function scoreAnswers(questions, answer) {
  const said = new Map((Array.isArray(answer?.answers) ? answer.answers : []).map((a) => [clip(a?.id, 16), { yes: a?.yes === true, why: clip(a?.why, 200) }]));
  const yes = new Map();
  const per = questions.map((q) => {
    const own = said.get(q.id)?.yes === true, held = q.dependsOn.every((d) => yes.get(d) === true);
    yes.set(q.id, own && held);
    return { id: q.id, text: q.text, yes: own && held, ...(own && !held ? { note: 'Said yes, but a question it depends on was no.' } : {}), why: said.get(q.id)?.why ?? '' };
  });
  return { ...JUDGE, score: Math.round((per.filter((p) => p.yes).length / per.length) * 1000) / 1000, questions: per };
}

// ---- head-to-head ratings

const PAIR_SCHEMA = {
  type: 'object',
  properties: { better: { type: 'string', enum: ['first', 'second', 'tie'] }, why: { type: 'string' } },
  required: ['better'],
};
export const CRITERIA = {
  align: 'Which build matches the brief better: everything it asks for is there and reads clearly, in the right colours and arrangement?',
  design: 'Which is the better design, as a set a designer would be proud of: it reads as its subject at a glance, its shapes and proportions are well judged, its colours work together, and the building techniques are clever and clean? Ignore whether it matches any brief.',
};

// Two builds' pictures (one picture each, its views side by side) → which is better on `criterion`.
// The brief goes in only for 'align'.
export function pairRequest({ criterion, prompt = '', first, second }) {
  if (!CRITERIA[criterion]) throw new Error(`Unknown criterion: ${criterion}.`);
  return {
    system: 'You compare two models built from toy bricks, shown as the first and second picture. Judge only what the pictures show. Say tie only when neither is better.',
    text: `${criterion === 'align' ? `The brief:\n${clip(prompt, 4000)}\n\n` : ''}${CRITERIA[criterion]}`,
    images: [first, second],
    schema: PAIR_SCHEMA,
  };
}

// The two answers for one pair, shown A then B and B then A, as one outcome for A: 1 (A better), 0 (B
// better) or 0.5. Answers that disagree (each picks whichever was shown first, say) are a tie.
export function pairOutcome(abAnswer, baAnswer) {
  const ab = abAnswer?.better === 'first' ? 1 : abAnswer?.better === 'second' ? 0 : 0.5;
  const ba = baAnswer?.better === 'second' ? 1 : baAnswer?.better === 'first' ? 0 : 0.5;
  return (ab + ba) / 2;
}

// Every pair of `players` (ids) to compare, in a seeded order; at most `limit` pairs.
export function schedule(players, { seed = 1, limit = 400 } = {}) {
  const ids = [...new Set(players)], pairs = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
  return shuffle(pairs, rng(seed)).slice(0, limit);
}

// Bradley–Terry ratings from comparisons [{ a, b, outcome }] (outcome for a: 1, 0 or between), on the
// Elo scale (400 points: ten to one odds), the players' mean at 1000. Fitted by minorise–maximise
// (Hunter 2004), a tie half a win to each; every player also gets one tie against a virtual average
// player, so one who won or lost everything still has a finite rating.
export function bradleyTerry(comparisons, { iterations = 500, prior = 1 } = {}) {
  const ids = [...new Set(comparisons.flatMap((c) => [c.a, c.b]))];
  if (!ids.length) return {};
  const at = new Map(ids.map((id, i) => [id, i])), n = ids.length;
  const wins = new Float64Array(n).fill(prior / 2), games = new Map();
  for (const { a, b, outcome } of comparisons) {
    const i = at.get(a), j = at.get(b), o = Math.max(0, Math.min(1, Number(outcome)));
    if (i === j || !Number.isFinite(o)) continue;
    wins[i] += o; wins[j] += 1 - o;
    const k = i < j ? `${i},${j}` : `${j},${i}`;
    games.set(k, (games.get(k) ?? 0) + 1);
  }
  let p = new Float64Array(n).fill(1);
  for (let it = 0; it < iterations; it++) {
    const den = new Float64Array(n).fill(0);
    for (let i = 0; i < n; i++) den[i] += prior / (p[i] + 1);                       // the virtual average player, strength 1
    for (const [k, m] of games) { const [i, j] = k.split(',').map(Number), s = m / (p[i] + p[j]); den[i] += s; den[j] += s; }
    const next = new Float64Array(n);
    let logMean = 0;
    for (let i = 0; i < n; i++) { next[i] = wins[i] / den[i]; logMean += Math.log(next[i]) / n; }
    let moved = 0;
    for (let i = 0; i < n; i++) { const v = next[i] / Math.exp(logMean); moved = Math.max(moved, Math.abs(v - p[i])); next[i] = v; }
    p = next;
    if (moved < 1e-10) break;
  }
  return Object.fromEntries(ids.map((id, i) => [id, Math.round((1000 + 400 * Math.log10(p[i])) * 10) / 10]));
}

// Ratings with a 95% interval: the fit on `samples` resamplings of the comparisons (seeded).
export function ratings(comparisons, { samples = 200, seed = 1, ...fit } = {}) {
  const centre = bradleyTerry(comparisons, fit), random = rng(seed), draws = new Map(Object.keys(centre).map((id) => [id, []]));
  for (let s = 0; s < samples && comparisons.length; s++) {
    const pick = Array.from({ length: comparisons.length }, () => comparisons[Math.floor(random() * comparisons.length)]);
    const r = bradleyTerry(pick, fit);
    for (const id of draws.keys()) if (id in r) draws.get(id).push(r[id]);
  }
  const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))] : null; };
  return Object.fromEntries(Object.entries(centre).sort((a, b) => b[1] - a[1]).map(([id, r]) => [id, { rating: r, low: q(draws.get(id), 0.025), high: q(draws.get(id), 0.975), comparisons: comparisons.filter((c) => c.a === id || c.b === id).length }]));
}

// A small seeded generator (mulberry32) and a shuffle with it.
export function rng(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(list, random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
