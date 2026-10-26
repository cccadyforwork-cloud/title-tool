// Exercise the real submit handler with a minimal DOM and synthetic API results.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function node() {
  return {
    value: '', textContent: '', hidden: false, dataset: {}, handlers: {}, children: [],
    classList: {add() {}, remove() {}},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute() {}, removeAttribute() {}, contains() { return false; },
    querySelector() { return node(); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  };
}

async function submitWithName(name) {
  const nodes = new Map();
  const query = selector => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  };
  const oldHistory = JSON.stringify([{id: 1, title: 'Existing record', time: 1}]);
  const storage = new Map([['title-workbench-history', oldHistory]]);
  let requests = 0;
  const phrases = ['pill cutter', 'pill splitter', 'tablet cutter'].map(term => ({term, locations: []}));
  const answer = {
    item_name: name, item_highlights: 'B'.repeat(110), rules_version: '20261027-1',
    name_independent_keywords: phrases, highlights_independent_keywords: phrases,
    keywords: phrases, used: phrases, facts: [], required_variants: [], model: 'synthetic', attempts: 1,
    traffic_header: 'Traffic Share', search_header: 'Monthly Search Volume',
    // Deliberately claim success and a different count: the frontend must count the actual text.
    local_validation: {passed: true, name_chars: 72, name_keyword_count: 3, highlights_keyword_count: 3},
    review: {approved: true, natural: true, facts_supported: true, identity_clear: true,
      variants_preserved: true, allocation_ok: true, priority_ok: true, no_redundancy: true}
  };
  const context = vm.createContext({
    document: {querySelector: query, createElement: node, addEventListener() {}, documentElement: node()},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,Zml4dHVyZQ=='; this.onload(); } },
    AbortController, setTimeout: () => 1, clearTimeout() {},
    fetch: async () => { requests++; return {ok: true, json: async () => answer}; }
  });
  vm.runInContext(fs.readFileSync(__dirname + '/app.js', 'utf8'), context);
  vm.runInContext('screenshotFile = {}; searchScreenshotFile = {};', context);
  query('#originalTitle').value = 'Synthetic original';
  await query('#titleForm').handlers.submit({preventDefault() {}});
  assert.equal(requests, 1, 'Length failure must not trigger another API request');
  assert.equal(query('#inputFields').disabled, false, 'Form must unlock after completion');
  if (Array.from(name).length >= 68 && Array.from(name).length <= 75) {
    assert.equal(query('#generatedResult').hidden, false);
    const history = JSON.parse(storage.get('title-workbench-history'));
    assert.equal(history[0].item_name, name);
    assert.equal(history.length, 2, 'Preserve existing history on successful generation');
    assert.equal(query('#nameCount').textContent, `${Array.from(name).length} 字符（68–75）`);
  } else {
    assert.equal(query('#generatedResult').hidden, true, 'Invalid name must not display as success');
    assert.match(query('#errorMessage').textContent, new RegExp(`${Array.from(name).length} 个字符`));
    assert.equal(storage.get('title-workbench-history'), oldHistory, 'Do not save failed results or remove old history');
    assert.equal(query('#resultStatus').textContent, '未通过或生成失败');
  }
}

(async () => {
  for (const size of [67, 68, 75, 76, 83]) await submitWithName('A'.repeat(size));
  await submitWithName('A'.repeat(63) + ' B-C.');
  await submitWithName('A'.repeat(74) + '😀'); // Unicode code points agree with Python len, not UTF-16 units.
  console.log('Title frontend: 7 length/save regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
