/* Local-only resume text extraction and conservative section mapping. */
(() => {
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_TEXT_CHARS = 100000;
  const MAX_XML_BYTES = 8 * 1024 * 1024;
  const profileFields = ['profileName', 'profileEducation', 'profileExperience', 'profileSkills', 'profilePreferences'];

  function checkText(text) {
    const normalized = text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) throw new Error('没有提取到文字。扫描件或图片简历请先转成可复制文字的 PDF 或 TXT。');
    if (normalized.length > MAX_TEXT_CHARS) throw new Error('简历文字超过 10 万字，请精简后再导入。');
    return normalized;
  }

  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch { return new TextDecoder('gb18030').decode(bytes); }
  }

  // Read document and header XML only; never execute or render document markup.
  async function extractDocx(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0) throw new Error('Word 文件损坏或不是 DOCX 格式。');
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('不支持分卷 DOCX。');
    let offset = view.getUint32(end + 16, true);
    const entries = view.getUint16(end + 10, true);
    const parts = []; let totalXml = 0, foundBody = false;
    for (let i = 0; i < entries; i++) {
      if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('DOCX 目录损坏。');
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
      const packedSize = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
      const nameSize = view.getUint16(offset + 28, true), extraSize = view.getUint16(offset + 30, true), commentSize = view.getUint16(offset + 32, true);
      const next = offset + 46 + nameSize + extraSize + commentSize;
      if (next > end) throw new Error('DOCX 目录不完整。');
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameSize));
      if (name === 'word/document.xml' || /^word\/header\d+\.xml$/.test(name)) {
        if (flags & 1) throw new Error('不支持加密的 Word 文件，请先解除密码。');
        if (size > MAX_XML_BYTES || packedSize > MAX_FILE_BYTES) throw new Error('Word 内容过大，请精简后再导入。');
        const local = view.getUint32(offset + 42, true);
        if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('Word 内容损坏。');
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        if (start + packedSize > bytes.length) throw new Error('Word 内容不完整。');
        let xmlBytes = bytes.subarray(start, start + packedSize);
        if (method === 8) {
          const reader = new Blob([xmlBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
          const chunks = []; let total = 0;
          try {
            while (true) {
              const {value, done} = await reader.read(); if (done) break;
              total += value.length;
              if (total > MAX_XML_BYTES) { await reader.cancel(); throw new Error('Word 解压内容过大。'); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          xmlBytes = new Uint8Array(total); let index = 0;
          for (const chunk of chunks) { xmlBytes.set(chunk, index); index += chunk.length; }
        } else if (method !== 0) throw new Error('不支持这种 DOCX 压缩方式。');
        totalXml += xmlBytes.length;
        if (totalXml > MAX_XML_BYTES) throw new Error('Word 解压内容过大。');
        if (xmlBytes.length !== size) throw new Error('Word 内容大小校验失败。');
        const xml = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) throw new Error('Word 文档结构无法解析。');
        const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
        // Walk once: descendant queries duplicate text in nested textboxes. Skip
        // deleted text and alternate fallback representations of the same shape.
        function read(node) {
          if (['del', 'moveFrom', 'Fallback'].includes(node.localName)) return '';
          if (node.namespaceURI === ns) {
            if (node.localName === 't') return node.textContent;
            if (node.localName === 'tab') return '\t';
            if (['br', 'cr'].includes(node.localName)) return '\n';
          }
          const value = Array.from(node.children || []).map(read).join('');
          return value + (node.namespaceURI === ns && ['p', 'tr', 'tc'].includes(node.localName) ? '\n' : '');
        }
        const value = read(xml.documentElement);
        if (name === 'word/document.xml') { foundBody = true; parts.push(value); }
        else parts.unshift(value);
      }
      offset = next;
    }
    if (!foundBody) throw new Error('DOCX 中找不到正文；请另存为标准 DOCX 或 TXT。');
    return [...new Set(parts)].join('\n');
  }

  // Rebuild visual rows independently of PDF drawing order. Repeated wide gaps
  // identify a two-column gutter; full-width rows form boundaries between bands.
  function layoutPdfItems(items) {
    const tokens = items.filter(item => typeof item.str === 'string' && item.str.trim() && item.transform)
      .map(item => ({text:item.str, x:item.transform[4], y:item.transform[5],
        width:Math.abs(item.width || 0), height:Math.max(1, Math.abs(item.height || item.transform[3] || 10))}))
      .sort((a,b) => b.y-a.y || a.x-b.x);
    const rows = [];
    for (const token of tokens) {
      const row = rows.at(-1);
      if (row && Math.abs(row.y-token.y) <= Math.max(2, Math.min(row.height, token.height)*0.3)) row.items.push(token);
      else rows.push({y:token.y, height:token.height, items:[token]});
    }
    for (const row of rows) {
      row.items.sort((a,b)=>a.x-b.x);
      row.segments=[]; let segment;
      for (const token of row.items) {
        const gap = segment ? token.x-segment.end : 0;
        if (!segment || gap > Math.max(20,token.height*2)) {
          segment={x:token.x,end:token.x+token.width,text:token.text,y:row.y}; row.segments.push(segment);
        } else {
          const cjk = /[\u3400-\u9fff]$/.test(segment.text) || /^[\u3400-\u9fff]/.test(token.text);
          const space = gap > token.height*(cjk ? 0.5 : 0.12) && !/\s$/.test(segment.text) && !/^\s/.test(token.text);
          segment.text += (space ? ' ' : '')+token.text; segment.end=Math.max(segment.end,token.x+token.width);
        }
      }
    }
    const candidates=[];
    for (const row of rows) for (let i=1;i<row.segments.length;i++) {
      const left=row.segments[i-1],right=row.segments[i];
      if (right.x-left.end >= 35) candidates.push((left.end+right.x)/2);
    }
    let gutter=null,best=0;
    for (const x of candidates) {
      const pairedRows=rows.filter(row=>row.segments.some(s=>s.end<x) && row.segments.some(s=>s.x>x));
      const paired=pairedRows.length;
      // Right-aligned dates belong to the same job/school row, not a column.
      const meaningfulRight=pairedRows.filter(row=>row.segments.some(s=>s.x>x && !/^[\d\s.\-/–—~至今年月日今]+$/.test(s.text.trim()))).length;
      const crossing=rows.filter(row=>row.segments.some(s=>s.x<x && s.end>x)).length;
      if (paired>=3 && meaningfulRight>=2 && paired>crossing && paired>best) {gutter=x;best=paired;}
    }
    if (gutter===null) return {text:rows.map(row=>row.segments.map(s=>s.text.trim()).join(' | ')).join('\n'),columns:false};
    const result=[];let band=[];
    const flush=()=>{
      for (const side of [false,true]) for (const row of band) {
        const value=row.segments.filter(s=>(s.x>gutter)===side).map(s=>s.text.trim()).join(' | ');
        if(value)result.push(value);
      }
      band=[];
    };
    for(const row of rows){
      if(row.segments.some(s=>s.x<gutter && s.end>gutter)){flush();result.push(row.segments.map(s=>s.text.trim()).join(' | '));}
      else band.push(row);
    }
    flush();
    return {text:result.join('\n'),columns:true};
  }

  async function extractPdf(bytes) {
    const pdfjs = await import('./pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', document.baseURI).href;
    class LocalCMapReader {
      async fetch({name}) {
        const {default:maps} = await import('./pdf-cmaps.mjs');
        if (!Object.hasOwn(maps,name)) throw new Error('PDF 缺少可用的字符映射：'+name);
        return {cMapData:Uint8Array.from(atob(maps[name]),char=>char.charCodeAt(0)), isCompressed:true};
      }
    }
    const task = pdfjs.getDocument({data:bytes, isEvalSupported:false, useSystemFonts:true, stopAtErrors:true, useWorkerFetch:false, CMapReaderFactory:LocalCMapReader});
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 30) throw new Error('PDF 超过 30 页，请只保留简历正文。');
      const pages = []; let total = 0, columns = false;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), content = await page.getTextContent();
        const layout = layoutPdfItems(content.items), text = layout.text;
        columns ||= layout.columns;
        total += text.length;
        if (total > MAX_TEXT_CHARS) throw new Error('PDF 文字超过 10 万字，请精简后再导入。');
        pages.push(text); page.cleanup();
      }
      return {text:pages.join('\n\n'), warnings:columns ? ['检测到 PDF 双栏排版，已按分栏顺序重排，请核对分节。'] : []};
    } catch (error) {
      if (error.name === 'PasswordException') throw new Error('PDF 有密码保护，请解除密码后重新导入。');
      throw error;
    } finally { await task.destroy(); }
  }

  const headingPatterns = [
    ['profileEducation', /^(教育(?:背景|经历)?|学习经历|学历(?:信息)?|education(?:al background)?)$/i],
    ['profileExperience', /^(工作(?:经历|经验|履历)?|职业经历|实习(?:经历|经验)?|项目(?:经历|经验|实践|介绍)?|实践经历|校园经历|社会实践|科研经历|experience|work experience|employment(?: history)?|internship(?: experience)?|projects?|project experience)$/i],
    ['profileSkills', /^(专业技能|职业技能|技术技能|技术能力|专业能力|核心能力|核心技能|技能(?:清单|与优势|特长)?|个人优势|个人总结|自我(?:评价|介绍)|证书|资格证书|荣誉(?:奖项)?|获奖经历|skills|technical skills|core competencies|certifications?|awards|summary|profile)$/i],
    ['profilePreferences', /^(求职意向|求职目标|意向岗位|目标岗位|应聘岗位|期望职位|职业目标|目标|到岗时间|可用时间|期望薪资|薪资期望|期望城市|工作地点|objective|career objective|availability|preferences)$/i]
  ];
  function cleanLine(value) {
    return value.replace(/^[\s#>*•●▪◆■-]+/, '').replace(/\*\*|__/g,'').trim();
  }
  function headingOf(value) {
    const title=value.replace(/^\d+[.、)）]\s*/, '').replace(/^[【\[（(]+|[】\]）):：]+$/g,'').replace(/[（(]/g,' / ').trim();
    // Accept bilingual headings only if every part is itself a known heading.
    const parts=title.split(/\s*(?:[|｜/]|\s[-–—]\s)\s*|(?<=[\u3400-\u9fff])\s+(?=[A-Za-z])/).filter(Boolean);
    const matches=parts.map(part=>headingPatterns.find(([,pattern])=>pattern.test(part.replace(/\s+/g,' ').trim()) || pattern.test(part.replace(/\s/g,'')))?.[0]);
    return matches.length && matches.every(key=>key && key===matches[0]) ? matches[0] : null;
  }
  const contactPattern = /(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s|｜]+/gi;
  function stripContacts(line) {
    return line.replace(contactPattern,'').replace(/(?:电话|联系电话|手机|邮箱|电子邮箱|phone|e-?mail|tel)\s*[:：]?\s*(?=[|｜;；,，]|$)/gi,'')
      .replace(/(?:微信|住址|身份证|wechat|address)\s*[:：]\s*[^|｜;；\t]+/gi,'')
      .replace(/^[\s|｜;；,，]+|[\s|｜;；,，]+$/g,'').trim();
  }
  function parseProfile(text) {
    const profile=Object.fromEntries(profileFields.map(field=>[field,'']));
    const groups={profileEducation:[],profileExperience:[],profileSkills:[],profilePreferences:[]};
    const unclassified=[], warnings=[];
    let section=null, headingCount=0, removed=0, inferred=false, contentLines=0;
    const lines=text.normalize('NFKC').replace(/\r\n?/g,'\n').split('\n')
      .flatMap(line=>line.split(/[|｜;；]\s*(?=(?:求职意向|求职目标|意向岗位|目标岗位|到岗时间|期望薪资|期望城市|学历|专业|毕业时间|毕业院校|学校|姓名|name)\s*[:：])/i));
    for(const original of lines){
      let line=cleanLine(original).replace(/姓\s+名/g,'姓名').replace(/电\s+话/g,'电话').replace(/邮\s+箱/g,'邮箱');
      if(!line || /^(?:[-_=─━]{3,}|第?\s*\d+\s*(?:页|\/\s*\d+)|page \d+(?: of \d+)?)$/i.test(line))continue;
      // Remove only contact fragments, preserving other data from the same row.
      const cleaned=stripContacts(line);if(cleaned!==line)removed++;
      line=cleaned;if(!line)continue;
      const explicit=line.match(/^(?:姓名|称呼|name)(?:\s*[:：]\s*|\s+)(.+)$/i);
      if(explicit){
        const pieces=explicit[1].split(/[|｜;；\t]|\s+(?=(?:性别|年龄|学历|专业|求职|意向)\s*[:：])/);
        profile.profileName=pieces.shift().trim().slice(0,80);
        if (/^[\u3400-\u9fff\s]{2,12}$/.test(profile.profileName)) profile.profileName=profile.profileName.replace(/\s/g,'');
        line=pieces.filter(Boolean).join(' | ').trim();
        if(!line)continue;
      }
      if(/^(?:个人简历|简历|resume|curriculum vitae|基本信息|个人信息|联系方式)$/i.test(line)){section=null;continue;}
      const colon=line.search(/[:：]/), title=colon<0 ? line : line.slice(0,colon);
      const heading=headingOf(title);
      if(heading){
        const rest=colon<0?'':line.slice(colon+1).trim();
        // Inline availability is a single fact, not a new section boundary.
        const inlinePreference=heading==='profilePreferences' && rest;
        if(!inlinePreference){section=heading;headingCount++;}
        if(heading==='profileExperience')groups[heading].push(title);
        if(rest)groups[heading].push(heading==='profilePreferences'?line:rest);
        continue;
      }
      // Standalone top-of-resume names need context and strict shape checks.
      const first=line.split(/[|｜]/)[0].trim(), compact=first.replace(/\s/g,'');
      const surname=/^(?:[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林钟徐邱骆高夏蔡田樊胡凌霍万柯卢莫房裘缪干解应宗丁宣邓单洪包诸左石崔吉龚程邢裴陆荣翁荀羊甄曲封储靳段巫焦巴牧山谷车侯全秋仲伊宫宁仇栾甘厉戎祖武符刘詹龙叶黎白赖卓谭申劳浦姬庄翟温尚农别燕柴瞿阎连艾向廖曾关查游权欧满简冷辛沙鞠丰巢巩聂晁勾敖融冷晏耿耿景文师巫盖支查竺谈司韶连符景古郁燕兰聂柴蒙薄能屠冉边柴景祝尉蓝滕贲苟宿井台弓宗储丘仁柏池代牟迟鹿洛桑]|欧阳|司马|上官|诸葛|夏侯|东方|皇甫|尉迟|公孙|慕容|司徒|司空|令狐)/;
      const chineseName=/^[\u3400-\u9fff]{2,4}$/.test(compact) && surname.test(compact) && !/(?:大学|学院|本科|硕士|博士|经验|专业|开发|工程|应届|求职|实习|技能|能力|简介|信息|评价|应聘|学历)/.test(compact);
      const englishName=/^[A-Z][a-z]+(?:[-'][A-Za-z]+)?(?: [A-Z][a-z]+(?:[-'][A-Za-z]+)?){1,3}$/.test(first) && !/(?:Engineer|Developer|Manager|University|College|Experience|Skills|Education|Resume|Candidate|Profile|Summary)/.test(first);
      if(!profile.profileName && !section && contentLines<3 && (chineseName || englishName)){
        profile.profileName=chineseName?compact:first;inferred=true;
        line=line.slice(first.length).replace(/^[|｜\s]+/,'').trim();if(!line)continue;
      }
      if (/^\s*#{1,2}\s+/.test(original) || /^(?:兴趣爱好|其他信息|附加信息|additional information|interests)$/i.test(line)) {
        section=null;unclassified.push(line);continue;
      }
      contentLines++;
      if(/^(?:求职|意向|应聘|目标|期望|到岗|可到岗|最快到岗|每周|可连续实习|可实习|实习时长|可接受出差|可接受调剂|薪资|工作城市|工作地点|available\b|seeking\b)/i.test(line)){
        groups.profilePreferences.push(line);continue;
      }
      if(section)groups[section].push(line);
      else if(/(?:大学|学院|university|college).*(?:本科|硕士|博士|大专|学士|bachelor|master|20\d{2})|^(?:学历|专业|毕业时间|毕业院校|学校)[:：]/i.test(line))groups.profileEducation.push(line);
      else unclassified.push(line);
    }
    for(const [key,values] of Object.entries(groups))profile[key]=values.join('\n').trim();
    if(unclassified.length)warnings.push('有未确定归属的文字，请在“待归类内容”中核对并整理。');
    if(inferred)warnings.push('称呼根据简历顶部文字识别，请核对。');
    if(!profile.profileName)warnings.push('未可靠识别称呼，可自行填写或留空。');
    if(!headingCount)warnings.push('未找到常见分节标题，请核对字段归类。');
    if(removed)warnings.push('已移除联系方式片段，同一行的其他内容已保留供核对。');
    return {profile,warnings,unclassified:unclassified.join('\n')};
  }

  async function extract(file) {
    if (!file || !file.size) throw new Error('请选择非空简历文件。');
    if (file.size > MAX_FILE_BYTES) throw new Error('简历不能超过 10 MB。');
    const type = file.name.split('.').at(-1).toLowerCase();
    if (!['pdf', 'docx', 'txt', 'md'].includes(type)) throw new Error('支持 PDF、DOCX、TXT、MD；旧版 DOC 请先另存为 DOCX。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text, extractionWarnings=[];
    if (type === 'pdf') {const result=await extractPdf(bytes);text=result.text;extractionWarnings=result.warnings;}
    else if (type === 'docx') text = await extractDocx(bytes);
    else text = decodeText(bytes);
    text = checkText(text);
    const result=parseProfile(text);
    return {text,...result,warnings:[...extractionWarnings,...result.warnings]};
  }
  globalThis.ResumeParser = Object.freeze({extract, parseProfile});
})();
