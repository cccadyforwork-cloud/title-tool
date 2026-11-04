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

async function submitWithName(name, options = {}) {
  const {availableName = 3, availableHighlights = 3,
    nameCount = Math.min(3, availableName), highlightsCount = Math.min(3, availableHighlights),
    nameMinimum = 2, highlightsMinimum = 0,
    expectedError = null, original = 'Synthetic original', highlights = "B".repeat(60), requiredPairs = []} = options;
  const nodes = new Map();
  const query = selector => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  };
  const oldHistory = JSON.stringify([{id: 1, title: 'Existing record', time: 1}]);
  const storage = new Map([['title-workbench-history', oldHistory]]);
  let requests = 0;
  const phrases = ['pill cutter', 'pill splitter', 'tablet cutter', 'medicine cutter', 'tablet splitter'].map(term => ({term, locations: []}));
  const answer = {
    item_name: name, item_highlights: highlights, rules_version: '20261104-feasible-pairs-1',
    title_traffic_priority: {minimum_primary_keywords: 0, required_keyword_pairs: requiredPairs},
    name_independent_keywords: phrases.slice(0, nameCount), highlights_independent_keywords: phrases.slice(0, highlightsCount),
    keywords: phrases, used: phrases, facts: [], required_variants: [], model: 'synthetic', attempts: 1,
    traffic_header: 'Traffic Share', search_header: 'Monthly Search Volume',
    // Deliberately claim success and a different count: the frontend must count the actual text.
    local_validation: {passed: true, name_chars: 72, name_keyword_count: nameCount, highlights_keyword_count: highlightsCount,
      available_name_keywords: availableName, available_highlights_keywords: availableHighlights,
      minimum_name_keywords: nameMinimum, minimum_highlights_keywords: highlightsMinimum},
    review: {approved: true, natural: true, facts_supported: true, identity_clear: true,
      variants_preserved: true, allocation_ok: true, priority_ok: true, no_redundancy: true}
  };
  const context = vm.createContext({
    document: {querySelector: query, createElement: node, addEventListener() {}, documentElement: node()},
    window: {}, location: {search: ''}, URLSearchParams,
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,Zml4dHVyZQ=='; this.onload(); } },
    AbortController, DOMException, crypto: require('node:crypto').webcrypto, Uint8Array,
    sessionStorage: {getItem:()=>null,setItem(){},removeItem(){}},
    setTimeout: (callback, ms) => { if(ms === 2000)queueMicrotask(callback); return 1; }, clearTimeout() {},
    fetch: async (url) => { requests++;
      const isSubmit = url === '/api/generate';
      return {ok: true, status: isSubmit ? 202 : 200, json: async () => isSubmit ? {job_id:'a'.repeat(32)} : answer}; }
  });
  vm.runInContext(fs.readFileSync(__dirname + '/app.js', 'utf8'), context);
  vm.runInContext('screenshotFile = {}; searchScreenshotFile = {};', context);
  query('#originalTitle').value = original;
  await query('#titleForm').handlers.submit({preventDefault() {}});
  assert.equal(requests, 2, 'One submission and one result read, without duplicate generation');
  assert.equal(query('#inputFields').disabled, false, 'Form must unlock after completion');
  if (!expectedError && Array.from(name).length >= 60 && Array.from(name).length <= 75) {
    assert.equal(query('#generatedResult').hidden, false);
    const history = JSON.parse(storage.get('title-workbench-history'));
    assert.equal(history[0].item_name, name);
    assert.equal(history.length, 2, 'Preserve existing history on successful generation');
    assert.equal(query('#nameCount').textContent, `${Array.from(name).length} 字符（60–75）`);
    assert.ok(query('#coverageCount').textContent.includes(`本次至少 ${nameMinimum} 个`));
  } else {
    assert.equal(query('#generatedResult').hidden, true, 'Invalid name must not display as success');
    assert.match(query('#errorMessage').textContent, expectedError || new RegExp(`${Array.from(name).length} 个字符`));
    assert.equal(storage.get('title-workbench-history'), oldHistory, 'Do not save failed results or remove old history');
    assert.equal(query('#resultStatus').textContent, '未通过或生成失败');
  }
}

(async () => {
  for (const size of [59, 60, 67, 68, 75, 76, 79, 83]) await submitWithName('A'.repeat(size));
  await submitWithName('A'.repeat(63) + ' B-C.');
  await submitWithName('A'.repeat(74) + '😀'); // Unicode code points agree with Python len, not UTF-16 units.
  for (const [availableName, availableHighlights] of [[1, 1], [2, 2], [5, 1], [1, 5], [3, 0], [5, 5]]) {
    await submitWithName('A'.repeat(70), {availableName, availableHighlights, expectedError: availableName < 2 ? /完整自检/ : null});
  }
  await submitWithName('A'.repeat(70), {availableName: 3, nameCount: 2, nameMinimum: 2});
  await submitWithName('A'.repeat(70), {availableHighlights: 3, highlightsCount: 0});
  await submitWithName('A'.repeat(70), {availableName: 2, nameCount: 1, expectedError: /完整自检/});
  await submitWithName('A'.repeat(70), {availableName: 1.5, nameCount: 1, expectedError: /完整自检/});
  await submitWithName('A'.repeat(70), {highlights: 'B'.repeat(126), expectedError: /超过125字符/});
  await submitWithName('1PC ' + 'A'.repeat(66), {original:'1PC Cutter, Black'});
  await submitWithName('A'.repeat(66) + ' 1PC', {original:'1PC Cutter, Black', expectedError:/数量必须原样放在商品标题最前面/});
  await submitWithName('A'.repeat(70), {requiredPairs: [['pill cutter', 'pill splitter']], expectedError: /可行双关键词/});
  await submitWithName('Clear Pill Cutter, Pill Splitter for Small Pills, Tablet Cutter with Case', {requiredPairs: [['pill cutter', 'pill splitter for small pills']]});
  console.log('Title frontend length, natural coverage, polling and history checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
