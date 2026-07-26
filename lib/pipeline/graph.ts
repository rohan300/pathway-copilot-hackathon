/** Deterministic cross-department graph construction and stall detection. */

import type {
  EdgeKind,
  Extraction,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  InvestigationType,
  NoStallReason,
  PathwayGoal,
  PathwayGraph,
  Stall,
} from "./types";
import { daysBetween, dueDateFrom, EXPECTED_MAX_DAYS, todayISO, typeFromName } from "./stateMachine";

const COMPLETED = new Set(["done", "reported", "actioned"]);
/** Most advanced status wins when the same step appears in several letters. */
const STATUS_RANK: Record<string, number> = {
  unknown: 0,
  ordered: 1,
  booked: 2,
  done: 3,
  reported: 4,
  actioned: 5,
};
const FALLBACK_GOAL_LABEL = "Treatment decision";

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^(the|a)$/, "");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function sentenceCase(value: string): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function dateOrNull(value: string | null | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Oldest of the dates given, ignoring nulls. Requests merge to the earliest. */
function earliest(...dates: (string | null | undefined)[]): string | null {
  return dates.filter((date): date is string => Boolean(dateOrNull(date))).sort()[0] ?? null;
}

function rank(status: string): number {
  return STATUS_RANK[status] ?? 0;
}

/** "2026-07-21" -> "21 Jul 2026", for sentences the UI renders as-is. */
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function humanDate(iso: string | null): string {
  if (!iso) return "an unrecorded date";
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

// ---------------------------------------------------------------------------
// Naming — the same step written up in different words
// ---------------------------------------------------------------------------

/**
 * Letters name the same step many ways: "CT thorax" and "CT chest", a bare
 * "Bronchoscopy" and the theatre system's "Fibrooptic bronchoscopy (SURG) -
 * Diagnostic fibreoptic endoscopic examination…". Matching on the whole string
 * makes each one its own node, so we compare only the tokens that say WHICH
 * step it is, having dropped the ones that merely restate the type or the
 * paperwork around it.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "with", "his", "her",
  "their", "him", "them", "is", "was", "were", "are", "be", "been", "by", "from", "pre",
  "post", "including", "include", "includes", "plus", "also", "as", "he", "she",
]);

/** Words about how a step was written up, not which step it is. */
const GENERIC_TOKENS = new Set([
  "test", "tests", "scan", "scans", "study", "studies", "examination", "exam", "imaging",
  "result", "results", "report", "reports", "routine", "urgent", "additional", "new",
  "planned", "sample", "samples", "screen", "investigation", "investigations", "full",
  "referral", "referred", "refer",
]);

/** Organisational nouns — "TB team clearance" and "TB clinic clearance" are one step. */
const ORG_TOKENS = new Set([
  "team", "clinic", "clinics", "service", "services", "department", "dept", "unit",
  "ward", "hospital", "centre", "center",
]);

/** Tokens that only echo the investigation type they are already filed under. */
const TYPE_ECHO: Record<InvestigationType, string[]> = {
  ct: ["ct", "computed", "tomography", "contrast", "noncontrast"],
  mri: ["mri", "magnetic", "resonance"],
  xray: ["xray", "x", "ray", "radiograph", "radiography", "film"],
  bronchoscopy: ["bronchoscopy", "bronchoscopic", "bronchoscope", "fibreoptic", "fibrooptic", "diagnostic", "endoscopic", "endoscopy"],
  bloods: ["blood", "bloods", "serology", "profile", "panel", "bloodtest"],
  consult: ["consult", "consultation", "appointment", "attendance"],
  other: [],
};

/** Spellings the letters use interchangeably. */
const SYNONYMS: Record<string, string> = {
  thorax: "chest",
  thoracic: "chest",
  cxr: "chest",
  abdo: "abdomen",
  abdominal: "abdomen",
  prebiological: "biologic",
  prebiologic: "biologic",
  biological: "biologic",
  biologics: "biologic",
  fbc: "fullbloodcount",
  lft: "liverfunction",
  cleared: "clearance",
  clear: "clearance",
  clearing: "clearance",
  followup: "followup",
  fu: "followup",
};

/**
 * Blood panels letters name either as a whole or by listing their parts. The
 * pre-treatment infection screen is written as "pre-biologic screening bloods"
 * in one letter and as "Lipids, TB, HIV, Varicella, Hep B, Hep C" in the next;
 * they are one step being chased, not six. Scoped to blood tests deliberately —
 * a token like "TB" says something quite different about a culture or a clinic,
 * so nothing outside this modality is folded together on it.
 */
const BLOODS_CONCEPTS: Record<string, string> = {
  prebiologic: "biologicscreen",
  biologic: "biologicscreen",
  tb: "biologicscreen",
  hiv: "biologicscreen",
  varicella: "biologicscreen",
  vzv: "biologicscreen",
  quantiferon: "biologicscreen",
  igra: "biologicscreen",
  hepatitis: "biologicscreen",
  hep: "biologicscreen",
  lipid: "biologicscreen",
  cholesterol: "biologicscreen",
};

/**
 * Clinic shorthand written out in full, applied only when the shorthand is the
 * WHOLE name of a step. "FU 4 weeks" in a plan line gives a step whose entire
 * label is "FU", and a pathway that tells a patient "FU is 4 days overdue" has
 * told them nothing. Expanding a fragment of a longer label is not attempted —
 * that way lies rewriting a clinician's words.
 */
const LABEL_EXPANSIONS: Record<string, string> = {
  fu: "Follow-up",
  "f/u": "Follow-up",
  cxr: "Chest X-ray",
  lft: "Liver function tests",
  lfts: "Liver function tests",
  fbc: "Full blood count",
  obs: "Observations",
  mdt: "MDT discussion",
};

/** The name a step is shown under, with whole-label shorthand written out. */
function displayLabel(name: string): string {
  const expanded = LABEL_EXPANSIONS[name.trim().toLowerCase()];
  return expanded ?? sentenceCase(name);
}

/** A modifier that marks a fresh instance of a step already carried out. */
const REPEAT_MARKER = /\b(repeat|repeated|re-?do|further|another|interval|surveillance|second)\b/i;

/** Crude plural stripping — enough to make "bloods" and "blood" one token. */
function stem(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es") && !word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The tokens that identify WHICH step this is, for the given investigation type. */
function stepTokens(name: string, invType: InvestigationType | null): Set<string> {
  const echo = new Set((invType ? TYPE_ECHO[invType] : []).map(stem));
  const out = new Set<string>();
  for (const raw of name.toLowerCase().split(/[^a-z0-9]+/)) {
    // A one-character word never says which step this is. Letters list panels
    // as "Hep B, Hep C", and counting the B and the C as identifying tokens
    // made that list disagree with the same screen named any other way.
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    const word = stem(SYNONYMS[raw] ?? raw);
    if (!word || STOPWORDS.has(word) || GENERIC_TOKENS.has(word) || ORG_TOKENS.has(word)) continue;
    if (echo.has(word) || echo.has(raw)) continue;
    if (REPEAT_MARKER.test(raw)) continue;
    out.add(invType === "bloods" ? BLOODS_CONCEPTS[word] ?? word : word);
  }
  return out;
}

/**
 * Two same-type steps are the same step when neither carries a qualifier that
 * contradicts the other: one token set contains the other, or they mostly
 * overlap. An empty set means the letter named the type and nothing else
 * ("CT scan"), which matches any CT.
 */
function sameStep(a: Set<string>, b: Set<string>, requireOverlap = false): boolean {
  // An empty set names a modality and nothing else. Inside one modality that
  // means "any CT", which is the intent; across referrals there is no modality
  // to fall back on, so a contentless label like "referred for investigations"
  // would otherwise swallow every referral in the file.
  if (!a.size || !b.size) return !requireOverlap;
  const shared = [...a].filter((token) => b.has(token)).length;
  if (!shared) return false;
  if (shared === a.size || shared === b.size) return true;
  return shared / new Set([...a, ...b]).size >= 0.5;
}

/**
 * The words that say WHICH goal or item this is, with the ones that only say
 * that it *is* a goal stripped out. "Start filgotinib", "filgotinib
 * commencement" and "commencement of Filgotinib medication" are one intent;
 * "clear him for his UC treatment" is a different one.
 */
const INTENT_TOKENS = new Set([
  "start", "starting", "started", "commence", "commencement", "commencing",
  "begin", "beginning", "initiate", "initiation", "approve", "approval",
  "fund", "funding", "prescribe", "prescription", "treatment", "treat",
  "therapy", "medication", "medicine", "drug", "patient", "soon", "possible",
  "need", "needs", "get", "give", "given", "put", "before", "after", "once",
]);

function intentKey(value: string): string {
  const words = value.toLowerCase().split(/[^a-z0-9]+/).flatMap((raw) => {
    if (!raw || STOPWORDS.has(raw)) return [];
    const word = stem(SYNONYMS[raw] ?? raw);
    if (!word || STOPWORDS.has(word) || GENERIC_TOKENS.has(word) || ORG_TOKENS.has(word)) return [];
    if (INTENT_TOKENS.has(word) || INTENT_TOKENS.has(raw)) return [];
    return [word];
  });
  return [...new Set(words)].sort().join(" ");
}

/**
 * Letterheads name themselves as departments ("Respiratory Medicine Clinic
 * Letter"). The document type is not the owning team.
 */
function normalizeDept(dept: string | null): string | null {
  if (!dept) return null;
  const trimmed = dept.replace(/\s*\b(clinic\s+letter|letter|clinic)\s*$/i, "").trim();
  return trimmed || dept.trim() || null;
}

/**
 * Specialties the letters name in more than one way — a respiratory clinic
 * letterheaded "Pulmonology" is the same team as one letterheaded "Respiratory
 * Medicine". Deliberately narrow: a sub-team like "TB team" is NOT folded into
 * respiratory, because a letter from the wider service is not the answer the TB
 * team specifically owes.
 */
const DEPT_SYNONYMS: Record<string, string> = {
  pulmonology: "respiratory",
  pulmonary: "respiratory",
  gastroenterologist: "gastro",
  gastroenterology: "gastro",
};

/** The words that say WHICH team a letter or referral belongs to. */
function deptKey(dept: string | null): Set<string> {
  const out = new Set<string>();
  for (const raw of (dept || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw) || ORG_TOKENS.has(raw)) continue;
    const word = DEPT_SYNONYMS[raw] ?? raw;
    if (word === "medicine" || word === "letter" || word === "consultant") continue;
    out.add(word);
  }
  return out;
}

/** A step one letter promises, and what that letter says it is working toward. */
interface PromisedStep {
  node: GraphNode;
  statedGoal: string | null;
  letterDate: string | null;
}

/**
 * Close the blockers the treating team has moved past.
 *
 * Letters restate what the goal is waiting on as a pathway progresses: on 2 Mar
 * it is the screening bloods, by 23 Jun it is TB clearance. The team writing the
 * later letter knows what they are still waiting for, so a step they have
 * stopped naming is one the pathway got past — not one silently outstanding
 * since March. Without this, every superseded loose end stays open forever and
 * the OLDEST of them, being by then the most overdue, is reported as the
 * bottleneck ahead of the thing the clinic is actually chasing.
 *
 * Deliberately narrow. Only steps the letters put directly in front of the goal
 * are closed — named as blocking it, or promised by a letter working toward it —
 * and only by a later letter that put something DIFFERENT in front of the same
 * goal. A step nobody ever placed there is untouched, and whatever the most
 * recent letter named is exactly what stays open.
 *
 * A step the letters place UPSTREAM of something still being waited on is not
 * superseded either — it is the reason that thing is still being waited on. A
 * repeat CT that a letter says the clearance depends on is not moved past by a
 * later letter saying the treatment depends on the clearance; they are the same
 * statement, one link further along.
 */
function closeSupersededBlockers(
  blockers: Array<{ node: GraphNode; letterDate: string | null }>,
  edges: GraphEdge[],
) {
  const latest = blockers.reduce<string | null>(
    (newest, entry) => (entry.letterDate && (!newest || entry.letterDate > newest) ? entry.letterDate : newest),
    null,
  );
  if (!latest) return;
  const stillNamed = new Set(
    blockers.filter((entry) => entry.letterDate === latest).map((entry) => entry.node.id),
  );

  /** Whether this step leads, along stated links, to anything still waited on. */
  const feedsStillNamed = (start: GraphNode): boolean => {
    const seen = new Set([start.id]);
    const queue = [start.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of edges) {
        if (edge.from !== current || seen.has(edge.to)) continue;
        if (stillNamed.has(edge.to)) return true;
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
    return false;
  };

  for (const { node, letterDate } of blockers) {
    if (stillNamed.has(node.id) || COMPLETED.has(node.status)) continue;
    if (!letterDate || letterDate >= latest) continue;
    if (feedsStillNamed(node)) continue;
    node.status = "actioned";
  }
}

/**
 * Close the steps a later letter proves already happened.
 *
 * A referral is answered once the department it points at writes a letter of its
 * own — otherwise every historic referral stays "ordered" forever and reports as
 * the oldest bottleneck long after the clinic actually took place. A promised
 * follow-up appointment closes on the same evidence, because a clinic letter IS
 * what an appointment produces: a review promised on 12 May and followed by that
 * team's letter on 23 June happened, a week early, and is not still owed. Without
 * this a pathway accumulates every review it has ever had and chases the oldest.
 *
 * A clearance is deliberately exempt. It is a decision another team owes back in
 * writing, and the fact that they wrote *a* letter is not the fact that they gave
 * it — inferring otherwise closes the very thing the pathway is waiting on.
 */
function closeFulfilledAppointments(
  nodes: GraphNode[],
  ordered: Extraction[],
  dependencyText: Set<string>,
) {
  for (const node of nodes) {
    const appointment =
      node.kind === "referral" || (node.kind === "investigation" && node.invType === "consult");
    if (!appointment || !node.dept || COMPLETED.has(node.status)) continue;
    if (/\bclear(ance|ed)?\b/i.test(node.label)) continue;
    // A step a letter explicitly says something is awaiting stays open until a
    // letter says otherwise — the words beat the inference.
    const label = compact(node.label);
    if ([...dependencyText].some((text) => text.includes(label) || label.includes(text))) continue;
    const promised = startDate(node);
    const target = deptKey(node.dept);
    if (!target.size || !promised) continue;
    const answered = ordered.some((extraction) => {
      const from = deptKey(extraction.department);
      if (![...from].some((token) => target.has(token))) return false;
      // Strictly later: the letter that made the promise cannot also keep it.
      return Boolean(extraction.letter_date && extraction.letter_date > promised);
    });
    if (answered) node.status = "actioned";
  }
}

function expectedDays(kind: GraphNodeKind, invType: GraphNode["invType"]): number | null {
  const value = EXPECTED_MAX_DAYS[invType || kind];
  return typeof value === "number" ? value : null;
}

function makeNode(input: {
  id: string;
  label: string;
  dept: string | null;
  kind: GraphNodeKind;
  invType?: GraphNode["invType"];
  status: string;
  ordered_date?: string | null;
  report_date?: string | null;
  dateSource?: GraphNode["dateSource"];
}): GraphNode {
  const invType = input.invType ?? null;
  const ordered = dateOrNull(input.ordered_date);
  const report = dateOrNull(input.report_date);
  return {
    id: input.id,
    label: input.label,
    dept: normalizeDept(input.dept),
    kind: input.kind,
    invType,
    status: input.status,
    ordered_date: ordered,
    report_date: report,
    expected_days: expectedDays(input.kind, invType),
    // Recomputed in finalize() once every letter has merged its dates in.
    timelineDate: report || ordered,
    dateSource: ordered || report ? input.dateSource ?? "written" : null,
    dueDate: null,
    overdue: null,
  };
}

/** Whether the stated links already lead from one step to another. */
function reaches(edges: GraphEdge[], fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.from !== current || seen.has(edge.to)) continue;
      if (edge.to === toId) return true;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return false;
}

function addEdge(
  edges: GraphEdge[],
  from: GraphNode | undefined,
  to: GraphNode | undefined,
  kind: EdgeKind,
) {
  if (!from || !to || from.id === to.id) return;
  if (!edges.some((edge) => edge.from === from.id && edge.to === to.id && edge.kind === kind)) {
    edges.push({ from: from.id, to: to.id, kind });
  }
}

/**
 * Resolve a name a letter uses for a step to the node that step became.
 * Letters (and the extractor's own per-letter ids) refer to the same step
 * loosely, so this widens in three passes and stops at the first hit: the exact
 * normalized label, a containment match, then the identifying tokens.
 */
function findNode(
  nodes: GraphNode[],
  text: string | null | undefined,
  options: { preferOpen?: boolean } = {},
): GraphNode | undefined {
  if (!text) return undefined;
  // Extractor ids carry a "-N" uniqueness suffix that the prose reference does not.
  const cleaned = text.replace(/-\d+$/, "");
  const wanted = compact(cleaned);
  if (!wanted) return undefined;
  const exact = nodes.find((node) => compact(node.label) === wanted);
  if (exact) return exact;
  // Both sides must be long enough for a substring hit to mean anything: "FU"
  // is inside "Liver FUnction Tests", and matching those would hang a clinic's
  // promised follow-up date on a blood test.
  //
  // Containment stops being an answer the moment two nodes contain the phrase.
  // "filgotinib" sits inside "Start filgotinib" and equally inside a referral
  // reason that recounts the whole case, and taking whichever came first hung
  // the goal's own dependencies off a paragraph of background. The label closest
  // in length to the phrase is the one that names this step and little else, so
  // that is the one the reference meant.
  const contained = nodes
    .filter((node) => {
      const label = compact(node.label);
      return label.length > 3 && wanted.length > 3 && (label.includes(wanted) || wanted.includes(label));
    })
    .sort(
      (a, b) =>
        Math.abs(compact(a.label).length - wanted.length) - Math.abs(compact(b.label).length - wanted.length),
    );
  if (contained.length) return contained[0];

  // Last pass: the words that say WHICH step this is. Demanding the two sets
  // match exactly meant "repeat CT scan of his chest" found neither the CT chest
  // already on the graph nor anything else, and a dependency the letters wrote
  // down was silently dropped. So the sets only have to agree — one covering the
  // other, or a clear majority in common — and the closest fit wins, which keeps
  // a partial overlap like "clearance" from attaching itself to any clearance in
  // the file when a better-matching one exists.
  const key = intentKey(cleaned);
  if (!key) return undefined;
  const wantedTokens = new Set(key.split(" ").filter(Boolean));
  const scored = nodes
    .map((node) => {
      const tokens = new Set(intentKey(node.label).split(" ").filter(Boolean));
      if (!tokens.size) return null;
      const shared = [...wantedTokens].filter((token) => tokens.has(token)).length;
      if (!shared) return null;
      const union = new Set([...wantedTokens, ...tokens]).size;
      const agrees = shared === wantedTokens.size || shared === tokens.size || shared / union >= 0.5;
      return agrees ? { node, shared, union } : null;
    })
    .filter((entry): entry is { node: GraphNode; shared: number; union: number } => entry !== null)
    .sort((a, b) => {
      // A reference to something being waited on means the step still open, not
      // the one already carried out under a similar name.
      if (options.preferOpen) {
        const openA = Number(!COMPLETED.has(a.node.status));
        const openB = Number(!COMPLETED.has(b.node.status));
        if (openA !== openB) return openB - openA;
      }
      return b.shared - a.shared || a.union - b.union;
    });
  return scored[0]?.node;
}

/**
 * The steps a phrase names, allowing for a letter naming two of them in one
 * breath: "repeat CT scan of his chest and TB culture negative at six weeks" is
 * two things being waited on, not one step with a long name.
 *
 * Splitting is only ever used to RESOLVE a reference against steps that already
 * exist — no half of a phrase becomes a node of its own — so a phrase whose
 * halves name nothing behaves exactly as it did before.
 */
function findNodes(
  nodes: GraphNode[],
  text: string | null | undefined,
  options: { preferOpen?: boolean } = {},
): GraphNode[] {
  if (!text) return [];
  const parts = text.split(/\s+\band\b\s+/i).map((part) => part.trim()).filter(Boolean);
  const found: GraphNode[] = [];
  for (const part of parts.length > 1 ? parts : [text]) {
    const node = findNode(nodes, part, options);
    if (node && !found.includes(node)) found.push(node);
  }
  return found;
}

/** Letters sorted oldest-first; undated letters keep their upload order at the front. */
function byLetterDate(extractions: Extraction[]): Extraction[] {
  return extractions
    .map((extraction, index) => ({ extraction, index }))
    .sort((a, b) => {
      const left = a.extraction.letter_date || "";
      const right = b.extraction.letter_date || "";
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((item) => item.extraction);
}

/**
 * The goal is whatever the LETTERS are working toward — never a hardcoded
 * label. The model only ever supplies the NAME; which name wins is decided
 * here, deterministically.
 *
 * The naive rule — take the newest letter's stated goal — hands the pathway to
 * whichever department happened to write last. On a cross-department pathway
 * that is exactly wrong: the respiratory team's "clear him for his UC
 * treatment" is a step toward the gastro team's treatment, not the destination.
 * So goals are grouped by what they actually name, and the group that the most
 * letters work toward wins, with the letters' stated dependencies breaking ties
 * in favour of something nothing else is waiting on.
 */
function inferGoal(ordered: Extraction[]): { label: string; dept: string | null; source: PathwayGoal["source"] } {
  const blockingKeys = new Set(
    ordered.flatMap((extraction) => extraction.dependencies.map((item) => intentKey(item.blocking_item))),
  );

  /** Stated goals grouped by what they name, keeping every letter that names it. */
  const groups = new Map<string, { label: string; dept: string | null; letters: number }>();
  for (const extraction of ordered) {
    const stated = extraction.stated_goal?.trim();
    if (!stated) continue;
    const key = intentKey(stated);
    if (!key) continue;
    const group = groups.get(key);
    if (!group) {
      // First letter to name it is the one whose department owns it — a goal is
      // owned by the team that set it, not by whoever wrote about it last.
      groups.set(key, { label: stated, dept: extraction.department, letters: 1 });
      continue;
    }
    group.letters += 1;
    // Keep the plainest phrasing of the name the letters agree on.
    if (stated.length < group.label.length) group.label = stated;
  }

  if (groups.size) {
    const ranked = [...groups.entries()].sort(([keyA, a], [keyB, b]) => {
      // Something the letters say is itself blocking something else is a step,
      // not the destination.
      const terminalA = Number(!blockingKeys.has(keyA));
      const terminalB = Number(!blockingKeys.has(keyB));
      if (terminalA !== terminalB) return terminalB - terminalA;
      if (a.letters !== b.letters) return b.letters - a.letters;
      return a.label.length - b.label.length;
    });
    const [, winner] = ranked[0];
    return { label: sentenceCase(winner.label), dept: winner.dept, source: "stated" };
  }

  // No letter states an intent. A dependency chain terminates in the thing
  // nothing else blocks: that is the goal, in the letters' own words.
  const latestFirst = [...ordered].reverse();
  for (const extraction of latestFirst) {
    for (const dependency of [...extraction.dependencies].reverse()) {
      if (!blockingKeys.has(intentKey(dependency.blocked_item))) {
        // The team that named the dependency owns what it is working toward.
        const owner = ordered.find((item) =>
          item.dependencies.some((entry) => intentKey(entry.blocked_item) === intentKey(dependency.blocked_item)),
        );
        return {
          label: sentenceCase(dependency.blocked_item),
          dept: owner?.department || extraction.department,
          source: "derived",
        };
      }
    }
  }

  // Treatment intent written as prose: "start filgotinib", "commence infliximab".
  for (const extraction of latestFirst) {
    const prose = [
      ...extraction.findings.map((finding) => finding.text),
      ...extraction.mdt.flatMap((mdt) => [mdt.outcome, mdt.awaiting]),
      ...extraction.referrals.map((referral) => referral.reason),
    ].filter((text): text is string => Boolean(text));
    for (const text of prose) {
      const started = text.match(/\b(?:start|commence|initiate|begin)\s+(?:on\s+)?([A-Za-z][A-Za-z0-9-]{3,})/i);
      if (started) return { label: `Start ${started[1].toLowerCase()}`, dept: extraction.department, source: "derived" };
      const therapy = text.match(/\b(advanced medical therapy|biologic therapy|biological therapy)\b/i);
      if (therapy) return { label: `Start ${therapy[1].toLowerCase()}`, dept: extraction.department, source: "derived" };
    }
  }

  const latest = latestFirst[0];
  return { label: FALLBACK_GOAL_LABEL, dept: latest?.department ?? null, source: "fallback" };
}

/** The date a step is timed from — when it was asked for, else when it landed. */
function startDate(node: GraphNode): string | null {
  return node.ordered_date || node.report_date;
}

/** The date a step is placed on the timeline — when it happened, else when it was asked for. */
function timelineOf(node: GraphNode): string | null {
  return node.report_date || node.ordered_date;
}

function outgoing(graph: PathwayGraph, id: string): GraphEdge[] {
  return graph.edges.filter((edge) => edge.from === id);
}

/**
 * The shortest route from `start` to the goal along the dependencies the
 * letters actually state.
 *
 * Every edge here is stated, so there is nothing to weigh: chronological
 * adjacency is deliberately NOT an edge. A chest X-ray happening before a CT
 * does not mean the CT was waiting on it, and inferring that — especially
 * across departments — invents a clinical causation no letter wrote down. The
 * timeline gets its order from `timelineDate`; the graph only ever says a step
 * blocks another when a letter said so.
 */
function bestPath(graph: PathwayGraph, start: GraphNode): { path: GraphNode[] } | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>([start.id]);
  const queue: GraphNode[][] = [[start]];
  while (queue.length) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    if (current.id === graph.goal.nodeId) return { path };
    for (const edge of outgoing(graph, current.id)) {
      const next = byId.get(edge.to);
      if (!next || seen.has(next.id)) continue;
      seen.add(next.id);
      queue.push([...path, next]);
    }
  }
  return null;
}

function pathToGoal(graph: PathwayGraph, start: GraphNode): GraphNode[] | null {
  return bestPath(graph, start)?.path ?? null;
}

/**
 * Build a graph from independent, per-letter extractions. `asOf` only decides
 * which open steps are already past due; the nodes, edges and chain are the
 * same whatever day it is.
 */
export function buildGraph(extractions: Extraction[], asOf = todayISO()): PathwayGraph {
  const ordered = byLetterDate(extractions);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sourceFindings: Array<{
    on: string | null;
    spawned: string | null;
    /** The naming letter's own investigation ids — an exact reference beats a fuzzy one. */
    local: Map<string, GraphNode>;
  }> = [];
  const sourceDependencies: Array<{
    dependency: Extraction["dependencies"][number];
    letterDate: string | null;
    dept: string | null;
  }> = [];
  const sourceMdts: Array<{ date: string | null; outcome: string | null; awaiting: string | null }> = [];
  /** Every node a given letter contributed, for the date-ordered fallback. */
  const dependencyText = new Set(
    ordered.flatMap((extraction) =>
      extraction.dependencies.flatMap((item) => [compact(item.blocked_item), compact(item.blocking_item)]),
    ),
  );

  /** Identifying tokens per node, so the same step is recognised across letters. */
  const tokensById = new Map<string, Set<string>>();
  /** Follow-ups deferred until every step exists to attach them to. */
  const sourceFollowUps: SourceFollowUp[] = [];

  for (const extraction of ordered) {
    /**
     * This letter's own investigation ids, so its findings resolve exactly.
     * Keyed both with and without the extractor's "-N" uniqueness suffix,
     * because a finding cites the id the model wrote before that was added.
     */
    const localNodes = new Map<string, GraphNode>();
    const remember = (id: string, node: GraphNode) => {
      localNodes.set(id, node);
      localNodes.set(id.replace(/-\d+$/, ""), node);
    };

    for (const investigation of extraction.investigations) {
      const key = stepTokens(investigation.name, investigation.type);
      const isRepeat = REPEAT_MARKER.test(investigation.name);
      const completed = COMPLETED.has(investigation.status);
      const matches = nodes.filter((node) =>
        node.kind === "investigation" &&
        node.invType === investigation.type &&
        sameStep(tokensById.get(node.id)!, key),
      );
      const open = matches.find((node) => !COMPLETED.has(node.status));
      const done = matches.find((node) => COMPLETED.has(node.status));
      // Stage decides WHICH instance a mention joins; only the letters' own
      // word for it opens a second one.
      //
      // A repeat is a genuinely new step — an 18 Apr CT that was reported and a
      // repeat CT still outstanding are two things, and collapsing them loses
      // the whole "it was done, and another is now pending" story. So a repeat
      // takes the open instance, never the finished one.
      //
      // Everything else is the same step being written up again. A later letter
      // restating a request for something the graph already shows as reported is
      // recounting history, not ordering it a second time: letters name the same
      // test at every stage it passes through, and almost none of them write an
      // order date, so treating each restatement as a fresh request manufactured
      // a duplicate step per mention. It joins the open instance if one is
      // running, and otherwise the finished one.
      const existing = isRepeat ? open : completed ? done ?? open : open ?? done;

      // A step named without a date of its own is still evidence of itself on
      // the date of the letter that named it: a 6 Feb letter asking for a chest
      // X-ray dates that request to 6 Feb. Which field it lands in follows the
      // status — something already carried out is dated as reported, not
      // requested, so a test written up second-hand in a later letter still
      // becomes a completed step at its own date.
      const writtenOrdered = dateOrNull(investigation.ordered_date);
      const writtenReport = dateOrNull(investigation.report_date);
      const orderedDate = writtenOrdered ?? (completed ? null : extraction.letter_date);
      const reportDate = writtenReport ?? (completed ? extraction.letter_date : null);
      const derived = !writtenOrdered && !writtenReport;

      if (existing) {
        // Earliest request date, latest known status (a step is asked for once
        // and reported once, however many letters mention it).
        existing.report_date = earliest(existing.report_date, reportDate);
        // A date borrowed from the letter that restated a step is not allowed to
        // claim it was asked for AFTER it was carried out. A June letter listing
        // a chest X-ray reported in March is recounting it, and dating the
        // request to June would put the request after its own result.
        const merged = earliest(existing.ordered_date, orderedDate);
        if (!(merged && existing.report_date && merged > existing.report_date)) {
          existing.ordered_date = merged;
        }
        if (rank(investigation.status) > rank(existing.status)) existing.status = investigation.status;
        if (!derived) existing.dateSource = "written";
        // A fuller name from a later letter still describes the same step.
        for (const token of key) tokensById.get(existing.id)!.add(token);
        remember(investigation.id, existing);
        continue;
      }

      // One letter naming several tests of the same kind, on the same date and
      // at the same stage, is describing ONE act — a single blood draw listed
      // panel by panel. Chasing "Renal Profile" apart from "Full Blood Count"
      // taken from the same arm on the same morning is noise, not a pathway.
      const sameEvent = !isRepeat && localNodes.size
        ? [...new Set(localNodes.values())].find((node) =>
            node.invType === investigation.type &&
            node.ordered_date === orderedDate &&
            node.report_date === reportDate &&
            COMPLETED.has(node.status) === completed,
          )
        : undefined;
      if (sameEvent) {
        sameEvent.label = `${sameEvent.label}, ${investigation.name}`;
        if (rank(investigation.status) > rank(sameEvent.status)) sameEvent.status = investigation.status;
        for (const token of key) tokensById.get(sameEvent.id)!.add(token);
        remember(investigation.id, sameEvent);
        continue;
      }

      const node = makeNode({
        id: `investigation:${slug(investigation.name)}-${nodes.length + 1}`,
        label: investigation.name,
        dept: extraction.department,
        kind: "investigation",
        invType: investigation.type,
        status: investigation.status,
        ordered_date: orderedDate,
        report_date: reportDate,
        dateSource: derived ? "letter" : "written",
      });
      nodes.push(node);
      tokensById.set(node.id, key);
      remember(investigation.id, node);
    }

    // A finding is a RESULT, and a result is not a step anyone can chase. It
    // belongs to the investigation it came off, and where it caused the next
    // step it is the join between the two. So a finding is an edge and never a
    // node: "right upper zone consolidation" is why the repeat CT was asked
    // for, not a thing sitting in a queue waiting to be done. Making nodes of
    // them put un-actionable prose on the pathway and, worse, inserted a step
    // into the chain between the investigation and what it led to.
    for (const finding of extraction.findings) {
      sourceFindings.push({ on: finding.on_investigation, spawned: finding.spawned, local: localNodes });
    }

    for (const referral of extraction.referrals) {
      // A referral is the act of asking another team to take this on, and that
      // is what it is named for. The reason a letter gives is often a paragraph
      // of case history — real prose, but not the name of a step, and making a
      // node out of each one is what buried the pathway under restated
      // background ("needs to be under the care of an NHS clinic moving
      // forwards" is not something anyone can chase). The one reason that IS a
      // step is a clearance, because that is a decision the other team owes back.
      const team = referral.to_dept || referral.from_dept || "Department";
      const label = /\bclear(ance|ed)?\b/i.test(referral.reason || "")
        ? `${team} clearance`
        : `${team} referral`;
      const key = stepTokens(label, null);
      const existing = nodes.find((node) =>
        node.kind === "referral" && sameStep(tokensById.get(node.id)!, key, true),
      );
      if (existing) {
        existing.ordered_date = earliest(existing.ordered_date, referral.date || extraction.letter_date);
        continue;
      }
      const node = makeNode({
        id: `referral:${slug(label)}`,
        label,
        dept: referral.to_dept,
        kind: "referral",
        status: "ordered",
        ordered_date: referral.date || extraction.letter_date,
        dateSource: referral.date ? "written" : "letter",
      });
      nodes.push(node);
      tokensById.set(node.id, key);
    }

    for (const mdt of extraction.mdt) {
      sourceMdts.push({ date: mdt.date, outcome: mdt.outcome, awaiting: mdt.awaiting });
    }
    for (const dependency of extraction.dependencies) {
      sourceDependencies.push({ dependency, letterDate: extraction.letter_date, dept: extraction.department });
    }
    for (const followUp of extraction.follow_ups ?? []) {
      sourceFollowUps.push({
        followUp,
        letterDate: extraction.letter_date,
        dept: extraction.department,
        statedGoal: extraction.stated_goal ?? null,
      });
    }
  }

  // The goal is derived from the letters; reuse a node that already carries the
  // same label rather than appending a duplicate terminal.
  const inferred = inferGoal(ordered);
  const existingGoal = nodes.find((node) => compact(node.label) === compact(inferred.label));
  const goalNode = existingGoal ?? makeNode({
    id: `approval:${slug(inferred.label)}`,
    label: inferred.label,
    dept: inferred.dept,
    kind: "approval",
    status: "awaiting",
  });
  if (!existingGoal) nodes.push(goalNode);
  const goal: PathwayGoal = {
    nodeId: goalNode.id,
    label: goalNode.label,
    dept: goalNode.dept,
    source: inferred.source,
  };

  // A finding joins the step it was reported on to the step it caused. The
  // reference is resolved against the naming letter's own investigation ids
  // first, since those are exact where a prose match is a guess.
  const resolve = (local: Map<string, GraphNode>, text: string | null) => {
    if (!text) return undefined;
    return local.get(text) ?? local.get(text.replace(/-\d+$/, "")) ?? findNode(nodes, text);
  };
  for (const finding of sourceFindings) {
    addEdge(edges, resolve(finding.local, finding.on), resolve(finding.local, finding.spawned), "spawned_by");
  }

  // Explicit “awaiting X before Y” relationships are stated dependency edges;
  // the LLM does not invent these joins.
  /** Steps a letter names as blocking the goal, with the date it said so. */
  const statedGoalBlockers: Array<{ node: GraphNode; letterDate: string | null }> = [];
  for (const { dependency, letterDate, dept } of sourceDependencies) {
    let blocked = findNodes(nodes, dependency.blocked_item, { preferOpen: true });
    // A letter saying other steps are waited on BEFORE this one happens is the
    // letter telling us this is a step. "Clear him for his UC treatment" is a
    // decision the respiratory team owes, and it exists on the pathway whether
    // or not any other sentence in the file happened to name it as an
    // investigation or a referral. Only the blocked side earns a node this way:
    // it is a destination the letters commit to, where an unresolved BLOCKING
    // phrase is usually background prose about why.
    if (!blocked.length) {
      const node = makeNode({
        id: `approval:${slug(dependency.blocked_item)}-${nodes.length + 1}`,
        label: sentenceCase(dependency.blocked_item),
        dept,
        kind: "approval",
        status: "awaiting",
        ordered_date: letterDate,
        dateSource: "letter",
      });
      nodes.push(node);
      blocked = [node];
    }
    const blocking = findNodes(nodes, dependency.blocking_item, { preferOpen: true });
    const kind: EdgeKind = /await/i.test(dependency.stated_status || "") ? "awaiting" : "blocks";
    for (const from of blocking) {
      for (const to of blocked) {
        addEdge(edges, from, to, kind);
        if (to.id === goalNode.id) statedGoalBlockers.push({ node: from, letterDate });
      }
    }
  }


  // Letters written by different teams name different destinations, and only one
  // of them can be the goal. The others are not wrong — they are what that team
  // is working toward on the way there. The respiratory team's "clear him for
  // his UC treatment" IS a step toward the gastro team's filgotinib, and saying
  // so is the letters' own claim, not a judgement of ours about which team
  // matters. Without it a cross-department pathway splits into two disconnected
  // halves, and the half holding everything up is the one that never reaches the
  // goal — so nothing can be reported as blocking anything.
  //
  // Runs after the dependency pass, because that is where a destination no other
  // sentence names becomes a node.
  for (const extraction of ordered) {
    const stated = extraction.stated_goal?.trim();
    if (!stated || intentKey(stated) === intentKey(goalNode.label)) continue;
    addEdge(edges, findNode(nodes, stated, { preferOpen: true }), goalNode, "blocks");
  }

  // MDT awaiting fields are also explicit joins when present. Reuse an
  // existing node instead of creating a duplicate clearance node.
  for (const mdt of sourceMdts) {
    const awaiting = findNode(nodes, mdt.awaiting);
    const outcome = findNode(nodes, mdt.outcome);
    if (awaiting && outcome) addEdge(edges, awaiting, outcome, "awaiting");
  }

  const { dueBasis, promised } = applyFollowUps(nodes, sourceFollowUps, tokensById);

  // A follow-up is promised BY a letter that says, in the same breath, what it is
  // working toward — "FU 4 weeks" in the TB clinic's letter is a step toward
  // clearing him, and the repeat CT the respiratory team asked for is a step
  // toward starting filgotinib. Both halves are the letter's own words, so
  // joining them claims nothing extra; without the join the step a clinic
  // promised and never delivered floats off the pathway and cannot be reported
  // as holding anything up, which is exactly the item most worth chasing.
  for (const { node, statedGoal, letterDate } of promised) {
    const toward = (statedGoal && findNode(nodes, statedGoal, { preferOpen: true })) || goalNode;
    // Only where the letters left the step unconnected. A step already routed to
    // the goal through stated dependencies has a route with the intermediate
    // steps ON it, and adding a direct link would give the shortest path a
    // shortcut past exactly the steps that explain why it matters.
    if (reaches(edges, node.id, toward.id)) continue;
    addEdge(edges, node, toward, "blocks");
    if (toward.id === goalNode.id) statedGoalBlockers.push({ node, letterDate });
  }

  closeSupersededBlockers(statedGoalBlockers, edges);

  // After the promised appointments exist, so a review the letters commit to is
  // closed by the same evidence that closes a referral.
  closeFulfilledAppointments(nodes, ordered, dependencyText);

  const graph: PathwayGraph = {
    nodes,
    edges,
    goal,
    chainIds: [],
    // What the LETTERS state, not what survived edge resolution: a dependency
    // naming a step we never turned into a node still means these letters are
    // the kind that write dependencies down.
    statedDependencies: sourceDependencies.length > 0 || sourceMdts.some((mdt) => Boolean(mdt.awaiting)),
  };
  graph.chainIds = chainIds(graph);
  finalize(graph, dueBasis, asOf);
  return graph;
}

/**
 * Fill in the derived per-node fields once every letter has merged its dates in:
 * where the step sits on the timeline, and whether it is late. Done in one pass
 * at the end so a node that gained a date from a later letter is never left
 * carrying the answer computed before that letter was read.
 */
function finalize(graph: PathwayGraph, dueBasis: Map<string, string>, asOf: string) {
  for (const node of graph.nodes) {
    node.timelineDate = timelineOf(node);
    const daysOverdue = node.id === graph.goal.nodeId ? null : overdueBy(node, asOf);
    node.overdue = daysOverdue === null ? null : { daysOverdue, basis: overdueBasis(node, dueBasis, asOf) };
  }
}

/**
 * The sentence the UI prints verbatim to say why a step counts as late. A date
 * the letters actually promised is quoted back in their own words, because that
 * is what the clinic committed to; otherwise it is the generic expected wait,
 * and it says so rather than implying a promise nobody made.
 */
function overdueBasis(node: GraphNode, dueBasis: Map<string, string>, asOf: string): string {
  const stated = dueBasis.get(node.id);
  const due = node.dueDate ? humanDate(node.dueDate) : humanDate(asOf);
  return stated
    ? `Due ${due} — ${stated} — and still outstanding on ${humanDate(asOf)}.`
    : `Due ${due} and still outstanding on ${humanDate(asOf)}.`;
}

/** A wait one letter promises, with the context of the letter that promised it. */
interface SourceFollowUp {
  followUp: NonNullable<Extraction["follow_ups"]>[number];
  letterDate: string | null;
  dept: string | null;
  /** What that letter says it is working toward, so the promise joins the pathway. */
  statedGoal: string | null;
}

/**
 * Turn the waits the letters promise in words into dates on the steps they
 * promise them for. "FU 4 weeks" in a letter of 23 Jun is a due date of 21 Jul;
 * "culture negative at six weeks" counted from a bronchoscopy is six weeks from
 * the day that bronchoscopy happened. The interval is transcribed by the model
 * and turned into a date here, so a phrase we cannot parse leaves the step on
 * its generic expected wait rather than on an invented deadline.
 *
 * A promised follow-up with no step of its own becomes one: an appointment the
 * letters commit to is a pathway step, and it is the one most likely to be the
 * thing nobody has booked.
 */
function applyFollowUps(
  nodes: GraphNode[],
  followUps: SourceFollowUp[],
  tokensById: Map<string, Set<string>>,
): { dueBasis: Map<string, string>; promised: PromisedStep[] } {
  /** node id -> the letter's own words for how its due date was arrived at. */
  const dueBasis = new Map<string, string>();
  /** Each promised step with what the letter promising it was working toward. */
  const promised: PromisedStep[] = [];
  for (const { followUp, letterDate, dept, statedGoal } of followUps) {
    // "budesonide 9 mg daily FOR THE NEXT 8 weeks" says how long a course runs,
    // not when anything is owed back. A duration is not a deadline, and reading
    // one as a deadline puts a breach on the record that no clinic ever
    // promised — the course finishing is the treatment working, not a step
    // nobody booked.
    if (followUp.phrase && /^\s*for\b/i.test(followUp.phrase)) continue;
    const anchorNode = followUp.from ? findNode(nodes, followUp.from) : undefined;
    const anchor = (anchorNode && timelineOf(anchorNode)) || letterDate;
    const due = followUp.due_date ?? (anchor && followUp.phrase ? dueDateFrom(anchor, followUp.phrase) : null);
    if (!due) continue;

    const basis = followUp.due_date
      ? `stated as due ${humanDate(followUp.due_date)}`
      : `"${followUp.phrase}" from ${anchorNode ? `${anchorNode.label} on ` : ""}${humanDate(anchor)}`;

    // A letter promises two things in one line as readily as one — "chest x-ray
    // and cholesterol and lipid profile next week" is three steps already on the
    // pathway, and treating the sentence as a single unnamed step invented a
    // fourth that nobody ordered and then reported it as months late.
    const named = findNodes(nodes, followUp.item, { preferOpen: true });
    // The letters promise the NEXT one; a step already carried out keeps its own
    // dates. When every step the line names is done, the promise is kept — there
    // is nothing left to be due.
    let targets = named.filter((node) => !COMPLETED.has(node.status));
    if (!named.length) {
      const label = displayLabel(followUp.item);
      // A promised item is filed under the type its NAME implies, not assumed to
      // be an appointment: "repeat non-contrast CT" is the CT already on the
      // graph waiting to be done, and giving it a due date of its own as a
      // separate consult would show the same scan twice.
      const invType = typeFromName(followUp.item);
      const key = stepTokens(label, invType);
      // "other" is what the namer says when it cannot tell WHICH kind of step
      // this is — it is not a kind of its own. Filtering on it looked for the
      // promised step only among the steps we equally failed to classify, so a
      // promise whose wording we do not recognise could never find the step it
      // was promising and always invented a second one. Unknown type means the
      // type does not narrow the search; it does not mean the search is empty.
      //
      // With no type to narrow on, the words have to carry the match on their
      // own, so an overlap is required: an empty token set means "any step of
      // this type", which without a type would mean any step at all.
      const unknownType = invType === "other";
      let target = nodes.find((node) =>
        node.kind === "investigation" &&
        (unknownType || node.invType === invType) &&
        !COMPLETED.has(node.status) &&
        sameStep(tokensById.get(node.id) ?? new Set(), key, unknownType),
      );
      if (!target) {
        target = makeNode({
          id: `investigation:${slug(label)}-${nodes.length + 1}`,
          label,
          dept,
          kind: "investigation",
          invType,
          status: "ordered",
          ordered_date: letterDate,
          dateSource: "letter",
        });
        nodes.push(target);
        tokensById.set(target.id, key);
      }
      targets = [target];
    }
    for (const target of targets) {
      promised.push({ node: target, statedGoal, letterDate });
      // Earliest promise wins: the first date it was due is the date it is late from.
      if (!target.dueDate || due < target.dueDate) {
        target.dueDate = due;
        dueBasis.set(target.id, basis);
      }
    }
  }
  return { dueBasis, promised };
}

/**
 * Whether any letter states what the goal is waiting on.
 *
 * Real letters often write a whole pathway without ever putting "X before Y" on
 * paper. When that happens there is nothing to demote against: calling a step
 * off-pathway would be our judgement, not the letters'. So this decides whether
 * the graph is entitled to demote anything at all, and whether a late step can
 * be named as the blocker without a stated route to prove it.
 */
function goalHasStatedRoute(graph: PathwayGraph): boolean {
  return graph.statedDependencies;
}

/**
 * Nodes that actually reach the goal, in date order, ending at the goal.
 *
 * With no stated dependency anywhere, every step stays on the chain — see
 * `goalHasStatedRoute`. Findings are evidence hanging off a step and are never
 * chain members in their own right.
 */
function chainIds(graph: PathwayGraph): string[] {
  const stated = goalHasStatedRoute(graph);
  const onChain = graph.nodes
    .filter((node) => node.id !== graph.goal.nodeId)
    .filter((node) => (stated ? pathToGoal(graph, node) !== null : node.kind !== "finding"))
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const left = timelineOf(a.node) || "9999-12-31";
      const right = timelineOf(b.node) || "9999-12-31";
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((item) => item.node.id);
  return [...onChain, graph.goal.nodeId];
}

/**
 * Whether an open step is late, and by how much.
 *
 * Only a date the letters actually promised makes a step overdue. The generic
 * per-type expected wait says what is typical, and typical is not a commitment:
 * calling a step late because it passed an average we invented puts a number on
 * a clinical timeline that nobody in the letters ever agreed to. "FU 4 weeks" is
 * what the clinic committed to, and it is the only kind of number the patient
 * can hold them to. No stated interval, no flag.
 */
function overdueBy(node: GraphNode, asOf: string): number | null {
  if (COMPLETED.has(node.status)) return null;
  if (!node.dueDate) return null;
  return asOf > node.dueDate ? daysBetween(node.dueDate, asOf) : null;
}

/**
 * How long an open step has been waiting beyond what should have taken.
 *
 * A stated due date is a promise and takes precedence. Where the letters promise
 * nothing, the generic expected wait for that kind of step is used instead —
 * because a pathway whose letters never wrote an interval down still stalls, and
 * refusing to name a bottleneck in that case reports "nothing is wrong" about a
 * referral nobody has answered in three months. The distinction is not lost:
 * only a stated promise ever sets `node.overdue`, so nothing is shown to a
 * patient as late against a deadline no clinic agreed to, and a stall on a
 * generic wait says as much in its own words.
 */
function lateBy(node: GraphNode, asOf: string): number | null {
  const stated = overdueBy(node, asOf);
  if (stated !== null) return stated;
  if (COMPLETED.has(node.status) || node.dueDate) return null;
  const since = startDate(node);
  if (!since || node.expected_days === null) return null;
  const waited = daysBetween(since, asOf);
  return waited > node.expected_days ? waited - node.expected_days : null;
}

/** Every open step now past what it should have taken, longest waiting first. */
function overdueNodes(graph: PathwayGraph, asOf: string): GraphNode[] {
  return graph.nodes
    .filter((node) => node.id !== graph.goal.nodeId && lateBy(node, asOf) !== null)
    .sort((a, b) => (lateBy(b, asOf) ?? 0) - (lateBy(a, asOf) ?? 0));
}

/**
 * The single overdue step holding up the goal. One bottleneck is reported, not
 * a list; every other late step keeps its own `overdue` on the node, so nothing
 * is hidden — it is just not called THE blocker, which by definition there is
 * one of.
 *
 * Ranking is the longest overdue first, then the earliest promised date. The
 * worst breach of a promise the clinic actually made is the thing to chase, and
 * both numbers come from dates the letters wrote down rather than from any
 * judgement of ours about which department matters more.
 */
export function findStall(graph: PathwayGraph, asOf = todayISO()): Stall | null {
  const overdue = overdueNodes(graph, asOf);
  const goalNode = graph.nodes.find((node) => node.id === graph.goal.nodeId);
  if (!goalNode) return null;
  // With no stated dependency anywhere, nothing can prove a route to the goal —
  // and nothing contradicts one either. The late step is then reported as
  // blocking the goal directly, which claims no more than the letters support.
  const stated = goalHasStatedRoute(graph);
  const candidates = overdue
    .map((node) => ({
      node,
      route: stated ? bestPath(graph, node) : { path: [node, goalNode] },
      days: lateBy(node, asOf) ?? 0,
    }))
    .filter((entry): entry is { node: GraphNode; route: { path: GraphNode[] }; days: number } =>
      entry.route !== null,
    );
  if (!candidates.length) return null;

  const ranked = [...candidates].sort((a, b) => {
    // A promise the clinic actually made outranks an average nobody agreed to,
    // however long the average has been exceeded. A referral quietly sitting
    // past its typical wait since January is not a worse breach than a culture
    // result the TB clinic committed to a date for and has not delivered.
    const promisedA = Number(Boolean(a.node.dueDate));
    const promisedB = Number(Boolean(b.node.dueDate));
    if (promisedA !== promisedB) return promisedB - promisedA;
    if (a.days !== b.days) return b.days - a.days;
    // Same lateness: the one promised earliest is the one that has been waited
    // on longest, so it is the one to chase.
    const left = a.node.dueDate || startDate(a.node) || "";
    const right = b.node.dueDate || startDate(b.node) || "";
    return left === right ? a.node.label.localeCompare(b.node.label) : left < right ? -1 : 1;
  });
  const { node: root, route, days: daysOverdue } = ranked[0];

  const sinceDate = startDate(root);
  // Named alongside the bottleneck: only the other steps with a date the letters
  // actually promised. Everything merely past a typical wait belongs on the
  // timeline, not in a sentence telling a patient what is late — that list runs
  // to every referral in the file and says nothing.
  const alsoOpen = overdue.filter((node) => node.id !== root.id && node.overdue);
  const owner = root.dept || graph.goal.dept;
  const explanation =
    `${graph.goal.label} cannot go ahead until ${root.label} is resolved.` +
    `${owner ? ` ${owner} owns it.` : ""}` +
    `${root.overdue ? ` ${root.overdue.basis}` : ""}` +
    (alsoOpen.length ? ` Also outstanding: ${alsoOpen.map((node) => node.label).join(", ")}.` : "");

  return {
    stalledNode: root,
    chain: route.path,
    owningDept: owner,
    sinceDate,
    daysStalled: sinceDate ? daysBetween(sinceDate, asOf) : 0,
    expectedDays: root.expected_days,
    dueDate: root.dueDate,
    daysOverdue,
    explanation,
  };
}

/**
 * Why findStall returned null. "No bottleneck" and "we could not compute one"
 * look identical to a user otherwise — this says which it was.
 */
export function explainNoStall(graph: PathwayGraph, asOf = todayISO()): NoStallReason {
  const steps = graph.nodes.filter((node) => node.id !== graph.goal.nodeId);
  if (!steps.some((node) => startDate(node) !== null)) {
    return {
      code: "no_dated_nodes",
      message: "No letter gives a date for any step, so nothing can be timed against its expected wait.",
    };
  }
  const open = steps.filter((node) => !COMPLETED.has(node.status));
  if (!open.length) {
    return {
      code: "nothing_overdue",
      message: "Every step the letters name is complete — nothing is outstanding.",
    };
  }
  const late = open.filter((node) => lateBy(node, asOf) !== null);
  if (late.length && !late.some((node) => pathToGoal(graph, node) !== null)) {
    return {
      code: "no_path_to_goal",
      message: `No open step connects to the goal (${graph.goal.label}), so nothing can be shown as blocking it.`,
    };
  }
  return {
    code: "nothing_overdue",
    message: "Every open step is still inside its expected window — nothing is past its expected wait.",
  };
}
