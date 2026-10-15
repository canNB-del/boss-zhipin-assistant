// Keep the assistant open independently of toolbar focus and track the BOSS tab.
const assistantUrl=chrome.runtime.getURL('popup.html');
const isBossTab=tab=>{
  try{const url=new URL(tab?.url);return url.protocol==='https:' && url.hostname==='www.zhipin.com';}catch{return false;}
};
async function rememberBossTab(tab){
  if(isBossTab(tab))await chrome.storage.session.set({bossTargetTabId:tab.id});
}
async function getBossTab(){
  const {bossTargetTabId}=await chrome.storage.session.get('bossTargetTabId');
  if(!Number.isInteger(bossTargetTabId))return null;
  try{const tab=await chrome.tabs.get(bossTargetTabId);return isBossTab(tab)?tab:null;}catch{return null;}
}
async function openAssistant(tab){
  await rememberBossTab(tab);
  const windows=await chrome.windows.getAll({populate:true,windowTypes:['popup']});
  const existing=windows.find(win=>win.tabs?.some(item=>item.url===assistantUrl));
  if(existing){await chrome.windows.update(existing.id,{focused:true,state:'normal'});return;}
  await chrome.windows.create({url:assistantUrl,type:'popup',width:460,height:820,focused:true});
}
let opening=Promise.resolve();
chrome.action.onClicked.addListener(tab=>{
  opening=opening.catch(()=>{}).then(()=>openAssistant(tab)).catch(error=>console.error('无法打开助手窗口：',error.message));
  return opening;
});
chrome.tabs.onActivated.addListener(async({tabId})=>{
  try{await rememberBossTab(await chrome.tabs.get(tabId));}catch{/* Tab may close during activation. */}
});
chrome.tabs.onUpdated.addListener(async(_tabId,change,tab)=>{
  if(change.url && tab.active)await rememberBossTab(tab);
});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type!=='getBossTarget' || sender.url!==assistantUrl)return;
  getBossTab().then(tab=>sendResponse({tab}),()=>sendResponse({tab:null}));
  return true;
});
