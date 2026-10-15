const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ctx=vm.createContext({});
const source=fs.readFileSync(require('node:path').join(__dirname,'resume-parser.js'),'utf8');
vm.runInContext(source.replace('globalThis.ResumeParser =', 'globalThis.layoutPdfItems=layoutPdfItems; globalThis.ResumeParser ='),ctx);
const parse=ctx.ResumeParser.parseProfile;
let n=0;
function test(label,fn){fn();n++;console.log('PASS '+label);}
test('standalone name, technical ability and inline objective',()=>{
 const p=parse('# 李明\n13800138000 | demo@example.org\n## 教育经历\n示例大学 | 软件工程 | 本科 | 2023-2027\n## 实习经历\n示例科技 | 前端实习生\n### 管理平台 | 协作开发\n- 开发交互页面\n## 技术能力\nPython、SQL\n## 自我评价\n善于协作\n目标：应用开发实习；每周5天，可连续6个月');
 assert.equal(p.profile.profileName,'李明');assert(p.profile.profileSkills.includes('SQL'));assert(!p.profile.profileExperience.includes('SQL'));assert(p.profile.profilePreferences.includes('每周5天'));assert(!p.profile.profileSkills.includes('每周5天'));assert.equal(p.unclassified,'');
});
test('spaced heading, bilingual sections and standalone English name',()=>{
 const p=parse('Alex Smith\n教 育 背 景 / Education\nExample University | Bachelor | 2025\n【核心能力】\nJava、SQL\n工作经历 Work Experience\nExample Inc.\n求职意向：后端工程师');
 assert.equal(p.profile.profileName,'Alex Smith');assert(p.profile.profileEducation.includes('Bachelor'));assert(p.profile.profileExperience.includes('Example Inc.'));assert(p.profile.profileSkills.includes('SQL'));assert(p.profile.profilePreferences.includes('后端工程师'));assert.equal(p.unclassified,'');
});
test('mixed contact row preserves education and objectives',()=>{
 const p=parse('姓名：测试候选人 | 电话：13800138000 | 邮箱：demo@example.org | 学历：本科\n求职意向：后端开发 | 微信：example_id\n技术能力：Python');
 assert.equal(p.profile.profileName,'测试候选人');assert(p.profile.profileEducation.includes('本科'));assert(p.profile.profilePreferences.includes('后端开发'));assert(!JSON.stringify(p.profile).includes('13800138000'));assert(!JSON.stringify(p.profile).includes('demo@example.org'));assert(!JSON.stringify(p.profile).includes('example_id'));
});
test('unknown text preserved outside work, no false header name',()=>{
 for(const header of ['软件工程师','应届生','核心技能','个人简历']){
 const p=parse(header+'\n备注：待补充信息');assert.equal(p.profile.profileName,'');assert(!p.profile.profileExperience.includes('待补充信息'));assert(p.unclassified.includes('待补充信息')||p.profile.profileSkills.includes('待补充信息'));
 }
});
test('availability fact does not steal following skills section',()=>{
 const p=parse('技能\nSQL\n到岗时间：11月\nPython');assert(p.profile.profileSkills.includes('Python'));assert(!p.profile.profilePreferences.includes('Python'));
});
const token=(str,x,y,width=str.length*10)=>({str,transform:[10,0,0,10,x,y],height:10,width});
test('PDF shuffled fragments and Chinese spacing',()=>{
 const p=ctx.layoutPdfItems([token('技能',10,100),token('力',40,80),token('技',10,80),token('术',20,80),token('能',30,80),token('Python',10,60,30),token('SQL',45,60,15)]);
 assert.equal(p.text,'技能\n技术能力\nPython SQL');assert.equal(p.columns,false);
});
test('PDF two columns read section by section',()=>{
 const p=ctx.layoutPdfItems([token('教育经历',20,700),token('技术能力',300,700),token('示例大学',20,680),token('SQL',300,680),token('本科',20,660),token('Python',300,660),token('2027',20,640),token('Java',300,640)].reverse());
 assert.equal(p.columns,true);assert(p.text.indexOf('2027')<p.text.indexOf('技术能力'));
});
test('PDF single column date alignment is not inferred as columns',()=>{
 const p=ctx.layoutPdfItems([token('工作经历',20,700),token('示例科技有限公司：开发岗位以及工作职责说明',20,680,340),token('开发服务端',20,660,160),token('2023-2024',400,660,60)]);assert.equal(p.columns,false);
});
test('PDF repeated right-aligned dates remain attached',()=>{
 const items=[];for(let i=0;i<4;i++){items.push(token('示例公司',20,700-i*25,100),token('2023.01-2024.02',400,700-i*25,80));}
 const p=ctx.layoutPdfItems(items);assert.equal(p.columns,false);assert(p.text.split(' | ').length>3);
});
test('inline metadata segments are independently routed',()=>{
 const p=parse('姓名：李明 | 电话：13800138000 | 学历：本科 | 求职意向：后端工程师');
 assert.equal(p.profile.profileName,'李明');assert(p.profile.profileEducation.includes('本科'));assert(!p.profile.profileEducation.includes('后端'));assert(p.profile.profilePreferences.includes('后端'));
});
test('unknown Markdown sections do not leak into previous field',()=>{
 const p=parse('## 工作经历\n测试公司\n## 兴趣爱好\n围棋');assert(!p.profile.profileExperience.includes('围棋'));assert(p.unclassified.includes('围棋'));
});
console.log(n+' synthetic parser checks passed');
