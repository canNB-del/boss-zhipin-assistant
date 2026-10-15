const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=__dirname,source=fs.readFileSync(path.join(root,'background.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const url='chrome-extension://synthetic-id/popup.html';
const boss={id:10,url:'https://www.zhipin.com/web/chat/index',title:'Synthetic BOSS chat',active:true};
const tabs=new Map([[10,boss]]),session={},handlers={},created=[],updated=[];let windows=[];
const ctx=vm.createContext({URL,console,chrome:{
 runtime:{getURL:()=>url,onMessage:{addListener(fn){handlers.message=fn;}}},
 storage:{session:{async get(){return {...session};},async set(data){Object.assign(session,data);}}},
 action:{onClicked:{addListener(fn){handlers.click=fn;}}},
 tabs:{async get(id){if(!tabs.has(id))throw Error('closed');return tabs.get(id);},onActivated:{addListener(fn){handlers.activated=fn;}},onUpdated:{addListener(fn){handlers.updated=fn;}}},
 windows:{async getAll(){return windows;},async update(id,options){updated.push({id,options});},async create(options){created.push(options);windows=[{id:42,tabs:[{url}]}];}}
}});
vm.runInContext(source,ctx);
const query=(sender={url})=>new Promise(resolve=>{const result=handlers.message({type:'getBossTarget'},sender,resolve);if(!result)resolve('ignored');});
(async()=>{
 assert(!manifest.action.default_popup);assert.equal(manifest.background.service_worker,'background.js');
 await Promise.all([handlers.click(boss),handlers.click(boss)]);assert.equal(created.length,1);assert.equal(updated.length,1);
 assert.equal(created[0].type,'popup');assert.equal(created[0].url,url);assert((await query()).tab.id===10);
 const other={id:11,url:'https://www.zhipin.com/job_detail/synthetic',active:true};tabs.set(11,other);await handlers.activated({tabId:11});assert((await query()).tab.id===11);
 tabs.set(12,{id:12,url:'https://other.example/'});await handlers.activated({tabId:12});assert((await query()).tab.id===11);
 assert.equal(await query({url:'https://www.zhipin.com/'}),'ignored');
 tabs.set(11,{id:11,url:'https://other.example/'});assert.equal((await query()).tab,null);
 await handlers.updated(10,{url:boss.url},boss);assert((await query()).tab.id===10);
 tabs.delete(10);assert.equal((await query()).tab,null);
 windows=[];await handlers.click({id:12,url:'https://other.example/'});assert.equal(created.length,2);
 console.log('PASS independent window, repeat-click reuse, BOSS target across focus changes, navigation/closed tabs, trusted sender and reopen');
})().catch(error=>{console.error(error);process.exitCode=1;});
