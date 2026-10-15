const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=__dirname,source=fs.readFileSync(path.join(root,'api-client.js'),'utf8');
function transport(fetch){const ctx=vm.createContext({URL,AbortController,setTimeout,clearTimeout,fetch});vm.runInContext(source,ctx);return ctx.AiConnection;}
const api=transport(async()=>{});let passed=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{passed++;console.log('PASS '+name);});}
(async()=>{
 await test('normalize official, relay roots, nested base paths, full URLs and loopback ports',()=>{
  for(const [value,expected] of [
   ['https://api.openai.com','https://api.openai.com/v1/chat/completions'],
   ['https://relay.example/v1/','https://relay.example/v1/chat/completions'],
   ['https://vendor.example/compatible-mode/v1','https://vendor.example/compatible-mode/v1/chat/completions'],
   ['https://vendor.example/api/chat/completions/','https://vendor.example/api/chat/completions'],
   ['http://127.0.0.1:9000/v1','http://127.0.0.1:9000/v1/chat/completions']])assert.equal(api.resolve(value).endpoint,expected);
  assert.equal(api.resolve('https://relay.example:8443/v1').originPattern,'https://relay.example/*');
 });
 await test('reject credentials, query secrets, unsafe schemes and unsupported native APIs',()=>{
  for(const value of ['', 'javascript:alert(1)','http://remote.example/v1','https://user:pass@relay.example/v1','https://relay.example/v1?key=secret','https://relay.example/v1#secret','https://relay.example/v1/messages','https://relay.example/v1/responses','https://relay.example/v1/models','https://relay.example/a b','https:\\relay.example'])assert.throws(()=>api.resolve(value),value);
 });
 await test('custom destination, exact model, bearer authentication and no credential redirects',async()=>{
  let seen;const client=transport(async(url,options)=>{seen={url,options};return {ok:true,status:200,json:async()=>({choices:[{message:{content:' OK '}}]})};});
  const text=await client.complete({endpoint:'https://relay.example/v1/chat/completions',model:'vendor/model-id',key:'synthetic-key',messages:[{role:'user',content:'test'}]});
  assert.equal(text,'OK');assert.equal(seen.url,'https://relay.example/v1/chat/completions');assert.equal(seen.options.headers.Authorization,'Bearer synthetic-key');assert.equal(seen.options.redirect,'error');assert.equal(seen.options.credentials,'omit');const body=JSON.parse(seen.options.body);assert.equal(body.model,'vendor/model-id');assert.equal(body.stream,false);assert(!('temperature' in body));
 });
 await test('text-part response compatibility',async()=>{
  const client=transport(async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:[{type:'text',text:'第一段'},{type:'image_url',image_url:{}},{type:'text',text:'第二段'}]}}]})}));
  assert.equal(await client.complete({endpoint:'https://relay.example/v1/chat/completions',model:'custom',key:'fake',messages:[]}),'第一段\n第二段');
 });
 await test('HTTP, HTML, empty reply and timeout errors, with key redaction',async()=>{
  const variants=[
   [async()=>({ok:false,status:401,json:async()=>({error:{message:'invalid synthetic-secret'}})}),/HTTP 401/],
   [async()=>({ok:false,status:502,json:async()=>{throw Error('HTML');}}),/JSON/],
   [async()=>({ok:true,status:200,json:async()=>({choices:[]})}),/没有返回/],
   [async()=>{const error=Error('aborted');error.name='AbortError';throw error;},/60 秒/],
   [async()=>({ok:true,status:200,json:async()=>{const error=Error('aborted body');error.name='AbortError';throw error;}}),/60 秒/]
  ];
  for(const [fetch,pattern] of variants){const client=transport(fetch);await assert.rejects(client.complete({endpoint:'https://relay.example/v1/chat/completions',model:'custom',key:'synthetic-secret',messages:[]}),error=>pattern.test(error.message) && !error.message.includes('synthetic-secret'));}
 });
 const html=fs.readFileSync(path.join(root,'popup.html'),'utf8');
 function boot(store={},installedVersion='0.7.1'){
  const nodes={};for(const [,id] of html.matchAll(/id="([^"]+)"/g))nodes[id]={value:'',hidden:false,disabled:false,textContent:'',replaceChildren(){},appendChild(){}};
  nodes.template.value='通用模板';nodes.baseUrl.value='https://api.openai.com/v1';nodes.model.value='gpt-4o-mini';
  const state={allowed:true,requests:[],grants:[],next:null,permissionError:null};
  const ctx=vm.createContext({URL,AbortController,setTimeout,clearTimeout,document:{getElementById:id=>nodes[id],createElement:()=>({})},confirm:()=>true,
   chrome:{runtime:{getManifest(){return {version:installedVersion};}},permissions:{async request(options){state.grants.push(options);if(state.permissionError)throw new Error(state.permissionError);return state.allowed;}},storage:{local:{async get(defaults,cb){const data={...defaults,...structuredClone(store)};if(cb)cb(data);return data;},async set(data){Object.assign(store,structuredClone(data));},async remove(keys){keys.forEach(key=>delete store[key]);}}}},
   fetch:async(url,options)=>{state.requests.push({url,options,body:JSON.parse(options.body)});if(state.next)return state.next();return {ok:true,status:200,json:async()=>({choices:[{message:{content:'测试回复'}}]})};}});
  vm.runInContext(source,ctx);vm.runInContext(fs.readFileSync(path.join(root,'popup.js'),'utf8'),ctx);
  return {nodes,state,store,ctx};
 }
 const ready=()=>new Promise(resolve=>setImmediate(resolve));
 let app=boot();await ready();
 await test('save connection settings, restore on reopen, never store key',async()=>{
  app.nodes.baseUrl.value='https://relay.example/compatible-mode/v1';app.nodes.model.value='vendor-special';app.nodes.apiKey.value='synthetic-secret';
  await app.nodes.saveAi.onclick();assert.equal(app.store.aiConfig.model,'vendor-special');assert(!JSON.stringify(app.store).includes('synthetic-secret'));
  app=boot(app.store);await ready();assert.equal(app.nodes.baseUrl.value,'https://relay.example/compatible-mode/v1');assert.equal(app.nodes.model.value,'vendor-special');assert.equal(app.nodes.apiKey.value,'');
 });
 await test('connection test requests only selected host and sends no profile',async()=>{
  app.nodes.profileSkills.value='PRIVATE_SYNTHETIC_PROFILE';app.nodes.hrQuestion.value='PRIVATE_SYNTHETIC_QUESTION';app.nodes.apiKey.value='synthetic-secret';
  await app.nodes.testAi.onclick();assert(app.nodes.connectionStatus.textContent.includes('连接成功'));assert.equal(app.state.requests[0].url,'https://relay.example/compatible-mode/v1/chat/completions');assert.deepEqual(JSON.parse(JSON.stringify(app.state.grants[0])),{origins:['https://relay.example/*']});const body=JSON.stringify(app.state.requests[0].body);assert(!body.includes('PRIVATE_SYNTHETIC'));assert.equal(app.nodes.reply.value,'');
 });
 await test('generated reply uses custom route and all profile data, no official fallback',async()=>{
  await app.nodes.generate.onclick();assert.equal(app.nodes.reply.value,'测试回复');const request=app.state.requests.at(-1);assert.equal(request.body.model,'vendor-special');assert(request.body.messages[1].content.includes('PRIVATE_SYNTHETIC_PROFILE'));assert(!app.state.requests.some(request=>request.url.includes('api.openai.com')));
 });
 await test('denied host permission and invalid config never send a request',async()=>{
  const count=app.state.requests.length;app.state.allowed=false;await app.nodes.testAi.onclick();assert.equal(app.state.requests.length,count);assert(app.nodes.connectionStatus.textContent.includes('未发送请求'));
  app.state.allowed=true;app.nodes.baseUrl.value='http://remote.example';await app.nodes.generate.onclick();assert.equal(app.state.requests.length,count);assert(app.nodes.connectionStatus.textContent.includes('HTTPS'));
  app.nodes.baseUrl.value='https://relay.example/v1';app.nodes.model.value='';await app.nodes.testAi.onclick();assert.equal(app.state.requests.length,count);
 });
 await test('failed provider request preserves draft, no retry or fallback',async()=>{
  app.nodes.model.value='vendor-special';app.nodes.reply.value='现有草稿';app.state.next=async()=>({ok:false,status:401,json:async()=>({error:{message:'invalid synthetic-secret'}})});
  const count=app.state.requests.length;await app.nodes.generate.onclick();assert.equal(app.state.requests.length,count+1);assert.equal(app.nodes.reply.value,'现有草稿');assert(app.nodes.connectionStatus.textContent.includes('HTTP 401'));assert(!app.nodes.connectionStatus.textContent.includes('synthetic-secret'));assert(!app.nodes.generate.disabled);app.state.next=null;
 });
 await test('profile change during request discards stale reply',async()=>{
  app.state.next=async()=>{app.nodes.profileSkills.value='new profile';return {ok:true,status:200,json:async()=>({choices:[{message:{content:'stale reply'}}]})};};
  await app.nodes.generate.onclick();assert.equal(app.nodes.reply.value,'现有草稿');assert(app.nodes.connectionStatus.textContent.includes('资料或问题已改变'));
 });
 await test('manifest uses optional host grants and only required BOSS access',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));assert.deepEqual(manifest.host_permissions,['https://www.zhipin.com/*']);assert(manifest.optional_host_permissions.includes('https://*/*'));assert(!manifest.permissions.includes('<all_urls>'));
 });
 await test('stale loaded manifest shows reload instructions, sends nothing and keeps local data',async()=>{
  const saved={profileSchemaVersion:1,profileData:{profileSkills:'SYNTHETIC_SAVED_PROFILE'},aiConfig:{baseUrl:'https://relay.example',model:'relay-model'},jobs:[{job:'Synthetic role'}]};
  const before=JSON.stringify(saved),old=boot(saved,'0.6.0');await ready();
  assert(old.nodes.extensionVersion.textContent.includes('浏览器加载 v0.6.0'));
  assert(old.nodes.connectionStatus.textContent.includes('仍加载旧版'));
  old.state.permissionError='Only permissions specified in the manifest may be requested.';
  old.nodes.apiKey.value='synthetic-secret';await old.nodes.testAi.onclick();
  assert.equal(old.state.requests.length,0);assert.equal(JSON.stringify(saved),before);
  assert(old.nodes.connectionStatus.textContent.includes('请求尚未发送'));
  assert(old.nodes.connectionStatus.textContent.includes('重新加载'));
  assert(old.nodes.connectionStatus.textContent.includes('请勿卸载'));
  assert(!old.nodes.connectionStatus.textContent.includes('synthetic-secret'));
  assert(!old.nodes.testAi.disabled);
  const reloaded=boot(saved);await ready();reloaded.nodes.apiKey.value='synthetic-secret';await reloaded.nodes.testAi.onclick();
  assert(reloaded.nodes.connectionStatus.textContent.includes('连接成功'));
  assert.equal(reloaded.state.requests[0].url,'https://relay.example/v1/chat/completions');
  assert.equal(reloaded.nodes.profileSkills.value,'SYNTHETIC_SAVED_PROFILE');
 });
 await test('popup and manifest versions match in the release package',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  const popup=fs.readFileSync(path.join(root,'popup.js'),'utf8');
  assert(popup.includes("const popupVersion='"+manifest.version+"'"));
  assert(html.includes('界面版本 v'+manifest.version));
 });
 console.log(passed+' API configuration checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
