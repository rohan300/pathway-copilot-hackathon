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
    if (!raw || STOPWORDS.has(raw)) continue;
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

function addEdge(
  edges: GraphEdge[],
  from: GraphNode | undefined,
  to: GraphNode | undefined,
  kind: EdgeKind,
  inferred = false,
) {
  if (!from || !to || from.id === to.id) return;
  if (!edges.some((edge) => edge.from === from.id && edge.to === to.id && edge.kind === kind)) {
    edges.push(inferred ? { from: from.id, to: to.id, kind, inferred: true } : { from: from.id, to: to.id, kind });
  }
}

/**
 * Resolve a name a letter uses for a step to the node that step became.
 * Letters (and the extractor's own per-letter ids) refer to the same step
 * loosely, so this widens in three passes and stops at the first hit: the exact
 * normalized label, a containment match, then the identifying tokens.
 */
function findNode(nodes: GraphNode[], text: string | null | undefined): GraphNode | undefined {
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
  const contained = nodes.find((node) => {
    const label = compact(node.label);
    return label.length > 3 && wanted.length > 3 && (label.includes(wanted) || wanted.includes(label));
  });
  if (contained) return contained;
  const key = intentKey(cleaned);
  return key ? nodes.find((node) => intentKey(node.label) === key) : undefined;
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
 * The best route from `start` to the goal, preferring routes the letters
 * actually state over ones we inferred from dates alone. Cost is the number of
 * inferred edges, then the number of hops — so "the letters say this blocks the
 * treatment" always beats "this merely happened before it".
 */
function bestPath(graph: PathwayGraph, start: GraphNode): { path: GraphNode[]; inferred: number } | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const best = new Map<string, number>([[start.id, 0]]);
  const queue: Array<{ id: string; path: GraphNode[]; inferred: number }> = [
    { id: start.id, path: [start], inferred: 0 },
  ];
  let found: { path: GraphNode[]; inferred: number } | null = null;
  while (queue.length) {
    queue.sort((a, b) => (a.inferred - b.inferred) || (a.path.length - b.path.length));
    const current = queue.shift()!;
    if (found && current.inferred >= found.inferred) break;
    if (current.id === graph.goal.nodeId) {
      found = { path: current.path, inferred: current.inferred };
      continue;
    }
    for (const edge of outgoing(graph, current.id)) {
      const next = byId.get(edge.to);
      if (!next) continue;
      const cost = current.inferred + (edge.inferred ? 1 : 0);
      if ((best.get(next.id) ?? Infinity) <= cost) continue;
      best.set(next.id, cost);
      queue.push({ id: next.id, path: [...current.path, next], inferred: cost });
    }
  }
  return found;
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
    node: GraphNode;
    on: string | null;
    spawned: string | null;
    /** The naming letter's own investigation ids — an exact reference beats a fuzzy one. */
    local: Map<string, GraphNode>;
  }> = [];
  const sourceDependencies: Extraction["dependencies"] = [];
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
  const sourceFollowUps: Array<{ followUp: NonNullable<Extraction["follow_ups"]>[number]; letterDate: string | null; dept: string | null }> = [];

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
      // A letter reporting a result fills in the request already on the graph.
      // A letter still asking for something that the graph shows as DONE is
      // asking again — a repeat CT after an abnormal one is a new step, not a
      // completed one reopening. Pathways move forward.
      const existing = isRepeat
        ? matches.find((node) => !COMPLETED.has(node.status))
        : completed
          ? matches.find((node) => COMPLETED.has(node.status)) ?? matches.find((node) => !COMPLETED.has(node.status))
          : matches.find((node) => !COMPLETED.has(node.status));

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
        existing.ordered_date = earliest(existing.ordered_date, orderedDate);
        existing.report_date = earliest(existing.report_date, reportDate);
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

    for (const finding of extraction.findings) {
      // Background prose is not a pathway step, and neither is a result: a
      // result belongs to the investigation it came off. A finding earns a node
      // only when it JOINS two steps — it caused the next one — or the letters
      // name it in a dependency.
      const connective = Boolean(finding.spawned) || dependencyText.has(compact(finding.text));
      if (!connective) continue;
      const existing = nodes.find((node) => node.kind === "finding" && compact(node.label) === compact(finding.text));
      if (existing) {
        sourceFindings.push({ node: existing, on: finding.on_investigation, spawned: finding.spawned, local: localNodes });
        continue;
      }
      const node = makeNode({
        id: `finding:${slug(finding.text)}-${nodes.length + 1}`,
        label: finding.text,
        dept: extraction.department,
        kind: "finding",
        status: "reported",
        ordered_date: extraction.letter_date,
        dateSource: "letter",
      });
      nodes.push(node);
      sourceFindings.push({ node, on: finding.on_investigation, spawned: finding.spawned, local: localNodes });
    }

    for (const referral of extraction.referrals) {
      const label = /clearance/i.test(referral.reason || "")
        ? `${referral.to_dept || "Department"} clearance`
        : referral.reason || `${referral.to_dept || "Department"} referral`;
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
    sourceDependencies.push(...extraction.dependencies);
    for (const followUp of extraction.follow_ups ?? []) {
      sourceFollowUps.push({ followUp, letterDate: extraction.letter_date, dept: extraction.department });
    }
  }

  // A referral is answered once the department it points at writes a later
  // letter — otherwise every historic referral stays "ordered" forever and
  // reports as the oldest bottleneck long after the clinic actually happened.
  for (const node of nodes) {
    if (node.kind !== "referral" || !node.dept) continue;
    // A referral a letter explicitly says something is awaiting stays open
    // until a letter says otherwise — the words beat the inference.
    const label = compact(node.label);
    if ([...dependencyText].some((text) => text.includes(label) || label.includes(text))) continue;
    const sent = startDate(node);
    const answered = ordered.some((extraction) => {
      const dept = compact(extraction.department || "");
      const target = compact(node.dept!);
      if (!dept || !target || !(dept.includes(target) || target.includes(dept))) return false;
      return Boolean(extraction.letter_date && sent && extraction.letter_date >= sent);
    });
    if (answered) node.status = "actioned";
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

  // A finding is attached to the investigation on which it was reported and
  // points to the investigation it spawned. Both edges are factual joins. The
  // reference is resolved against the naming letter's own investigation ids
  // first, since those are exact where a prose match is a guess.
  const resolve = (local: Map<string, GraphNode>, text: string | null) => {
    if (!text) return undefined;
    return local.get(text) ?? local.get(text.replace(/-\d+$/, "")) ?? findNode(nodes, text);
  };
  for (const finding of sourceFindings) {
    addEdge(edges, resolve(finding.local, finding.on), finding.node, "spawned_by");
    addEdge(edges, finding.node, resolve(finding.local, finding.spawned), "spawned_by");
  }

  // Explicit “awaiting X before Y” relationships are stated dependency edges;
  // the LLM does not invent these joins.
  for (const dependency of sourceDependencies) {
    const blocked = findNode(nodes, dependency.blocked_item);
    const blocking = findNode(nodes, dependency.blocking_item);
    const kind: EdgeKind = /await/i.test(dependency.stated_status || "") ? "awaiting" : "blocks";
    addEdge(edges, blocking, blocked, kind);
  }

  // MDT awaiting fields are also explicit joins when present. Reuse an
  // existing node instead of creating a duplicate clearance node.
  for (const mdt of sourceMdts) {
    const awaiting = findNode(nodes, mdt.awaiting);
    const outcome = findNode(nodes, mdt.outcome);
    if (awaiting && outcome) addEdge(edges, awaiting, outcome, "awaiting");
  }

  const dueBasis = applyFollowUps(nodes, sourceFollowUps, tokensById);

  const graph: PathwayGraph = { nodes, edges, goal, chainIds: [] };
  connectTimeline(graph);
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
  if (node.dueDate && stated) {
    return `Due ${humanDate(node.dueDate)} — ${stated} — and still outstanding on ${humanDate(asOf)}.`;
  }
  const since = startDate(node);
  return since && node.expected_days !== null
    ? `Open since ${humanDate(since)} — ${daysBetween(since, asOf)} days against an expected ${node.expected_days}. No letter promises a date for it.`
    : `Outstanding on ${humanDate(asOf)}.`;
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
  followUps: Array<{ followUp: NonNullable<Extraction["follow_ups"]>[number]; letterDate: string | null; dept: string | null }>,
  tokensById: Map<string, Set<string>>,
): Map<string, string> {
  /** node id -> the letter's own words for how its due date was arrived at. */
  const dueBasis = new Map<string, string>();
  for (const { followUp, letterDate, dept } of followUps) {
    const anchorNode = followUp.from ? findNode(nodes, followUp.from) : undefined;
    const anchor = (anchorNode && timelineOf(anchorNode)) || letterDate;
    const due = followUp.due_date ?? (anchor && followUp.phrase ? dueDateFrom(anchor, followUp.phrase) : null);
    if (!due) continue;

    const basis = followUp.due_date
      ? `stated as due ${humanDate(followUp.due_date)}`
      : `"${followUp.phrase}" from ${anchorNode ? `${anchorNode.label} on ` : ""}${humanDate(anchor)}`;

    let target = findNode(nodes, followUp.item);
    if (target && COMPLETED.has(target.status)) {
      // The letters promise the NEXT one; the completed step keeps its own dates.
      target = undefined;
    }
    if (!target) {
      const label = sentenceCase(followUp.item);
      // A promised item is filed under the type its NAME implies, not assumed to
      // be an appointment: "repeat non-contrast CT" is the CT already on the
      // graph waiting to be done, and giving it a due date of its own as a
      // separate consult would show the same scan twice.
      const invType = typeFromName(followUp.item);
      const key = stepTokens(label, invType);
      target = nodes.find((node) =>
        node.kind === "investigation" && node.invType === invType &&
        !COMPLETED.has(node.status) && sameStep(tokensById.get(node.id) ?? new Set(), key),
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
    }
    // Earliest promise wins: the first date it was due is the date it is late from.
    if (!target.dueDate || due < target.dueDate) {
      target.dueDate = due;
      dueBasis.set(target.id, basis);
    }
  }
  return dueBasis;
}

/** The dated pathway steps, oldest first, by the date they belong on a timeline. */
function timelineSpine(graph: PathwayGraph): GraphNode[] {
  return graph.nodes
    .filter((node) => node.id !== graph.goal.nodeId && node.kind !== "finding" && timelineOf(node) !== null)
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const left = timelineOf(a.node)!;
      const right = timelineOf(b.node)!;
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((item) => item.node);
}

/**
 * Real letters rarely write "awaiting X before Y", so stated dependencies alone
 * leave most steps unconnected and nothing reaches the goal. Every dated step
 * that cannot get to the goal on the letters' own words is therefore linked
 * forward to the next step in date order, which makes the pathway one ordered
 * timeline ending at the goal.
 *
 * These edges are marked `inferred` and are worth strictly less than a stated
 * one everywhere it matters: they order the timeline, they never decide what is
 * blocking the treatment. Order comes from the written dates, never the model.
 */
function connectTimeline(graph: PathwayGraph) {
  const spine = timelineSpine(graph);
  const goalNode = graph.nodes.find((node) => node.id === graph.goal.nodeId);
  if (!spine.length || !goalNode) return;

  // Latest first, so each step is linked to a successor that already connects.
  for (let i = spine.length - 1; i >= 0; i--) {
    if (pathToGoal(graph, spine[i]) !== null) continue;
    addEdge(graph.edges, spine[i], i === spine.length - 1 ? goalNode : spine[i + 1], "blocks", true);
  }
}

/** Nodes that actually reach the goal, in date order, ending at the goal. */
function chainIds(graph: PathwayGraph): string[] {
  const onChain = graph.nodes
    .filter((node) => node.id !== graph.goal.nodeId && pathToGoal(graph, node) !== null)
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
 * Whether an open step is late, and by how much. A date the letters promise
 * beats the generic per-type expected wait: "FU 4 weeks" is what the clinic
 * actually committed to, and it is the number the patient can hold them to.
 */
function overdueBy(node: GraphNode, asOf: string): number | null {
  if (COMPLETED.has(node.status)) return null;
  if (node.dueDate) return asOf > node.dueDate ? daysBetween(node.dueDate, asOf) : null;
  const since = startDate(node);
  if (since === null || node.expected_days === null) return null;
  const waited = daysBetween(since, asOf);
  return waited > node.expected_days ? waited - node.expected_days : null;
}

/** Every open step now past its due date, most overdue first. */
function overdueNodes(graph: PathwayGraph, asOf: string): GraphNode[] {
  return graph.nodes
    .filter((node) => node.id !== graph.goal.nodeId && overdueBy(node, asOf) !== null)
    .sort((a, b) => (overdueBy(b, asOf) ?? 0) - (overdueBy(a, asOf) ?? 0));
}

/**
 * The single overdue step holding up the goal. One bottleneck is reported, not
 * a list; every other late step keeps its own `overdue` on the node, so nothing
 * is hidden — it is just not called THE blocker, which by definition there is
 * one of.
 *
 * Ranking, in order: the upstream root first (a late step that is itself
 * waiting on another late step is not the one to chase — chasing the clearance
 * achieves nothing while the scan it needs is unbooked), then the longest
 * overdue, then the earliest promised date. All three come from the graph, not
 * from any letter-specific rule.
 */
export function findStall(graph: PathwayGraph, asOf = todayISO()): Stall | null {
  const overdue = overdueNodes(graph, asOf);
  const candidates = overdue
    .map((node) => ({ node, route: bestPath(graph, node), days: overdueBy(node, asOf) ?? 0 }))
    .filter((entry): entry is { node: GraphNode; route: NonNullable<ReturnType<typeof bestPath>>; days: number } =>
      entry.route !== null,
    );
  if (!candidates.length) return null;

  // Everything reachable from a late step: anything in here is waiting on one.
  const candidateIds = new Set(candidates.map((entry) => entry.node.id));
  const downstreamOfCandidate = new Set<string>();
  for (const edge of graph.edges) {
    if (!candidateIds.has(edge.from)) continue;
    const queue = [edge.to];
    while (queue.length) {
      const id = queue.shift()!;
      if (downstreamOfCandidate.has(id)) continue;
      downstreamOfCandidate.add(id);
      for (const next of graph.edges.filter((item) => item.from === id)) queue.push(next.to);
    }
  }

  const ranked = [...candidates].sort((a, b) => {
    const rootA = Number(!downstreamOfCandidate.has(a.node.id));
    const rootB = Number(!downstreamOfCandidate.has(b.node.id));
    if (rootA !== rootB) return rootB - rootA;
    if (a.days !== b.days) return b.days - a.days;
    // Same lateness: the one promised earliest is the one that has been waited
    // on longest, so it is the one to chase.
    const left = a.node.dueDate || startDate(a.node) || "";
    const right = b.node.dueDate || startDate(b.node) || "";
    return left === right ? a.node.label.localeCompare(b.node.label) : left < right ? -1 : 1;
  });
  const { node: root, route, days: daysOverdue } = ranked[0];

  const sinceDate = startDate(root);
  const alsoOpen = overdue.filter((node) => node.id !== root.id);
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
  const late = open.filter((node) => overdueBy(node, asOf) !== null);
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
