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
    return {endpoint:url.href,modelsEndpoint:url.href.replace(/\/chat\/completions$/,'/models'),originPattern:url.protocol+'//'+url.hostname+'/*'};
  }
  function errorMessage(error,key='') {
    const message=String(error?.message||error||'请求失败');
    return key?message.split(key).join('[密钥已隐藏]'):message;
  }
  async function requestJson(endpoint,key,method,body) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
    try{
      const options={method,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
        headers:{'Authorization':'Bearer '+key}};
      if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
      const response=await fetch(endpoint,options);
      let data;try{data=await response.json();}catch(error){
        if(error.name==='AbortError')throw error;
        throw new Error('HTTP '+response.status+'：接口未返回 JSON，请确认填写的是 API 地址，而非登录页或网页聊天地址。');
      }
      if(!response.ok || data?.error){
        const detail=typeof data?.error==='string'?data.error:data?.error?.message;
        throw new Error('HTTP '+response.status+'：'+(detail||'请求失败，请核对服务商的密钥、模型名称和额度。'));
      }
      return data;
    }catch(error){
      if(error.name==='AbortError')throw new Error('请求超过 60 秒，请稍后重试或更换模型。');
      if(error.name==='TypeError')throw new Error('无法连接接口，请核对 API 地址、浏览器授权、网络和服务商的跨域访问支持。');
      throw new Error(errorMessage(error,key));
    }finally{clearTimeout(timer);}
  }
  async function complete({endpoint,model,key,messages}) {
    const data=await requestJson(endpoint,key,'POST',{model,messages,stream:false});
    const content=data?.choices?.[0]?.message?.content;
    const text=(typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text' && typeof part.text==='string').map(part=>part.text).join('\n'):'').trim();
    if(!text)throw new Error('接口没有返回回复正文，请确认该服务支持非流式 Chat Completions 及所填模型。');
    return text;
  }
  async function listModels({endpoint,key}) {
    const data=await requestJson(endpoint,key,'GET');
    const items=Array.isArray(data?.data)?data.data:Array.isArray(data)?data:null;
    if(!items)throw new Error('接口未返回模型列表，请确认服务商支持 GET /models；也可手动填写模型名称。');
    const ids=[...new Set(items.filter(item=>typeof item?.id==='string').map(item=>item.id.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    if(!ids.length)throw new Error('该密钥未返回可用模型，请检查模型权限，或手动填写模型名称。');
    return ids;
  }
  globalThis.AiConnection=Object.freeze({resolve,complete,listModels,errorMessage});
})();
