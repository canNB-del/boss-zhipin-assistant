const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=__dirname,source=fs.readFileSync(path.join(root,'background.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const url='chrome-extension://synthetic-id/popup.html';
const boss={id:10,url:'https://www.zhipin.com/web/chat/index',windowId:1,lastAccessed:10};
const tabs=new Map([[10,boss]]),session={},handlers={},sent=[],updated=[];let unavailable=false;
const ctx=vm.createContext({URL,console,chrome:{
 runtime:{getURL:()=>url,onMessage:{addListener(fn){handlers.message=fn;}}},
 storage:{session:{async get(){return structuredClone(session);},async set(data){Object.assign(session,structuredClone(data));}}},
 action:{onClicked:{addListener(fn){handlers.click=fn;}},async setBadgeText(){},async setTitle(){}},
 tabs:{async get(id){if(!tabs.has(id))throw Error('closed');return tabs.get(id);},async query(){return [...tabs.values()].filter(tab=>tab.url.startsWith('https://www.zhipin.com/'));},async update(id,options){updated.push({id,options});},async create(){const tab={id:99,url:'https://www.zhipin.com/',windowId:1};tabs.set(99,tab);return tab;},async sendMessage(tabId,message,options){if(unavailable)throw Error('reload required');sent.push({tabId,message,options});return {ok:true};},onRemoved:{addListener(fn){handlers.removed=fn;}}},
 windows:{async update(){} /* No window creation API: regression must fail if used. */}
}});
vm.runInContext(source,ctx);
const query=(type,sender={url:url+'?embedded=1',tab:boss})=>new Promise(resolve=>{const result=handlers.message({type},sender,resolve);if(!result)resolve('ignored');});
(async()=>{
 assert(!manifest.action.default_popup);assert.equal(manifest.background.service_worker,'background.js');assert(manifest.content_scripts[0].js.includes('floating-panel.js'));
 assert.deepEqual(manifest.web_accessible_resources,[{resources:['popup.html'],matches:['https://www.zhipin.com/*']}]);
 await handlers.click(boss);assert.equal(sent[0].message.type,'openAssistantPanel');assert.equal(sent[0].options.frameId,0);assert(session.assistantOpenTabs.includes(10));
 await handlers.click(boss);assert.equal(session.assistantOpenTabs.length,1);assert.equal((await query('getBossTarget')).tab.id,10);
 const other={id:11,url:'https://www.zhipin.com/job_detail/synthetic',windowId:1,lastAccessed:20};tabs.set(11,other);
 assert.equal((await query('getBossTarget')).tab.id,10,'embedded panel remains bound to its own tab');
 assert.equal(await query('closeAssistantPanel',{url:'https://www.zhipin.com/',tab:boss}),'ignored');
 assert.equal(await query('getBossTarget',{url:url+'?embedded=1',tab:{id:12,url:'https://other.example/'}}),'ignored');
 await query('assistantContentReady',{url:boss.url,tab:boss,frameId:0});assert.equal(sent.at(-1).message.type,'openAssistantPanel');
 assert((await query('closeAssistantPanel')).ok);assert.equal(sent.at(-1).message.type,'closeAssistantPanel');assert(!session.assistantOpenTabs.includes(10));
 const count=sent.length;await query('assistantContentReady',{url:boss.url,tab:boss,frameId:0});assert.equal(sent.length,count,'closed panel stays closed after refresh');
 await handlers.click({id:12,url:'https://other.example/'});assert.equal(sent.at(-1).tabId,11);assert.equal(updated.at(-1).id,11);
 tabs.set(10,{id:10,url:'https://other.example/'});assert.equal((await query('getBossTarget')).tab,null);tabs.delete(10);assert.equal((await query('getBossTarget')).tab,null);
 unavailable=true;await handlers.click(other);assert(session.assistantOpenTabs.includes(11));unavailable=false;
 await query('assistantContentReady',{url:other.url,tab:other,frameId:0});assert.equal(sent.at(-1).tabId,11);
 await handlers.removed(11);assert(!session.assistantOpenTabs.includes(11));tabs.clear();await handlers.click({id:12,url:'https://other.example/'});assert(session.assistantOpenTabs.includes(99));
 console.log('PASS in-page panel launch, same-tab targeting, close routing, refresh restoration, sender validation, deferred opening and cleanup; no separate window');
})().catch(error=>{console.error(error);process.exitCode=1;});
