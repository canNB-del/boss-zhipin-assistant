// Open a floating panel inside BOSS; never create a separate browser window.
const assistantUrl=chrome.runtime.getURL('popup.html');
const isBossTab=tab=>{
  try{const url=new URL(tab?.url);return url.protocol==='https:' && url.hostname==='www.zhipin.com';}catch{return false;}
};
const isAssistant=sender=>sender.url===assistantUrl+'?embedded=1' && isBossTab(sender.tab);
let panelStateWrites=Promise.resolve();
function setPanelOpen(tabId,open){
  const next=panelStateWrites.catch(()=>{}).then(async()=>{
    const {assistantOpenTabs=[]}=await chrome.storage.session.get('assistantOpenTabs');
    const ids=new Set(assistantOpenTabs);if(open)ids.add(tabId);else ids.delete(tabId);
    await chrome.storage.session.set({assistantOpenTabs:[...ids]});
  });
  panelStateWrites=next;return next;
}
async function showPanel(tabId){
  try{
    await chrome.tabs.sendMessage(tabId,{type:'openAssistantPanel'},{frameId:0});
    await chrome.action.setBadgeText({tabId,text:''});
    await chrome.action.setTitle({tabId,title:'打开 Boss 直聘应聘助手'});
  }catch{
    await chrome.action.setBadgeText({tabId,text:'刷新'});
    await chrome.action.setTitle({tabId,title:'请刷新 BOSS 页面以加载助手浮窗'});
  }
}
async function openAssistant(tab){
  if(!isBossTab(tab)){
    const candidates=await chrome.tabs.query({url:'https://www.zhipin.com/*'});
    tab=candidates.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0];
    if(!tab){
      const created=await chrome.tabs.create({url:'https://www.zhipin.com/'});
      await setPanelOpen(created.id,true);await showPanel(created.id);return;
    }
    await chrome.tabs.update(tab.id,{active:true});
    await chrome.windows.update(tab.windowId,{focused:true});
  }
  await setPanelOpen(tab.id,true);await showPanel(tab.id);
}
chrome.action.onClicked.addListener(tab=>openAssistant(tab).catch(error=>console.error('无法打开助手浮窗：',error.message)));
chrome.tabs.onRemoved.addListener(tabId=>setPanelOpen(tabId,false).catch(()=>{}));
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type==='assistantContentReady' && isBossTab(sender.tab) && sender.frameId===0){
    (async()=>{
      await panelStateWrites;
      const {assistantOpenTabs=[]}=await chrome.storage.session.get('assistantOpenTabs');
      if(assistantOpenTabs.includes(sender.tab.id))await showPanel(sender.tab.id);
      sendResponse({ok:true});
    })().catch(()=>sendResponse({ok:false}));return true;
  }
  if(!isAssistant(sender))return;
  if(message?.type==='getBossTarget'){
    chrome.tabs.get(sender.tab.id).then(tab=>sendResponse({tab:isBossTab(tab)?tab:null}),()=>sendResponse({tab:null}));return true;
  }
  if(message?.type==='closeAssistantPanel'){
    (async()=>{
      await setPanelOpen(sender.tab.id,false);
      await chrome.tabs.sendMessage(sender.tab.id,{type:'closeAssistantPanel'},{frameId:0});
      sendResponse({ok:true});
    })().catch(()=>sendResponse({ok:false}));return true;
  }
});
