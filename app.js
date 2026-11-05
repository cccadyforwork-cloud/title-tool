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
  identity_clear: '标题准确表达实际商品身份', variants_preserved: '重要变体已保留',
  allocation_ok: '亮点补充具体场景、功能与使用帮助', priority_ok: '数量前置，亮点优先采用相关类目词及参考表达', no_redundancy: '无不必要的同义词堆砌'
};
const charLength = (text) => Array.from(text || '').length;
function titleHasPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, 'i').test(text);
}
function sellingQuantity(original) {
  return original.match(/(?<![\w.])(?:[1-9]\d*\s*-?\s*(?:packs?|pcs?|pieces?|counts?|ct|pairs?|sets?)|(?:packs?|sets?)\s+of\s+[1-9]\d*)(?![\w.])/i)?.[0] || '';
}
function quantityLeads(name, quantity) {
  return !quantity || (name.slice(0, quantity.length).toLowerCase() === quantity.toLowerCase()
    && /^(?:\s|[,;:]|$)/.test(name.slice(quantity.length)));
}
const NAME_MIN = 60;
const NAME_LIMIT = 75;
const RULES_VERSION = '20261105-dynamic-name-budget-1';
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
const historyProject = draftParams.get('store_project_id');
const historyContext = draftSku ? [draftCase ? 'case' : historyProject ? 'project' : 'sku', draftCase || historyProject || '', draftSku] : ['standalone'];
const historyKey = `title-workbench-history:v2:${JSON.stringify(historyContext)}`;
const legacyHistoryKey = 'title-workbench-history';

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
    && minimum === (field === 'name' ? 2 : Math.min(2, available)) && Number.isInteger(count)
    && Array.isArray(rows) && rows.length === count && count >= minimum && count <= available;
}
function keywordQuotaText(result, field) {
  const checks = result.local_validation;
  const available = checks[`available_${field}_keywords`], minimum = checks[`minimum_${field}_keywords`];
  if (field === 'highlights') return `完整词组命中 ${checks.highlights_keyword_count} 个类目词组 · 可用 ${available} 个 · 本次至少 ${minimum} 个 · 覆盖数无上限，尽量补充标题未用词`;
  return `已覆盖 ${checks.name_keyword_count} 个 · 可用 ${available} 个 · 本次至少 ${minimum} 个，身份准确优先，尽量覆盖3个`;
}
const pendingGenerationKey = `title-workbench-pending:${draftScope}`;
function readPendingGeneration() {
  try {
    const jobId = sessionStorage.getItem(pendingGenerationKey) || '';
    return /^[a-f0-9]{32}$/.test(jobId) ? jobId : '';
  } catch { return ''; }
}
function pendingGeneration(jobId) {
  try {
    if (jobId) sessionStorage.setItem(pendingGenerationKey, jobId);
    else sessionStorage.removeItem(pendingGenerationKey);
  } catch { /* Current-page polling still works when browser storage is blocked. */ }
}
async function generationRequest(url, options, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 20000);
  try {
    const response = await fetch(url, {...options, signal: controller.signal});
    let data;
    try { data = await response.json(); }
    catch { throw Object.assign(new Error(`服务响应异常（HTTP ${response.status}）`), {retryable: response.status >= 500}); }
    if (!response.ok) {
      const reason = response.status === 413 ? '上传截图过大，请压缩后重试'
        : response.status === 401 || response.status === 403 ? '登录已失效或没有工具权限，请重新登录'
        : data.error || '标题服务暂时无法连接';
      throw Object.assign(new Error(`${reason}（HTTP ${response.status}）`), {
        retryable: [502, 503, 504].includes(response.status) && data.job_finished !== true,
        status: response.status, terminal: data.job_finished === true
      });
    }
    return {data, status: response.status};
  } catch (error) {
    if (error.name === 'TypeError' || error.name === 'AbortError') error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', abort);
  }
}
async function generationPause(signal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2000);
    signal.addEventListener('abort', abort, {once: true});
  });
}
async function generateWithArk(file, searchFile, original, reference, existingJobId = '') {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 1200000);
  const started = Date.now();
  try {
    let jobId = existingJobId;
    if (!jobId) {
      const [image, search_image] = await Promise.all([
        file ? fileAsDataUrl(file) : Promise.resolve(null),
        searchFile ? fileAsDataUrl(searchFile) : Promise.resolve(null)
      ]);
      const request_id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const options = {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({image, search_image, original, reference, async: true, request_id})};
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await generationRequest('/api/generate', options, controller.signal);
          jobId = response.data.job_id;
          if (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId)) throw new Error('生成任务返回异常，请刷新后重试');
          pendingGeneration(jobId); break;
        } catch (error) {
          if (!error.retryable || attempt >= 2 || controller.signal.aborted) throw error;
          el.resultStatus.textContent = '正在确认生成任务，请稍候…';
          await generationPause(controller.signal);
        }
      }
    }
    let data;
    while (!controller.signal.aborted) {
      try {
        const response = await generationRequest(`/api/generation-jobs/${jobId}`, {}, controller.signal);
        if (response.status !== 202) { data = response.data; pendingGeneration(''); break; }
        el.resultStatus.textContent = `${response.data.phase || '正在生成'}，请等待 · 已等待 ${Math.round((Date.now() - started) / 1000)} 秒`;
      } catch (error) {
        if (!error.retryable) {
          if (error.terminal || [400, 404, 409, 410].includes(error.status)) pendingGeneration('');
          throw error;
        }
        el.resultStatus.textContent = '连接暂时中断，正在等待同一次生成任务恢复…';
      }
      await generationPause(controller.signal);
    }
    if (!data) throw new DOMException('Aborted', 'AbortError');
    if (typeof data.item_name === 'string') {
      const length = charLength(data.item_name);
      if (length < NAME_MIN || length > NAME_LIMIT) throw new Error(`生成结果未保存：Item Name 为 ${length} 个字符，要求 ${NAME_MIN}–${NAME_LIMIT} 个字符（含空格和标点）`);
    }
    if (typeof data.item_name === 'string' && !quantityLeads(data.item_name, sellingQuantity(el.original.value))) throw new Error('原标题数量必须原样放在商品标题最前面，结果未保存');
    const primaryPolicy = data.title_traffic_priority;
    if (primaryPolicy?.minimum_primary_keywords === 1 && (!Array.isArray(data.primary_traffic_keywords) || !data.primary_traffic_keywords.length)) throw new Error('标题未覆盖主要流量词，结果未保存');
    const pairs = primaryPolicy?.required_keyword_pairs;
    if (Array.isArray(pairs) && pairs.length && !pairs.some(pair => Array.isArray(pair) && pair.length === 2 && pair.every(phrase => typeof phrase === 'string' && titleHasPhrase(data.item_name || '', phrase)))) throw new Error('标题未覆盖生成前选定的可行双关键词组合，结果未保存');
    if (typeof data.item_highlights === 'string' && charLength(data.item_highlights) > 125) throw new Error('亮点超过125字符，结果未保存');
    const valid = typeof data.item_name === 'string' && data.item_name.trim()
      && typeof data.item_highlights === 'string' && data.item_highlights.trim()
      && Array.isArray(data.keywords) && Array.isArray(data.used) && data.local_validation?.passed === true
      && keywordQuotaValid(data, 'name') && keywordQuotaValid(data, 'highlights')
      && data.review?.approved === true && Object.keys(REVIEW_LABELS).every(key => data.review[key] === true);
    if (!valid) throw new Error('生成结果未通过完整自检，未保存，请重试');
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('本次等待较久，任务仍可在刷新后继续查询，请勿连续重复生成');
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
function trafficExplanation(row) {
  if (row.traffic == null) return '自然占比未提供';
  const share = `${Number(row.traffic.toFixed(4))}%`;
  return row.traffic_basis === 'derived_organic' ? `${share}（总占比${row.traffic_total}% × 自然${row.organic_ratio}%）` : share;
}
function sourceLabel(row) { return (row.sources || []).map(source => source === 'traffic_share' ? '流量表' : '类目表').join('＋'); }
function renderResult(result) {
  currentResult = result; el.name.textContent = result.item_name; el.highlights.textContent = result.item_highlights;
  el.nameCount.textContent = `${charLength(result.item_name)} 字符（60–75）`;
  el.highlightsCount.textContent = `${charLength(result.item_highlights)} 字符（最多125）`;
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
        ? (row.traffic == null ? '占比未提供' : `自然流量占比 ${Number(row.traffic.toFixed(4))}%`)
        : (row.search_volume == null ? '月搜索量未提供' : `月搜索量 ${row.search_volume.toLocaleString('en-US')}`);
      chip.append(textNode('b', metric));
      if (field.key === 'item_name' && row.primary_traffic === true) chip.append(textNode('b', '主要流量词')); terms.append(chip);
    });
    line.append(terms); el.usedKeywords.append(line);
  });
  el.coverageCount.textContent = `标题：${keywordQuotaText(result, 'name')}；亮点：${keywordQuotaText(result, 'highlights')}`;
  el.checkList.replaceChildren(
    textNode('p', `✓ 截图识别：流量占比${result.traffic_header ? `“${result.traffic_header}”` : '未识别'}；月搜索量${result.search_header ? `“${result.search_header}”` : '未识别'}；流量仅计自然贡献，混合行按总占比×自然比例折算，纯广告及未知自然比例不参与流量排序`),
    textNode('p', `✓ 标题：${keywordQuotaText(result, 'name')}；重要变体已在标题或亮点保留`),
    textNode('p', `✓ 标题长度：${charLength(result.item_name)} 个字符，已通过前后端 60–75 字符校验（含空格和标点）；逐组实测选择完整候选，不自动截断；全失败最多重新生成1次`),
    ...(result.title_pair_preflight ? [textNode('p', `✓ 生成前组合：数量与核心品名“${result.title_pair_preflight.product_identity}”已预留，功能等描述另作写作素材；选定双关键词最短骨架 ${result.title_pair_preflight.shortest_skeleton_chars} 字符；第二词仅因75字符预算不可行时顺延`)] : []),
    textNode('p', result.title_traffic_priority?.minimum_primary_keywords === 1 ? `主要流量词：${(result.primary_traffic_keywords || []).join('、')}；先筛适用词，再按自然流量贡献占比从高到低选择` : '选词来源：无适用流量词，按类目月搜索量从高到低选择；不要求主要流量词'),
    textNode('p', '亮点最多125字符，已按实际字数校验；不设长度下限，优先表达具体使用价值'),
    textNode('p', `亮点类目搜索词：${keywordQuotaText(result, 'highlights')}；达到动态最低数量后自然多覆盖，尽量避免与标题关键词及描述重复；仅计独立完整类目词，不堆词`),
    textNode('p', '✓ 计数：不跨字段拼词，嵌套、单复数和连字符变体不重复计数'),
    ...Object.entries(REVIEW_LABELS).map(([key, label]) => textNode('p', `${result.review[key] ? '✓' : '×'} 豆包生成自检：${label}`)),
    textNode('p', `规则 ${result.rules_version} · 生成 ${result.model} · 生成时自检 · 本次尝试 ${result.attempts} 次`, 'audit-meta')
  );
  el.factsList.replaceChildren(textNode('strong', '人工确认资料来源'));
  el.factsList.append(textNode('p', `原标题：${result.product_sources?.original || el.original.value.trim()}`));
  if (result.product_sources?.reference) el.factsList.append(textNode('p', `选定参考（已确认适用）：${result.product_sources.reference}`));
  const contextLabels = {product:'实际商品', audience:'适用人群', scene:'具体场景与用途', function:'具体功能', benefit:'使用帮助', conditions:'适用条件与限制'};
  for (const [key, label] of Object.entries(contextLabels)) {
    if (result.highlight_context?.[key]) el.factsList.append(textNode('p', `${label}：${result.highlight_context[key]}`));
  }
  (result.facts || []).forEach(row => el.factsList.append(textNode('p', `${row.claim} ← ${row.source === 'reference' ? '选定参考标题' : '原标题'}：“${row.source_quote}”`)));
  el.factsList.append(textNode('p', `标题或亮点必须保留的变体：${(result.required_variants || []).map(row => row.value).join(' / ') || '未识别到明确变体'}`));
  el.keywordRows.replaceChildren();
  result.keywords.forEach(row => {
    const tr = document.createElement('tr');
    [row.term, trafficExplanation(row), row.search_volume == null ? '—' : row.search_volume.toLocaleString('en-US'), sourceLabel(row), row.eligible ? `${fieldLabel(row.locations)}${independent.has(row.term.toLowerCase()) ? ' · 独立计数' : ''}` : (row.locations?.length ? `${fieldLabel(row.locations)} · 语境匹配，不计词数` : '不参与关键词计数'), row.reason].forEach(value => tr.append(textNode('td', value)));
    el.keywordRows.append(tr);
  });
  el.emptyResult.hidden = true; el.generatedResult.hidden = false; el.resultStatus.textContent = '已生成';
}
function readHistory(key) {
  const value = JSON.parse(localStorage.getItem(key) || '[]');
  if (!Array.isArray(value)) throw new Error('历史记录格式无效');
  return value.filter(row => row && typeof row === 'object').slice(0, 10);
}
function getHistory(key = historyKey) {
  try { return readHistory(key); } catch { return []; }
}
function saveHistory(item) {
  try {
    const history = readHistory(historyKey).filter(row => row.item_name !== item.item_name || row.item_highlights !== item.item_highlights);
    history.unshift({...item, store_case_id: draftCase || '', store_project_id: historyProject || '', store_sku: draftSku || ''});
    localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 10))); renderHistory(); return true;
  } catch { showToast('结果已生成，但历史记录未能保存；请先复制结果'); return false; }
}
function deleteHistory(id) {
  try { localStorage.setItem(historyKey, JSON.stringify(readHistory(historyKey).filter(item => (item.id ?? item.time) !== id))); renderHistory(); showToast('记录已删除'); }
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
  const history = getHistory(); el.historyEmpty.hidden = history.length > 0; el.historyList.hidden = history.length === 0;
  $('#historyScope').textContent = draftSku ? `当前SKU：${draftSku} · 每个链接SKU分别保留最近10条（此浏览器）` : '未关联SKU · 当前独立工具保留最近10条（此浏览器）';
  $('#clearHistory').textContent = draftSku ? '清空当前SKU记录' : '清空当前记录';
  renderHistoryItems(history, el.historyList);
  const previous = getHistory(legacyHistoryKey);
  $('#legacyHistory').hidden = previous.length === 0;
  renderHistoryItems(previous, $('#legacyHistoryList'), true);
}
function renderHistoryItems(history, target, archive = false) {
  target.replaceChildren();
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
    remove.addEventListener('click', () => deleteHistory(item.id ?? item.time)); if (!archive) actions.append(remove);
    row.append(textNode('span', String(index + 1).padStart(2, '0'), 'history-index'), content, actions); target.append(row);
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
async function displayGeneration(task) {
  clearResult(); setBusy(true); el.resultStatus.textContent = '识图 → 选词 → 豆包生成';
  try {
    const result = await task(); renderResult(result);
    const now = Date.now();
    const saved = saveHistory({id: now, item_name: result.item_name, item_highlights: result.item_highlights, covered: result.used.length,
      time: now, rules_version: result.rules_version, name_keyword_count: result.local_validation.name_keyword_count, highlights_keyword_count: result.local_validation.highlights_keyword_count, review: result.review, local_validation: result.local_validation});
    if (saved) showToast('标题与亮点已生成并保存');
  } catch (error) { el.resultStatus.textContent = '未通过或生成失败'; el.error.textContent = error.message || '生成失败'; el.error.hidden = false; showToast(el.error.textContent); }
  finally { setBusy(false); }
}
el.form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const pending = readPendingGeneration();
  if (pending) return displayGeneration(() => generateWithArk(null, null, '', '', pending));
  const original = el.original.value.trim();
  if (!screenshotFile && !searchScreenshotFile) return showToast('请上传至少一张含关键词及指标的截图');
  if (!original) { el.original.focus(); return showToast('请填写原有标题'); }
  await displayGeneration(() => generateWithArk(screenshotFile, searchScreenshotFile, original, el.reference.value.trim()));
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
$('#clearHistory').addEventListener('click', () => { try { localStorage.removeItem(historyKey); renderHistory(); showToast('当前记录已清空'); } catch { showToast('浏览器存储不可用，未能清空记录'); } });
el.themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
restoreDraftText();
draftImageRestore = restoreDraftImages();
setTheme(document.documentElement.dataset.theme || 'light'); renderHistory(); setBusy(false);
draftImageRestore.finally(() => {
  const pending = readPendingGeneration();
  if (pending && !busy) void displayGeneration(() => generateWithArk(null, null, '', '', pending));
});

window.addEventListener?.('storage', event => { if (event.key === historyKey || event.key === legacyHistoryKey || event.key === null) renderHistory(); });
