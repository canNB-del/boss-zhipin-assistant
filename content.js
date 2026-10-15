function isVisible(el){
  return Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility!=='hidden');
}
function findEditor(){
  const selectors=['textarea[placeholder*="沟通"]','textarea[placeholder*="消息"]','textarea[placeholder*="输入"]','[contenteditable="true"][role="textbox"]','[contenteditable="true"]','textarea'];
  for(const selector of selectors){
    const candidates=Array.from(document.querySelectorAll(selector)).filter(el=>isVisible(el) && !el.disabled && !el.readOnly && !el.closest('[role="search"]') && !/搜索|search/i.test(el.getAttribute('placeholder')||''));
    if(candidates.length===1)return candidates[0];
    if(candidates.length>1)return null;
  }
  return null;
}
function setNativeValue(el,value){
  const proto=el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
  if(setter)setter.call(el,value);else el.value=value;
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
}
function visibleText(el){
  if(!isVisible(el))return '';
  const text=(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
  return text.length>=1 && text.length<=3000 ? text : '';
}
function latestHrMessage(){
  const selected=window.getSelection()?.toString().trim();
  if(selected)return selected;
  const selectors=['[class*="message"] [class*="text"]','[class*="msg"] [class*="text"]','[class*="message"]','[class*="msg"]'];
  for(const selector of selectors){
    const candidates=Array.from(document.querySelectorAll(selector)).filter(el=>!el.isContentEditable && !el.closest('[contenteditable="true"]')).map(visibleText).filter(Boolean);
    if(candidates.length)return candidates.at(-1);
  }
  return '';
}
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type==='getLatestHrMessage'){sendResponse({text:latestHrMessage()});return;}
  if(msg.type!=='fill')return;
  try{
    if(typeof msg.text!=='string' || !msg.text.trim())throw new Error('消息为空');
    const el=findEditor();
    if(!el)throw new Error('未找到唯一的可见聊天输入框，请先打开沟通窗口');
    const current=el.isContentEditable?(el.innerText||el.textContent||''):el.value;
    if(current.trim() && current.trim()!==msg.text.trim())throw new Error('输入框已有草稿，为避免覆盖，请先保存或清空原文');
    el.focus();
    if(el.isContentEditable){
      const range=document.createRange();range.selectNodeContents(el);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('insertText',false,msg.text))throw new Error('页面不支持文本插入，请手动复制草稿');
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:msg.text}));
    }else setNativeValue(el,msg.text);
    const result=el.isContentEditable?(el.innerText||el.textContent||''):el.value;
    if(result.trim()!==msg.text.trim())throw new Error('页面未接受完整文本，请核对输入框或手动复制');
    sendResponse({ok:true});
  }catch(error){sendResponse({ok:false,error:error.message});}
});
