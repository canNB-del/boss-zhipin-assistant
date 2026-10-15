const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const appended=[],handlers={};
function element(tag){return {tag,style:{},children:[],isConnected:false,setAttribute(){},attachShadow(options){assert.equal(options.mode,'open');return {append:(...nodes)=>this.children.push(...nodes)};},remove(){this.isConnected=false;}};}
const ctx=vm.createContext({document:{createElement:element,documentElement:{appendChild(host){host.isConnected=true;appended.push(host);}}},chrome:{runtime:{getURL:()=> 'chrome-extension://test/popup.html',onMessage:{addListener(fn){handlers.message=fn;}},async sendMessage(){return {ok:true};}}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'floating-panel.js'),'utf8'),ctx);
handlers.message({type:'openAssistantPanel'},null,()=>{});assert.equal(appended.length,1);
assert(appended[0].style.cssText.includes('position:fixed'));assert(appended[0].style.cssText.includes('right:12px'));
assert.equal(appended[0].children[1].src,'chrome-extension://test/popup.html?embedded=1');
handlers.message({type:'openAssistantPanel'},null,()=>{});assert.equal(appended.length,1,'repeat click preserves the existing frame and drafts');
handlers.message({type:'unrelated'},null,()=>{});assert(appended[0].isConnected);
handlers.message({type:'closeAssistantPanel'},null,()=>{});assert(!appended[0].isConnected);
handlers.message({type:'openAssistantPanel'},null,()=>{});assert.equal(appended.length,2);assert(appended[1].isConnected);
console.log('PASS fixed floating frame, extension origin isolation, duplicate-open preservation, explicit close and reopen');
