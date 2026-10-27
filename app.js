const $ = (selector) => document.querySelector(selector);
const el = {
  form: $('#titleForm'), fields: $('#inputFields'), original: $('#originalTitle'), reference: $('#referenceTitles'),
  titleCount: $('#titleCount'), imageInput: $('#imageInput'), uploadBox: $('#uploadBox'),
  uploadEmpty: $('#uploadEmpty'), preview: $('#preview'), imagePreview: $('#imagePreview'),
  emptyResult: $('#emptyResult'), generatedResult: $('#generatedResult'), error: $('#errorMessage'),
  name: $('#nameOutput'), highlights: $('#highlightsOutput'), nameCount: $('#nameCount'), highlightsCount: $('#highlightsCount'),
  usedKeywords: $('#usedKeywords'), resultStatus: $('#resultStatus'), coverageCount: $('#coverageCount'),
  toast: $('#toast'), generate: $('.primary-button'), historyList: $('#historyList'), historyEmpty: $('#historyEmpty'),
  themeButton: $('#themeButton'), keywordRows: $('#keywordRows'), checkList: $('#checkList'), factsList: $('#factsList'),
  draftStatus: $('#draftStatus')
};
const REVIEW_LABELS = {
  natural: '英文自然、词组关系清楚', facts_supported: '与人工确认资料一致，不改错信息',
  identity_clear: '商品标题清楚表达商品身份', variants_preserved: '重要变体已保留',
  allocation_ok: '标题与亮点分工合理', priority_ok: '相关高流量词优先安排', no_redundancy: '无不必要的同义词堆砌'
};
const charLength = (text) => Array.from(text || '').length;
const NAME_MIN = 68;
const NAME_LIMIT = 75;
const RULES_VERSION = '20261027-2';
let screenshotFile = null;
let searchScreenshotFile = null;
let currentResult = null;
let busy = false;
const draftParams = new URLSearchParams(location.search);
const draftCase = draftParams.get('store_case_id');
const draftSku = draftParams.get('store_sku');
const draftScope = draftCase && draftSku ? JSON.stringify([draftCase, draftSku]) : 'standalone';
const draftTextKey = `title-workbench-draft-text:${draftScope}`;
const draftImageKey = kind => `${draftScope}:${kind}`;
const imageTouched = {traffic: false, search: false};
let draftDbPromise;
let draftImageRestore;
let draftImageWrites = Promise.resolve();
let draftImagePending = 0;
let draftImageRestoring = true;
let draftTextError = false;
let draftImageReadError = false;
const draftImageWriteErrors = {traffic: false, search: false};

function updateDraftStatus() {
  const imageError = draftImageReadError || draftImageWriteErrors.traffic || draftImageWriteErrors.search;
  if (draftTextError || imageError) {
    el.draftStatus.textContent = draftTextError && imageError ? '浏览器未能保存草稿；刷新前请保留原资料'
      : imageError ? '截图缓存不可用，刷新后需重新上传' : '文字缓存不可用，刷新后需重新填写';
  } else if (draftImagePending) el.draftStatus.textContent = '正在保存截图，请稍候刷新…';
  else if (draftImageRestoring) el.draftStatus.textContent = '正在恢复本浏览器的截图草稿…';
  else if (el.original.value || el.reference.value || screenshotFile || searchScreenshotFile) el.draftStatus.textContent = '草稿已保存在此浏览器；清空输入可删除当前草稿';
  else el.draftStatus.textContent = '填写和上传后自动保存在此浏览器';
}
function saveDraftText() {
  try {
    localStorage.setItem(draftTextKey, JSON.stringify({original: el.original.value, reference: el.reference.value}));
    draftTextError = false;
  } catch { draftTextError = true; }
  updateDraftStatus();
}
function restoreDraftText() {
  try {
    const saved = JSON.parse(localStorage.getItem(draftTextKey) || 'null');
    if (saved && typeof saved === 'object') {
      if (typeof saved.original === 'string') el.original.value = saved.original.slice(0, 1200);
      if (typeof saved.reference === 'string') el.reference.value = saved.reference;
    }
  } catch { draftTextError = true; }
  el.titleCount.textContent = `${charLength(el.original.value)} 个字符`;
  updateDraftStatus();
}
function draftDb() {
  if (!draftDbPromise) draftDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('浏览器未提供截图缓存'));
    const request = indexedDB.open('title-workbench-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', {keyPath: 'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开截图缓存'));
  });
  return draftDbPromise;
}
async function imageTransaction(mode, operation) {
  const db = await draftDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('截图缓存失败'));
    tx.onabort = () => reject(tx.error || new Error('截图缓存已取消'));
    try { operation(tx.objectStore('images'), value => { result = value; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}
function saveDraftImage(kind, file) {
  draftImagePending++;
  updateDraftStatus();
  draftImageWrites = draftImageWrites.catch(() => {}).then(() => draftImageRestore.catch(() => {}))
    .then(() => imageTransaction('readwrite', store => {
      if (file) store.put({id: draftImageKey(kind), blob: file, name: file.name, type: file.type, lastModified: file.lastModified});
      else store.delete(draftImageKey(kind));
    }))
    .then(() => { draftImageWriteErrors[kind] = false; draftImageReadError = false; }, () => { draftImageWriteErrors[kind] = true; })
    .finally(() => { draftImagePending--; updateDraftStatus(); });
}
async function restoreDraftImages() {
  try {
    const rows = await imageTransaction('readonly', (store, done) => {
      const values = {};
      for (const kind of ['traffic', 'search']) {
        const request = store.get(draftImageKey(kind));
        request.onsuccess = () => { values[kind] = request.result; };
      }
      // The transaction completes after both reads; the object is filled by then.
      done(values);
    });
    for (const kind of ['traffic', 'search']) {
      const row = rows[kind];
      if (imageTouched[kind] || !row || !(row.blob instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(row.type) || row.blob.size > 8 * 1024 * 1024) continue;
      renderImage(new File([row.blob], row.name || `${kind}.png`, {type: row.type, lastModified: row.lastModified}), kind, false);
    }
  } catch { draftImageReadError = true; }
  finally { draftImageRestoring = false; updateDraftStatus(); }
}

function textNode(tag, text, className = '') {
  const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
}
function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取截图')); reader.readAsDataURL(file);
  });
}
function showToast(message) {
  el.toast.textContent = message; el.toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}
