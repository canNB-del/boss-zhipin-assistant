// The cross-origin extension frame keeps credentials out of the website DOM.
(() => {
  let host=null;
  function openPanel(){
    if(host?.isConnected)return;
    host=document.createElement('div');
    host.setAttribute('data-boss-assistant-panel','');
    host.style.cssText='all:initial!important;position:fixed!important;top:12px!important;right:12px!important;width:min(420px,calc(100vw - 24px))!important;height:min(760px,calc(100vh - 24px))!important;z-index:2147483647!important;display:block!important;';
    const shadow=host.attachShadow({mode:'open'});
    const style=document.createElement('style');
    style.textContent=':host{color-scheme:light}iframe{display:block;width:100%;height:100%;box-sizing:border-box;border:1px solid #d9dfe7;border-radius:12px;background:white;box-shadow:0 8px 32px #0003}';
    const frame=document.createElement('iframe');
    frame.src=chrome.runtime.getURL('popup.html')+'?embedded=1';
    frame.title='Boss 直聘应聘助手浮窗';
    shadow.append(style,frame);document.documentElement.appendChild(host);
  }
  function closePanel(){host?.remove();host=null;}
  chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
    if(message?.type==='openAssistantPanel'){openPanel();sendResponse({ok:true});}
    if(message?.type==='closeAssistantPanel'){closePanel();sendResponse({ok:true});}
  });
  chrome.runtime.sendMessage({type:'assistantContentReady'}).catch(()=>{});
})();
