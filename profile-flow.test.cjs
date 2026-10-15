const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=__dirname,html=fs.readFileSync(path.join(root,'popup.html'),'utf8');
const fields=['profileName','profileEducation','profileExperience','profileSkills','profilePreferences','profileSupplement'];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function boot(store={}){
 const nodes={};for(const [,id] of html.matchAll(/id="([^"]+)"/g))nodes[id]={value:'',hidden:false,disabled:false,checked:false,textContent:'',replaceChildren(){},appendChild(){}};
 nodes.baseUrl.value='https://api.openai.com/v1';
 nodes.template.value=html.match(/<textarea id="template">([^<]*)<\/textarea>/)[1];nodes.model.value='test-model';
 const state={fail:false,requests:[]};
 const ctx=vm.createContext({URL,AbortController,setTimeout,clearTimeout,TextDecoder,Uint8Array,DataView,document:{getElementById:id=>nodes[id],createElement:()=>({})},
  chrome:{permissions:{async request(){return true;}},storage:{local:{async get(defaults,cb){const result={...structuredClone(defaults),...structuredClone(store)};if(cb)cb(result);return result;},async set(data){if(state.fail && data.profileData)throw Error('test storage failure');Object.assign(store,structuredClone(data));},async remove(keys){keys.forEach(key=>delete store[key]);}}}},
  confirm:()=>true,alert:message=>{throw Error(message);},fetch:async(url,options)=>{state.requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({choices:[{message:{content:'草稿'}}]})};}});
 vm.runInContext(fs.readFileSync(path.join(root,'api-client.js'),'utf8'),ctx);
 vm.runInContext(fs.readFileSync(path.join(root,'resume-parser.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(root,'popup.js'),'utf8'),ctx);
 const run=code=>vm.runInContext(code,ctx),upload=async(text,name='example.txt',wait)=>{
  const bytes=Buffer.from(text);await nodes.resumeFile.onchange({target:{files:[{name,size:bytes.length,arrayBuffer:async()=>{if(wait)await wait;return Uint8Array.from(bytes).buffer;}}]}});
 };
 return {ctx,nodes,store,state,run,upload};
}
(async()=>{
 let app=boot();await flush();
 assert(app.nodes.modeResume.checked && app.nodes.manualPanel.hidden,'default upload mode');
 assert(!html.includes('id="applyResume"') && !html.includes('id="resumeUnclassified"'),'no required review controls');
 await app.upload('姓名：李明\n补充备注：可接受轮班\n教育经历\n示例大学 | 本科\n技术能力：SQL');
 assert.equal(app.store.profileData.profileName,'李明');assert.equal(app.store.profileData.profileSkills,'SQL');
 assert(app.store.profileData.profileSupplement.includes('可接受轮班'),'uncategorized facts saved');
 assert(app.nodes.manualPanel.hidden && !app.nodes.undoResume.hidden,'no manual step');
 app.nodes.apiKey.value='test-key';app.nodes.hrQuestion.value='能轮班吗？';await app.run('generate()');
 assert(JSON.parse(app.state.requests[0].messages[1].content).candidateProfile.includes('可接受轮班'),'generation uses imported facts');
 assert.equal(app.store.aiCredential.key,'test-key','key retained');
 const saved=structuredClone(app.store);app=boot(app.store);await flush();
 assert(app.nodes.modeResume.checked && app.nodes.manualPanel.hidden,'upload mode survives reopen');
 assert.equal(app.nodes.profileName.value,'李明');
 await app.nodes.modeManual.onchange();assert(!app.nodes.manualPanel.hidden && app.nodes.resumePanel.hidden,'manual choice');
 app.nodes.profileSkills.value='Java';await app.nodes.saveProfile.onclick();assert.equal(app.store.profileData.profileSkills,'Java');assert.equal(app.store.profileMode,'manual');
 await app.nodes.modeResume.onchange();const before=structuredClone(app.store.profileData);
 await app.upload('不带标题的经历事实');assert(app.store.profileData.profileSupplement.includes('不带标题'),'unstructured resume also auto saves');
 assert.equal(app.store.profileData.profileName,'','new resume clears stale fields');
 await app.nodes.undoResume.onclick();assert.deepEqual(app.store.profileData,before,'undo restores all facts');
 app.state.fail=true;await app.upload('姓名：王敏\n技能：Python');assert.deepEqual(app.store.profileData,before,'failed save retains old storage');assert.equal(app.nodes.profileName.value,before.profileName,'failed save retains UI');assert(app.nodes.resumeStatus.textContent.includes('保存失败'));
 app.state.fail=false;await app.upload('','empty.txt');assert.deepEqual(app.store.profileData,before,'parse failure retains profile');assert(app.nodes.resumeStatus.textContent.includes('解析失败'));
 let release;const pause=new Promise(resolve=>release=resolve);const pending=app.upload('技能：Rust','example.txt',pause);await flush();
 assert(app.nodes.modeManual.disabled && app.nodes.profileName.disabled && app.nodes.generate.disabled,'busy controls locked');
 await app.nodes.modeManual.onchange();assert.equal(app.store.profileMode,'resume','mode cannot change during parse');
 release();await pending;assert.equal(app.store.profileData.profileSkills,'Rust');assert(!app.nodes.generate.disabled,'controls unlocked');
 await app.nodes.clearLocal.onclick();assert(!app.store.profileData && !app.store.profileMode);assert.equal(app.store.aiCredential.key,'test-key');assert.equal(app.nodes.apiKey.value,'test-key');assert(app.nodes.modeResume.checked);fields.forEach(id=>assert.equal(app.nodes[id].value,''));
 app=boot(saved);await flush();await app.nodes.undoResume.onclick();assert.deepEqual(app.store.profileData,saved.profileData,'undo unavailable after reopening');
 console.log('PASS auto upload/save, no manual step, unclassified context, reply generation, reopen/mode persistence, manual save, full replacement, undo, parse/save failures, busy state and clear');
})().catch(error=>{console.error(error);process.exitCode=1;});