function setBusy(value) {
  busy = value; el.fields.disabled = value; $('#clearButton').disabled = value;
  el.generate.querySelector('span').textContent = value ? '正在识别并生成…' : '生成标题与亮点';
  el.uploadBox.setAttribute('aria-disabled', String(value));
  $('#searchUploadBox').setAttribute('aria-disabled', String(value));
}
function keywordQuotaValid(data, field) {
  const checks = data.local_validation;
  const available = checks?.[`available_${field}_keywords`];
  const minimum = checks?.[`minimum_${field}_keywords`];
  const count = checks?.[`${field}_keyword_count`];
  const rows = data[`${field}_independent_keywords`];
  return Number.isInteger(available) && available >= 0 && available <= data.keywords.length
    && minimum === Math.min(3, available) && Number.isInteger(count)
    && Array.isArray(rows) && rows.length === count && count >= minimum && count <= available;
}
function keywordQuotaText(result, field) {
  const checks = result.local_validation;
  const available = checks[`available_${field}_keywords`], minimum = checks[`minimum_${field}_keywords`];
  return `已覆盖 ${checks[`${field}_keyword_count`]} 个 · 可用 ${available} 个 · 本次至少 ${minimum} 个${available < 3 ? '（可用不足 3 个，按实有数量执行）' : '，按原排序尽量多覆盖'}`;
}
async function generateWithArk(file, searchFile, original, reference) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 720000);
  try {
    const [image, search_image] = await Promise.all([fileAsDataUrl(file), fileAsDataUrl(searchFile)]);
    const response = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ image, search_image, original, reference })
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('本机模型服务未启动，请运行 python3 server.py'); }
    if (!response.ok) throw new Error(data.error || '生成失败');
    if (typeof data.item_name === 'string') {
      const length = charLength(data.item_name);
      if (length < NAME_MIN || length > NAME_LIMIT) {
        throw new Error(`生成结果未保存：Item Name 为 ${length} 个字符，要求 ${NAME_MIN}–${NAME_LIMIT} 个字符（含空格和标点）`);
      }
    }
    const valid = typeof data.item_name === 'string' && data.item_name.trim()
      && typeof data.item_highlights === 'string' && data.item_highlights.trim()
      && Array.isArray(data.keywords) && Array.isArray(data.used) && data.local_validation?.passed === true
      && keywordQuotaValid(data, 'name') && keywordQuotaValid(data, 'highlights')
      && data.review?.approved === true && Object.keys(REVIEW_LABELS).every(key => data.review[key] === true);
    if (!valid) throw new Error('生成结果未通过完整自检，未保存，请重试');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('分析超时，结果未保存，请稍后重试');
    throw error;
  } finally { clearTimeout(timeout); }
}
function clearResult() {
  currentResult = null; el.generatedResult.hidden = true; el.emptyResult.hidden = false;
  el.error.hidden = true; el.error.textContent = ''; el.resultStatus.textContent = '等待生成';
}
function uploadNodes(kind) {
  return kind === 'search' ? {input: $('#searchImageInput'), box: $('#searchUploadBox'), empty: $('#searchUploadEmpty'), preview: $('#searchPreview'), image: $('#searchImagePreview'), filename: $('#searchFileName'), remove: $('#removeSearchImage')}
    : {input: el.imageInput, box: el.uploadBox, empty: el.uploadEmpty, preview: el.preview, image: el.imagePreview, filename: $('#fileName'), remove: $('#removeImage')};
}
function renderImage(file, kind = 'traffic', persist = true) {
  if (busy || !file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return showToast('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 8 * 1024 * 1024) return showToast('截图不能超过 8MB');
  if (persist) imageTouched[kind] = true;
  if (kind === 'search') searchScreenshotFile = file; else screenshotFile = file;
  const nodes = uploadNodes(kind); clearResult(); const reader = new FileReader();
  reader.onload = () => {
    if ((kind === 'search' ? searchScreenshotFile : screenshotFile) !== file) return;
    nodes.image.src = reader.result; nodes.filename.textContent = file.name;
    nodes.empty.hidden = true; nodes.preview.hidden = false; nodes.box.classList.add('has-file');
  };
  reader.readAsDataURL(file);
  if (persist) saveDraftImage(kind, file);
  updateDraftStatus();
}
function removeImage(kind = 'traffic', persist = true) {
  if (persist) imageTouched[kind] = true;
  const nodes = uploadNodes(kind);
  nodes.input.value = ''; nodes.image.removeAttribute('src'); nodes.filename.textContent = '';
  nodes.preview.hidden = true; nodes.empty.hidden = false; nodes.box.classList.remove('has-file');
  if (kind === 'search') searchScreenshotFile = null; else screenshotFile = null;
  if (persist) saveDraftImage(kind, null);
  updateDraftStatus();
}
function fieldLabel(locations) { return (locations || []).map(value => value === 'item_name' ? '标题' : '亮点').join('、') || '未匹配'; }
function sourceLabel(row) { return (row.sources || []).map(source => source === 'traffic_share' ? '流量表' : '类目表').join('＋'); }
function renderResult(result) {
  currentResult = result; el.name.textContent = result.item_name; el.highlights.textContent = result.item_highlights;
  el.nameCount.textContent = `${charLength(result.item_name)} 字符（68–75）`;
  el.highlightsCount.textContent = `${charLength(result.item_highlights)} 字符（100–125）`;
  const independent = new Set(result.name_independent_keywords.map(row => row.term.toLowerCase()));
  el.usedKeywords.replaceChildren();
  const keywordFields = [
    {key: 'item_name', label: '标题：', metric: 'traffic'},
    {key: 'item_highlights', label: '亮点：', metric: 'search_volume'}
  ];
  keywordFields.forEach(field => {
    const line = textNode('div', '', 'keyword-line');
    line.append(textNode('strong', field.label, 'keyword-line-label'));
    const terms = textNode('div', '', 'keyword-line-terms');
    const rows = result.used.filter(row => row.locations.includes(field.key))
      .sort((a, b) => (b[field.metric] ?? -1) - (a[field.metric] ?? -1));
    rows.forEach(row => {
      const chip = textNode('span', row.term, 'keyword-chip');
      const metric = field.metric === 'traffic'
        ? (row.traffic == null ? '占比未提供' : `流量占比 ${row.traffic}%`)
        : (row.search_volume == null ? '月搜索量未提供' : `月搜索量 ${row.search_volume.toLocaleString('en-US')}`);
      chip.append(textNode('b', metric)); terms.append(chip);
    });
    line.append(terms); el.usedKeywords.append(line);
  });
  el.coverageCount.textContent = `标题：${keywordQuotaText(result, 'name')}；亮点：${keywordQuotaText(result, 'highlights')}`;
  el.checkList.replaceChildren(
    textNode('p', `✓ 双截图：流量表“${result.traffic_header}”与类目表“${result.search_header}”；不同指标分别排序`),
    textNode('p', `✓ 标题：${keywordQuotaText(result, 'name')}；重要变体在标题中`),
    textNode('p', `✓ 标题长度：${charLength(result.item_name)} 个字符，已通过前后端 68–75 字符校验（含空格和标点）；不自动截断或重生成`),
    textNode('p', '亮点 100–125 字符仍由豆包在生成时控制，本地展示实际字符数'),
    textNode('p', `✓ 亮点类目搜索词：${keywordQuotaText(result, 'highlights')}；优先月搜索量`),
    textNode('p', '✓ 计数：不跨字段拼词，嵌套、单复数和连字符变体不重复计数'),
    ...Object.entries(REVIEW_LABELS).map(([key, label]) => textNode('p', `${result.review[key] ? '✓' : '×'} 豆包生成自检：${label}`)),
    textNode('p', `规则 ${result.rules_version} · 生成 ${result.model} · 生成时自检 · 本次尝试 ${result.attempts} 次`, 'audit-meta')
  );
  el.factsList.replaceChildren(textNode('strong', '人工确认资料来源'));
  el.factsList.append(textNode('p', `原标题：${result.product_sources?.original || el.original.value.trim()}`));
  if (result.product_sources?.reference) el.factsList.append(textNode('p', `选定参考（已确认适用）：${result.product_sources.reference}`));
  (result.facts || []).forEach(row => el.factsList.append(textNode('p', `${row.claim} ← ${row.source === 'reference' ? '选定参考标题' : '原标题'}：“${row.source_quote}”`)));
  el.factsList.append(textNode('p', `标题必须保留的变体：${(result.required_variants || []).map(row => row.value).join(' / ') || '未识别到明确变体'}`));
  el.keywordRows.replaceChildren();
  result.keywords.forEach(row => {
    const tr = document.createElement('tr');
    [row.term, row.traffic == null ? '—' : `${row.traffic}%`, row.search_volume == null ? '—' : row.search_volume.toLocaleString('en-US'), sourceLabel(row), row.eligible ? `${fieldLabel(row.locations)}${independent.has(row.term.toLowerCase()) ? ' · 独立计数' : ''}` : '已排除', row.reason].forEach(value => tr.append(textNode('td', value)));
    el.keywordRows.append(tr);
  });
  el.emptyResult.hidden = true; el.generatedResult.hidden = false; el.resultStatus.textContent = '已生成';
}
function getHistory() {
  try { const value = JSON.parse(localStorage.getItem('title-workbench-history') || '[]'); return Array.isArray(value) ? value.filter(row => row && typeof row === 'object').slice(0, 10) : []; }
  catch { return []; }
}
function saveHistory(item) {
  const history = getHistory().filter(row => row.item_name !== item.item_name || row.item_highlights !== item.item_highlights);
  history.unshift(item);
  try { localStorage.setItem('title-workbench-history', JSON.stringify(history.slice(0, 10))); renderHistory(); return true; }
  catch { showToast('结果已生成，但浏览器存储不可用；请先复制结果'); return false; }
}
function deleteHistory(id) {
  try { localStorage.setItem('title-workbench-history', JSON.stringify(getHistory().filter(item => (item.id ?? item.time) !== id))); renderHistory(); showToast('记录已删除'); }
  catch { showToast('浏览器存储不可用，未能删除记录'); }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select(); const ok = document.execCommand('copy'); area.remove();
    if (!ok) throw new Error('复制失败，请选择文字手动复制');
  }
}
function pairText(item) { return `Item Name: ${item.item_name}\nItem Highlights: ${item.item_highlights}`; }
function copyAction(label, value, message) {
  const button = textNode('button', label, 'history-copy'); button.type = 'button';
  button.addEventListener('click', async () => { try { await copyText(value); showToast(message); } catch (error) { showToast(error.message); } }); return button;
}
function renderHistory() {
  const history = getHistory(); el.historyEmpty.hidden = history.length > 0; el.historyList.hidden = history.length === 0; el.historyList.replaceChildren();
  history.forEach((item, index) => {
    const legacy = !item.item_name; const name = legacy ? item.title || '' : item.item_name;
    const row = document.createElement('article'); row.className = 'history-item';
    const content = document.createElement('div'); content.className = 'history-content';
    content.append(textNode('p', `${legacy ? '旧版单标题' : '商品标题'} · ${name}`, 'history-title'));
    if (!legacy) content.append(textNode('p', `商品亮点 · ${item.item_highlights}`, 'history-highlights'));
    content.append(textNode('div', `${legacy ? `${charLength(name)} 字符 · 旧版规则` : `标题 ${charLength(name)} 字符 · 亮点 ${charLength(item.item_highlights)} 字符 · ${item.name_keyword_count ?? '—'} 个标题独立词组 · ${item.rules_version === RULES_VERSION ? `亮点 ${item.highlights_keyword_count ?? '—'} 个独立搜索词组` : '旧规则结果'}`} · ${new Date(item.time).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})}`, 'history-meta'));
    const actions = document.createElement('div'); actions.className = 'history-actions';
    actions.append(copyAction(legacy ? '复制旧标题' : '复制标题', name, '标题已复制'));
    if (!legacy) actions.append(copyAction('复制亮点', item.item_highlights, '商品亮点已复制'), copyAction('复制全部', pairText(item), '两个字段已复制'));
    const remove = textNode('button', '×', 'history-delete'); remove.type = 'button'; remove.setAttribute('aria-label', '删除这条记录');
    remove.addEventListener('click', () => deleteHistory(item.id ?? item.time)); actions.append(remove);
    row.append(textNode('span', String(index + 1).padStart(2, '0'), 'history-index'), content, actions); el.historyList.append(row);
  });
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('title-workbench-theme', theme); } catch { /* The form remains usable when storage is blocked. */ }
  el.themeButton.setAttribute('aria-label', theme === 'dark' ? '切换浅色主题' : '切换深色主题');
}
el.original.addEventListener('input', () => { el.titleCount.textContent = `${charLength(el.original.value)} 个字符`; clearResult(); saveDraftText(); });
el.reference.addEventListener('input', () => { clearResult(); saveDraftText(); });
['traffic', 'search'].forEach(kind => {
  const nodes = uploadNodes(kind);
  nodes.input.addEventListener('change', event => renderImage(event.target.files[0], kind));
  nodes.box.addEventListener('click', event => { if (!busy && event.target !== nodes.input && !nodes.remove.contains(event.target)) nodes.input.click(); });
  nodes.box.addEventListener('keydown', event => { if (!busy && event.target === nodes.box && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); nodes.input.click(); } });
  ['dragenter', 'dragover'].forEach(name => nodes.box.addEventListener(name, event => { event.preventDefault(); event.stopPropagation(); if (!busy) nodes.box.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(name => nodes.box.addEventListener(name, event => { event.preventDefault(); event.stopPropagation(); nodes.box.classList.remove('dragover'); }));
  nodes.box.addEventListener('drop', event => { if (busy) return; const file = Array.from(event.dataTransfer?.files || []).find(item => item.type.startsWith('image/')); if (file) renderImage(file, kind); else showToast('请拖入 JPG、PNG 或 WebP 图片'); });
  nodes.remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!busy) { removeImage(kind); clearResult(); } });
});
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
el.form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const original = el.original.value.trim();
  if (!screenshotFile) return showToast('请上传竞品流量占比截图');
  if (!searchScreenshotFile) return showToast('请上传类目搜索量截图');
  if (!original) { el.original.focus(); return showToast('请填写原有标题'); }
  clearResult(); setBusy(true); el.resultStatus.textContent = '识图 → 选词 → 豆包生成';
  try {
    const result = await generateWithArk(screenshotFile, searchScreenshotFile, original, el.reference.value.trim()); renderResult(result);
    const now = Date.now();
    const saved = saveHistory({id: now, item_name: result.item_name, item_highlights: result.item_highlights, covered: result.used.length,
      time: now, rules_version: result.rules_version, name_keyword_count: result.local_validation.name_keyword_count, highlights_keyword_count: result.local_validation.highlights_keyword_count, review: result.review, local_validation: result.local_validation});
    if (saved) showToast('标题与亮点已生成并保存');
  } catch (error) { el.resultStatus.textContent = '未通过或生成失败'; el.error.textContent = error.message || '生成失败'; el.error.hidden = false; showToast(el.error.textContent); }
  finally { setBusy(false); }
});
[['copyName', 'item_name', '商品标题已复制'], ['copyHighlights', 'item_highlights', '商品亮点已复制'], ['copyBoth', null, '两个字段已复制']].forEach(([id, key, message]) => {
  $('#' + id).addEventListener('click', async () => { if (!currentResult) return; try { await copyText(key ? currentResult[key] : pairText(currentResult)); showToast(message); } catch (error) { showToast(error.message); } });
});
$('#clearButton').addEventListener('click', () => {
  if (busy) return;
  el.original.value = ''; el.reference.value = ''; el.titleCount.textContent = '0 个字符';
  try { localStorage.removeItem(draftTextKey); draftTextError = false; } catch { draftTextError = true; }
  removeImage(); removeImage('search'); clearResult(); updateDraftStatus();
});
$('#clearHistory').addEventListener('click', () => { try { localStorage.removeItem('title-workbench-history'); renderHistory(); showToast('生成记录已清空'); } catch { showToast('浏览器存储不可用，未能清空记录'); } });
el.themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
restoreDraftText();
draftImageRestore = restoreDraftImages();
setTheme(document.documentElement.dataset.theme || 'light'); renderHistory(); setBusy(false);
