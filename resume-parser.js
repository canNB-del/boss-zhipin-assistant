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

  // Read just document.xml from the ZIP central directory; never execute or render document markup.
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
    for (let i = 0; i < entries; i++) {
      if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('DOCX 目录损坏。');
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
      const packedSize = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
      const nameSize = view.getUint16(offset + 28, true), extraSize = view.getUint16(offset + 30, true), commentSize = view.getUint16(offset + 32, true);
      const next = offset + 46 + nameSize + extraSize + commentSize;
      if (next > end) throw new Error('DOCX 目录不完整。');
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameSize));
      if (name === 'word/document.xml') {
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
        if (xmlBytes.length !== size) throw new Error('Word 内容大小校验失败。');
        const xml = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) throw new Error('Word 文档结构无法解析。');
        const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
        const paragraphs = Array.from(xml.getElementsByTagNameNS(ns, 'p')).map(paragraph => {
          let result = '';
          for (const node of paragraph.getElementsByTagNameNS(ns, '*')) {
            if (node.localName === 't') result += node.textContent;
            if (node.localName === 'tab') result += '\t';
            if (node.localName === 'br' || node.localName === 'cr') result += '\n';
          }
          return result;
        });
        return paragraphs.join('\n');
      }
      offset = next;
    }
    throw new Error('DOCX 中找不到正文；请另存为标准 DOCX 或 TXT。');
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
      const pages = []; let total = 0;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), content = await page.getTextContent();
        let text = '', lastY = null;
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          const y = item.transform?.[5];
          if (lastY !== null && Math.abs(y - lastY) > 3 && !text.endsWith('\n')) text += '\n';
          text += item.str + (item.hasEOL ? '\n' : ' ');
          lastY = y;
        }
        total += text.length;
        if (total > MAX_TEXT_CHARS) throw new Error('PDF 文字超过 10 万字，请精简后再导入。');
        pages.push(text); page.cleanup();
      }
      return pages.join('\n\n');
    } catch (error) {
      if (error.name === 'PasswordException') throw new Error('PDF 有密码保护，请解除密码后重新导入。');
      throw error;
    } finally { await task.destroy(); }
  }

  function parseProfile(text) {
    const profile = Object.fromEntries(profileFields.map(field => [field, '']));
    const groups = {profileEducation:[], profileExperience:[], profileSkills:[], profilePreferences:[]};
    const headings = [
      ['profileEducation', /^(教育(?:背景|经历)?|学习经历|学历|education(?:al background)?)$/i],
      ['profileExperience', /^(工作(?:经历|经验)?|实习(?:经历|经验)?|项目(?:经历|经验|实践)?|实践经历|校园经历|社会实践|科研经历|experience|work experience|internship(?: experience)?|projects?|project experience)$/i],
      ['profileSkills', /^(专业技能|职业技能|技术技能|技能(?:与优势|特长)?|个人优势|自我评价|证书|资格证书|荣誉奖项|获奖经历|skills|technical skills|certifications?|awards|summary)$/i],
      ['profilePreferences', /^(求职意向|求职目标|意向岗位|职业目标|到岗时间|期望薪资|objective|career objective|availability|preferences)$/i]
    ];
    const unclassified = []; let section = null, headingCount = 0, contactsRemoved = 0;
    for (const original of text.split('\n')) {
      const line = original.replace(/^\s*(?:#{1,6}\s*|[•●▪]\s*)/, '').trim();
      if (!line) continue;
      const name = line.match(/^(?:姓名|称呼|name)\s*[:：]\s*([^|｜,，;；\t]{1,80})/i);
      if (name) {
        profile.profileName = name[1].split(/\s+(?:电话|手机|邮箱|微信|住址|phone|e-?mail|address)\s*[:：]/i)[0].trim();
        if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(profile.profileName) || /1[3-9]\d{9}/.test(profile.profileName)) {
          profile.profileName = ''; contactsRemoved++;
        }
        continue;
      }
      // Contact details have no profile field and are not needed for reply generation.
      if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(line) || /(?:电话|手机|邮箱|微信|住址|身份证|phone|e-?mail|address)\s*[:：]/i.test(line) || /(?:^|\D)1[3-9]\d{9}(?!\d)/.test(line)) { contactsRemoved++; continue; }
      const parts = line.split(/[:：]/), title = parts[0].replace(/\s+/g, ' ').replace(/^\d+[.、)）]\s*/, '').trim();
      const compact = title.replace(/\s/g, '');
      const heading = headings.find(([,pattern]) => pattern.test(title) || pattern.test(compact));
      if (heading) {
        section = heading[0]; headingCount++;
        const rest = parts.slice(1).join('：').trim();
        if (section === 'profileExperience' && groups[section].length) groups[section].push('');
        if (section === 'profileExperience') groups[section].push(title);
        if (rest) groups[section].push(rest);
        continue;
      }
      if (/^(?:个人简历|简历|resume|curriculum vitae|基本信息|个人信息|联系方式)$/i.test(line)) { section = null; continue; }
      if (section) groups[section].push(line);
      else unclassified.push(line);
    }
    for (const [key, lines] of Object.entries(groups)) profile[key] = lines.join('\n').trim();
    const warnings = [];
    if (unclassified.length) {
      profile.profileExperience += (profile.profileExperience ? '\n\n' : '') + '【待核对：未归类内容】\n' + unclassified.join('\n');
      warnings.push('未归类文字已放入“经历”，请核对并移至合适字段。');
    }
    if (!profile.profileName) warnings.push('未找到明确的姓名标签，称呼保持空白，可自行填写。');
    if (!headingCount) warnings.push('没有识别到常见分节标题，请手动整理预览字段。');
    if (contactsRemoved) warnings.push('已跳过 '+contactsRemoved+' 行可能含联系方式的内容，请核对是否遗漏同一行的其他信息。');
    return {profile, warnings};
  }

  async function extract(file) {
    if (!file || !file.size) throw new Error('请选择非空简历文件。');
    if (file.size > MAX_FILE_BYTES) throw new Error('简历不能超过 10 MB。');
    const type = file.name.split('.').at(-1).toLowerCase();
    if (!['pdf', 'docx', 'txt', 'md'].includes(type)) throw new Error('支持 PDF、DOCX、TXT、MD；旧版 DOC 请先另存为 DOCX。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text;
    if (type === 'pdf') text = await extractPdf(bytes);
    else if (type === 'docx') text = await extractDocx(bytes);
    else text = decodeText(bytes);
    text = checkText(text);
    return {text, ...parseProfile(text)};
  }
  globalThis.ResumeParser = Object.freeze({extract, parseProfile});
})();
