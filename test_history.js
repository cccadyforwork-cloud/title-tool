// Exercise scoped history storage using fresh page contexts and the actual UI handlers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/app.js', 'utf8');
const legacyKey = 'title-workbench-history';
const legacy = JSON.stringify([{id: 1, time: 1, title: 'Old unassigned title'}]);
const data = new Map([[legacyKey, legacy]]);
let blocked = false;
function element() {
  return {value:'',textContent:'',hidden:false,dataset:{},children:[],handlers:{},
    classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){},contains(){return false},
    addEventListener(type,fn){this.handlers[type]=fn},querySelector(){return element()},
    append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items}};
}
function page(search) {
  const nodes=new Map(), events={}, copied=[];
  const query=key=>{if(!nodes.has(key))nodes.set(key,element());return nodes.get(key)};
  const ctx=vm.createContext({document:{querySelector:query,createElement:element,addEventListener(){},documentElement:element()},
    window:{addEventListener:(type,fn)=>events[type]=fn},location:{search},URLSearchParams,
    localStorage:{getItem:key=>data.get(key)??null,setItem(key,value){if(blocked)throw Error('quota');data.set(key,value)},removeItem:key=>data.delete(key)},
    navigator:{clipboard:{writeText:async text=>copied.push(text)}},setTimeout:()=>1,clearTimeout(){}});
  vm.runInContext(source,ctx);
  return {run:code=>vm.runInContext(code,ctx),query,events,copied};
}
function save(p,id) {assert.equal(p.run(`saveHistory({id:${id},time:${id},item_name:'Title ${id}',item_highlights:'Highlights ${id}'})`),true)}
function records(p){return JSON.parse(p.run('JSON.stringify(getHistory())'))}
(async()=>{
  const a=page('?store_case_id=LINK1&store_sku=SKU-A');
  for(let i=1;i<=12;i++)save(a,i);
  const b=page('?store_case_id=LINK1&store_sku=SKU-B');
  for(let i=101;i<=104;i++)save(b,i);
  assert.equal(records(a).length,10);assert.equal(records(a)[0].id,12);assert.equal(records(a).at(-1).id,3);
  assert.equal(records(b).length,4);assert.ok(records(a).every(r=>r.store_sku==='SKU-A'&&r.store_case_id==='LINK1'));
  assert.equal(records(page('?store_sku=SKU-A&store_case_id=LINK1')).length,10,'Refresh and standalone/embed URLs use the same scope');
  const otherLink=page('?store_case_id=LINK2&store_sku=SKU-A');save(otherLink,201);
  assert.equal(records(a).length,10,'Identical SKUs on other links do not overwrite this link');
  assert.equal(records(page('?store_case_id=LINK1&store_sku=SKU-a')).length,0,'Preserve exact SKU identity');
  const standalone=page('');save(standalone,301);
  assert.equal(records(a).length,10);assert.equal(records(standalone).length,1);
  assert.equal(data.get(legacyKey),legacy,'Global legacy archive is never reassigned or overwritten');
  assert.equal(a.query('#legacyHistory').hidden,false);
  await a.query('#legacyHistoryList').children[0].children[2].children[0].handlers.click();
  assert.equal(a.copied[0],'Old unassigned title','Legacy records remain copyable');
  a.run('deleteHistory(12)');assert.equal(records(a).length,9);assert.equal(records(b).length,4);
  a.query('#clearHistory').handlers.click();assert.equal(records(a).length,0);
  assert.equal(records(b).length,4);assert.equal(records(otherLink).length,1);assert.equal(data.get(legacyKey),legacy);
  const prior=JSON.stringify(records(b));blocked=true;
  assert.equal(b.run("saveHistory({id:105,item_name:'Unsaved',item_highlights:'Copy manually'})"),false);
  blocked=false;assert.equal(JSON.stringify(records(b)),prior,'Quota failure preserves previous records');
  const key=b.run('historyKey');data.set(key,'broken-json');
  assert.equal(b.run("saveHistory({id:106,item_name:'Do not overwrite corrupt storage'})"),false);
  assert.equal(data.get(key),'broken-json');
  data.set(key,prior);b.events.storage({key});assert.equal(b.query('#historyList').children.length,4);
  console.log('SKU history: independent quotas, link isolation, reload, scoped deletion/clear, legacy copy and storage failures passed');
})().catch(error=>{console.error(error);process.exitCode=1});
