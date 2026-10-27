// Verify text and both uploaded screenshots survive a fresh page context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function node() {
  return {
    value: '', textContent: '', hidden: false, src: '', handlers: [],
    classList: {add() {}, remove() {}},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute() {}, removeAttribute() {}, contains() { return false; },
    querySelector() { return node(); }, append() {}, replaceChildren() {}
  };
}

function browserStorage() {
  const text = new Map();
  const images = new Map();
  const localStorage = {
    getItem: key => text.get(key) ?? null,
    setItem: (key, value) => text.set(key, value),
    removeItem: key => text.delete(key)
  };
  const db = {
    createObjectStore() {},
    transaction() {
      let pending = 0;
      const tx = {oncomplete: null, onerror: null, onabort: null, abort() { this.onabort?.(); }};
      const request = (action) => {
        pending++;
        const result = {};
        queueMicrotask(() => {
          result.result = action();
          result.onsuccess?.();
          if (--pending === 0) queueMicrotask(() => tx.oncomplete?.());
        });
        return result;
      };
      tx.objectStore = () => ({
        get: key => request(() => images.get(key)),
        put: row => request(() => images.set(row.id, row)),
        delete: key => request(() => images.delete(key))
      });
      return tx;
    }
  };
  const indexedDB = {open() {
    const result = {result: db};
    queueMicrotask(() => { result.onupgradeneeded?.(); result.onsuccess?.(); });
    return result;
  }};
  return {localStorage, indexedDB, images, text};
}

function page(storage, sku) {
  const nodes = new Map();
  const query = selector => {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: {querySelector: query, createElement: node, addEventListener() {}, documentElement: {...node(), dataset: {}}},
    window: {indexedDB: storage.indexedDB}, indexedDB: storage.indexedDB,
    location: {search: `?store_case_id=O5-123456789abc&store_sku=${sku}`}, URLSearchParams,
    localStorage: storage.localStorage, Blob, File,
    FileReader: class {
      readAsDataURL(file) { this.result = `data:${file.type};base64,${file.name}`; this.onload?.(); }
    },
    setTimeout: () => 1, clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(__dirname + '/app.js', 'utf8'), context);
  return {context, query, run: code => vm.runInContext(code, context)};
}

async function ready(page) { await page.run('draftImageRestore'); await page.run('draftImageWrites'); }

(async () => {
  const storage = browserStorage();
  const first = page(storage, 'SKU-A');
  await ready(first);
  first.query('#originalTitle').value = 'Original SKU-A title';
  first.query('#originalTitle').handlers.input();
  first.query('#referenceTitles').value = 'Selected competitor reference';
  first.query('#referenceTitles').handlers.input();
  first.context.traffic = new File(['traffic'], 'traffic.png', {type: 'image/png'});
  first.context.search = new File(['search'], 'search.webp', {type: 'image/webp'});
  first.run('renderImage(traffic, "traffic"); renderImage(search, "search")');
  await first.run('draftImageWrites');
  assert.equal(storage.images.size, 2);

  const restored = page(storage, 'SKU-A');
  await ready(restored);
  assert.equal(restored.query('#originalTitle').value, 'Original SKU-A title');
  assert.equal(restored.query('#referenceTitles').value, 'Selected competitor reference');
  assert.equal(restored.query('#titleCount').textContent, '20 个字符');
  assert.equal(restored.query('#fileName').textContent, 'traffic.png');
  assert.equal(restored.query('#searchFileName').textContent, 'search.webp');
  assert.equal(restored.run('screenshotFile.name'), 'traffic.png');
  assert.equal(restored.run('searchScreenshotFile.name'), 'search.webp');

  const otherSku = page(storage, 'SKU-B');
  await ready(otherSku);
  assert.equal(otherSku.query('#originalTitle').value, '');
  assert.equal(otherSku.run('screenshotFile'), null);
  assert.equal(otherSku.run('searchScreenshotFile'), null);

  // A quick replacement while the old draft is loading must keep the new file.
  const changed = page(storage, 'SKU-A');
  changed.context.newTraffic = new File(['new'], 'new-traffic.jpg', {type: 'image/jpeg'});
  changed.run('renderImage(newTraffic, "traffic")');
  await ready(changed);
  assert.equal(changed.run('screenshotFile.name'), 'new-traffic.jpg');
  const changedAgain = page(storage, 'SKU-A');
  await ready(changedAgain);
  assert.equal(changedAgain.query('#fileName').textContent, 'new-traffic.jpg');

  changedAgain.query('#clearButton').handlers.click();
  await changedAgain.run('draftImageWrites');
  const empty = page(storage, 'SKU-A');
  await ready(empty);
  assert.equal(empty.query('#originalTitle').value, '');
  assert.equal(empty.query('#referenceTitles').value, '');
  assert.equal(empty.run('screenshotFile'), null);
  assert.equal(empty.run('searchScreenshotFile'), null);
  assert.equal(storage.images.size, 0);
  console.log('Title draft: refresh, SKU isolation, replacement and clear passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
