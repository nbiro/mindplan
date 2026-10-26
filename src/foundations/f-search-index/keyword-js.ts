/**
 * Keyword ranking in plain JS: BM25 over the same fields and weights as the FTS5 index, for a
 * runtime whose SQLite has no FTS5 (Node 22.13's bundled build has none) or no node:sqlite at all.
 * Words are Unicode letters and marks, diacritics folded, lightly stemmed, stopwords dropped, so
 * it ranks close to the FTS5 half and search quality does not depend on the SQLite build.
 */

import type { SearchDoc } from "./index-db.js";

const STOPWORDS = new Set(
  "a an and are as at be by for from has have how i in into is it its of on or that the this to was what when where which who why will with".split(
    " "
  )
);

/** Field extractors and weights: id words, title, description, aliases, headings, area, entry points, paths. */
const FIELDS: { weight: number; text: (d: SearchDoc) => string }[] = [
  { weight: 6, text: (d) => d.id },
  { weight: 8, text: (d) => d.title },
  { weight: 3, text: (d) => d.description },
  { weight: 8, text: (d) => d.aliases.join(" ") },
  { weight: 1.5, text: (d) => d.headings.join(" ") },
  { weight: 1, text: (d) => d.area.join(" ") },
  { weight: 0.5, text: (d) => d.entry.join(" ") },
  { weight: 1.5, text: (d) => d.paths.join(" ") },
];

const K1 = 1.2;
const B = 0.75;

/** A light English stemmer: enough that enquiry / enquiries and book / booking / booked meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}i`;
  else if (w.length > 4 && /(sses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 2 && w.endsWith("y")) w = `${w.slice(0, -1)}i`;
  return w;
}

/** Words of a text: NFC, lowercase, letters/marks/digits of any script, diacritics folded, stemmed. */
export function keywordTerms(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => stem(w.normalize("NFD").replace(/\p{M}/gu, "")))
    .filter(Boolean);
}

/**
 * Ids of `docs` (kept to `candidates`) ranked by field-weighted BM25 for `query`, best first;
 * a doc that matches no query word is left out.
 */
export function keywordRankDocs(
  docs: SearchDoc[],
  query: string,
  candidates: Set<string>,
  limit: number
): string[] {
  const terms = [...new Set(keywordTerms(query))];
  if (terms.length === 0) return [];
  const live = docs.filter((d) => !d.retired);
  const fieldTerms = live.map((d) => FIELDS.map((f) => keywordTerms(f.text(d))));
  // FTS5's bm25(): a term's frequency is the weighted sum over columns, saturated once per
  // document, against the document's total length.
  const docLen = fieldTerms.map((fields) => fields.reduce((sum, words) => sum + words.length, 0));
  const avgLen = docLen.reduce((sum, len) => sum + len, 0) / Math.max(1, live.length) || 1;
  const df = new Map<string, number>();
  for (const fields of fieldTerms) {
    const seen = new Set(fields.flat());
    for (const t of terms) if (seen.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = live.length;
  const scored: { id: string; score: number }[] = [];
  live.forEach((doc, di) => {
    if (!candidates.has(doc.id)) return;
    let score = 0;
    for (const t of terms) {
      const docFreq = df.get(t) ?? 0;
      if (docFreq === 0) continue;
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      let f = 0;
      FIELDS.forEach((field, fi) => {
        for (const w of fieldTerms[di][fi]) if (w === t) f += field.weight;
      });
      if (f === 0) continue;
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * docLen[di]) / avgLen)));
    }
    if (score > 0) scored.push({ id: doc.id, score });
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((s) => s.id);
}
