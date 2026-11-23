// "Published imaging" section of the Details dialog.
//  * Figures: CT / MRI / X-ray / ultrasound figures from open-access papers,
//    prefetched from NLM Open-i into radiology.json (tools/radiology.py).
//  * Studies: live Europe PMC search for imaging studies of the structure.
//  * Links: Radiopaedia and PubMed searches.
let radiology = null;
const sideless = n => n.replace(/\b(left|right)\b\s*/gi, '').replace(/\bAllen\s+/, '').replace(/\s+(L|R)( [a-z])?$/, '').replace(/\s+/g, ' ').trim();
const base = n => { const s = sideless(n); return s ? s[0].toUpperCase() + s.slice(1) : s; };

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

export async function imagingSection(name, container) {
  const key = base(name);
  const wrap = el('section');
  wrap.append(el('h3', {}, 'Published imaging'));
  container.append(wrap);
  const links = el('p');
  const rp = el('a', {href: 'https://radiopaedia.org/search?q=' + encodeURIComponent(key), target: '_blank', rel: 'noopener'}, 'Radiopaedia cases & articles ↗');
  const pm = el('a', {href: 'https://pubmed.ncbi.nlm.nih.gov/?term=' + encodeURIComponent(`"${key}" AND (MRI OR "computed tomography" OR radiograph* OR ultrasonograph*)`), target: '_blank', rel: 'noopener'}, 'PubMed imaging literature ↗');
  links.append(rp, document.createTextNode(' · '), pm);
  wrap.append(links);

  // Figures (static, prefetched)
  const figs = el('div', {class: 'imaging'});
  wrap.append(figs);
  try {
    radiology ||= await fetch('radiology.json').then(r => r.ok ? r.json() : null);
  } catch { radiology = null; }
  const items = radiology?.items || {};
  const whole = key.replace(/^.*? (part|head|belly|portion|layer|division) of (the )?/i, '');
  const cands = [key, key.replace(/\s+muscles?$/i, ''), whole, whole.replace(/\s+muscles?$/i, '')].map(k => k && k[0].toUpperCase() + k.slice(1));
  const entry = cands.map(k => items[k]).find(e => e?.figures?.length) || items[key];
  if (entry?.figures?.length) {
    for (const f of entry.figures) {
      const fig = el('figure');
      const img = el('img', {src: radiology.base + f.th, alt: f.cap || f.t, loading: 'lazy', referrerpolicy: 'no-referrer'});
      img.onerror = () => { img.replaceWith(el('div', {class: 'fine', style: 'padding:8px'}, 'Image unavailable offline')); };
      const big = el('a', {href: radiology.base + (f.url || f.lg), target: '_blank', rel: 'noopener'});
      big.append(img);
      const cap = el('figcaption');
      cap.append(el('span', {}, (f.cap || f.t).slice(0, 140) + ((f.cap || f.t).length > 140 ? '…' : '')));
      const cite = el('a', {href: f.pmc ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${f.pmc}/` : radiology.base + f.url, target: '_blank', rel: 'noopener'},
        `${f.j || 'Article'}${f.y ? ' ' + f.y : ''}${f.lic ? ' · ' + f.lic.toUpperCase() : ''} ↗`);
      cap.append(cite);
      fig.append(big, cap);
      figs.append(fig);
    }
    wrap.append(el('p', {class: 'fine'}, `Figures matched for “${entry.query}” via Open-i (U.S. National Library of Medicine) from open-access articles; licences as shown by each article. Search matches can include related pathology.`));
  } else {
    figs.replaceWith(el('p', {class: 'fine'}, radiology ? 'No indexed open-access radiology figures for this exact structure; try the links above.' : 'Figure index not available.'));
  }

  // Studies (live)
  const studies = el('ol', {class: 'studies'});
  studies.append(el('li', {class: 'fine'}, 'Searching Europe PMC…'));
  wrap.append(el('h4', {}, 'Imaging studies'), studies);
  try {
    const q = `"${key}" AND (MRI OR "magnetic resonance" OR "computed tomography" OR radiograph OR ultrasound OR imaging) AND (SRC:MED OR SRC:PMC)`;
    const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=8&sort=CITED%20desc&resultType=lite&query=' + encodeURIComponent(q);
    const data = await fetch(url).then(r => r.json());
    studies.replaceChildren();
    for (const r of data.resultList?.result || []) {
      const li = el('li');
      const href = r.doi ? 'https://doi.org/' + r.doi : r.pmcid ? `https://europepmc.org/article/PMC/${r.pmcid}` : `https://europepmc.org/article/${r.source}/${r.id}`;
      li.append(el('a', {href, target: '_blank', rel: 'noopener'}, r.title?.replace(/<[^>]+>/g, '') || 'Untitled'));
      li.append(el('small', {}, [r.authorString?.split(',').slice(0, 3).join(',') + (r.authorString?.split(',').length > 3 ? ' et al.' : ''), r.journalTitle, r.pubYear,
        r.citedByCount ? `cited ${r.citedByCount}×` : '', r.isOpenAccess === 'Y' ? 'open access' : ''].filter(Boolean).join(' · ')));
      studies.append(li);
    }
    if (!studies.children.length) studies.append(el('li', {class: 'fine'}, 'No matching studies found.'));
    wrap.append(el('p', {class: 'fine'}, 'Most-cited first, from Europe PMC. Peer-reviewed literature for learning; not a diagnosis.'));
  } catch {
    studies.replaceChildren(el('li', {class: 'fine'}, 'Europe PMC is unreachable (offline?). Use the PubMed link above.'));
  }
}
