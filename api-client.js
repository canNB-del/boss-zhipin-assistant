/* OpenAI-compatible Chat Completions transport. No provider credentials are stored. */
(() => {
  function resolve(value) {
    const input=String(value||'').trim();
    if(!input)throw new Error('请填写服务商提供的 API 接口地址。');
    if(/[\s\\]/.test(input))throw new Error('接口地址不能包含空格或反斜线。');
    let url;try{url=new URL(input);}catch{throw new Error('接口地址无效，请填写以 https:// 开头的完整地址。');}
    const loopback=['localhost','127.0.0.1'].includes(url.hostname);
    if(url.protocol!=='https:' && !(url.protocol==='http:' && loopback))throw new Error('在线接口请使用 HTTPS；HTTP 仅支持 localhost 或 127.0.0.1 本机服务。');
    if(url.username || url.password || url.search || url.hash)throw new Error('接口地址不能包含账号、密码、查询参数或片段；密钥请填在 API Key 中。');
    const path=url.pathname.replace(/\/+$/,'');
    if(/\/(?:responses|messages|models)$/i.test(path))throw new Error('这里需要 OpenAI 兼容的 Chat Completions 地址，请使用服务商的兼容接口。');
    url.pathname=/\/chat\/completions$/.test(path)?path:(path?path+'/chat/completions':'/v1/chat/completions');
    return {endpoint:url.href,originPattern:url.protocol+'//'+url.hostname+'/*'};
  }
  function errorMessage(error,key='') {
    const message=String(error?.message||error||'请求失败');
    return key?message.split(key).join('[密钥已隐藏]'):message;
  }
  async function complete({endpoint,model,key,messages}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
    try{
      const response=await fetch(endpoint,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model,messages,stream:false})});
      let data;try{data=await response.json();}catch(error){
        if(error.name==='AbortError')throw error;
        throw new Error('HTTP '+response.status+'：接口未返回 JSON，请确认填写的是 API 地址，而非登录页或网页聊天地址。');
      }
      if(!response.ok || data?.error){
        const detail=typeof data?.error==='string'?data.error:data?.error?.message;
        throw new Error('HTTP '+response.status+'：'+(detail||'请求失败，请核对服务商的密钥、模型名称和额度。'));
      }
      const content=data?.choices?.[0]?.message?.content;
      const text=(typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text' && typeof part.text==='string').map(part=>part.text).join('\n'):'').trim();
      if(!text)throw new Error('接口没有返回回复正文，请确认该服务支持非流式 Chat Completions 及所填模型。');
      return text;
    }catch(error){
      if(error.name==='AbortError')throw new Error('请求超过 60 秒，请稍后重试或更换模型。');
      if(error.name==='TypeError')throw new Error('无法连接接口，请核对 API 地址、浏览器授权、网络和服务商的跨域访问支持。');
      throw new Error(errorMessage(error,key));
    }finally{clearTimeout(timer);}
  }
  globalThis.AiConnection=Object.freeze({resolve,complete,errorMessage});
})();
