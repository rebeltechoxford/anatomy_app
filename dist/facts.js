// Quick facts (origin, insertion, action, innervation, blood supply...) from
// Wikipedia anatomy infoboxes, prefetched into facts.json by tools/facts.py.
// Text: Wikipedia contributors, CC BY-SA 4.0 (linked per entry).
let facts = null, loading = null;
const ORDER = ['Origin', 'Insertion', 'Action', 'Innervation', 'Innervates', 'Blood supply', 'Venous drainage', 'Branch of', 'Branches', 'Source', 'Supplies', 'Drains', 'Drains to', 'Articulations', 'Antagonist', 'Lymphatic drainage', 'Function', 'Location'];
export const QUICK = ['Origin', 'Insertion', 'Action', 'Innervation', 'Innervates', 'Blood supply', 'Branch of', 'Supplies', 'Articulations'];

export function loadFacts() {
  return loading ||= fetch('facts.json').then(r => r.ok ? r.json() : null).catch(() => null).then(d => (facts = d?.items || {}));
}
function keys(name) {
  let n = name.replace(/^(Left|Right)\s+/i, '').replace(/\bAllen\s+/, '').trim();
  n = n[0].toUpperCase() + n.slice(1);
  const alt = n.replace(/\s+muscles?$/i, '').replace(/\s+\([^)]*\)$/, '');
  let whole = n.replace(/^.*? (part|head|belly|portion|fibres|fibers|layer|division) of (the )?/i, '');
  whole = whole[0].toUpperCase() + whole.slice(1);
  const wholeAlt = whole.replace(/\s+muscles?$/i, '');
  return [n, alt, alt + ' muscle', n.replace(/\s+of (right|left) /i, ' of '), whole, wholeAlt, wholeAlt + ' muscle'];
}
export function factsFor(name) {
  if (!facts) return null;
  for (const k of keys(name)) if (facts[k]) return facts[k];
  return null;
}
export function orderedFields(f) {
  return ORDER.filter(k => f.fields?.[k]).map(k => [k, f.fields[k]]);
}
