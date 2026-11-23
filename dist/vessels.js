const element = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const body = element('body');
const search = element('q');
const type = element('type');
body.value = query.get('body') === 'female' ? 'female' : 'models';

function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

async function start() {
  const response = await fetch('./vessels.json');
  if (!response.ok) throw Error('Reference unavailable');
  const records = await response.json();
  const byName = new Map(records.map(record => [record.name, record]));
  const children = new Map();
  for (const record of records) {
    if (record.name === record.parent) continue;
    if (!children.has(record.parent)) children.set(record.parent, []);
    children.get(record.parent).push(record);
  }
  for (const name of [...new Set(records.map(record => record.type))].sort()) {
    type.add(new Option(name, name));
  }

  let selected = null;
  const supported = record => !record.sex || record.sex === (body.value === 'female' ? 'female' : 'male');
  function navigate(record) {
    search.value = '';
    type.value = '';
    selected = record;
    render();
    element('list').querySelector('[aria-current=true]')?.scrollIntoView({block:'nearest'});
  }

  function relatives(title, items) {
    const available = items.filter(record => record && supported(record));
    if (!available.length) return;
    const links = node('div', '');
    links.className = 'links';
    for (const record of available) {
      const button = node('button', record.name);
      button.onclick = () => navigate(record);
      links.append(button);
    }
    element('detail').append(node('h3', title), links);
  }

  function describe(record) {
    const panel = element('detail');
    panel.replaceChildren();
    if (!record) return;
    panel.append(node('h2', record.name), node('p', [record.type, record.region, record.ftu].filter(Boolean).join(' · ')));
    const models = record[body.value] || [];
    if (models.length) {
      panel.append(node('h3','View in 3D'));
      const links = node('div','');
      links.className = 'links';
      for (const [index, name] of models) {
        const link = node('a', name);
        link.href = './?body=' + body.value + '&structure=' + index;
        links.append(link);
      }
      panel.append(links);
    } else {
      const coverage = node('p', 'Reference entry only. A matching 3D structure is unavailable in this model.');
      coverage.className = 'muted';
      panel.append(coverage);
    }
    if (record.parent !== record.name) relatives('Parent in the vessel tree', [byName.get(record.parent)]);
    relatives('Branches in the vessel tree', children.get(record.name) || []);
  }

  function render() {
    const term = search.value.trim().toLowerCase();
    const rows = records.filter(record => supported(record) && (!type.value || record.type === type.value) &&
      [record.name, record.region, record.ftu, record.aliases].some(text => text?.toLowerCase().includes(term)));
    if (!rows.includes(selected)) selected = rows[0];
    element('back').href = './?body=' + body.value;
    element('count').textContent = rows.length.toLocaleString() + ' reference entries · ' +
      rows.filter(record => record[body.value]).length.toLocaleString() + ' linked to 3D anatomy';
    const list = element('list');
    const fragment = document.createDocumentFragment();
    for (const record of rows) {
      const button = node('button', record.name);
      button.setAttribute('aria-current', String(record === selected));
      button.onclick = () => {
        selected = record;
        list.querySelector('[aria-current=true]')?.setAttribute('aria-current','false');
        button.setAttribute('aria-current','true');
        describe(record);
      };
      fragment.append(button);
    }
    list.replaceChildren(fragment);
    describe(selected);
  }
  search.oninput = type.onchange = body.onchange = render;
  render();
}
start().catch(() => element('count').textContent = 'The vascular reference could not load. Reload to try again.');
