import assert from 'node:assert/strict'
import { addSkillToScope, skillsInScope } from '../apps/desktop/src/skill-scope.ts'
const target = {scope:'project',id:'p1',name:'One',path:'/projects/one'}
const skill = {id:'example',name:'Example',targetTools:['do-not-inject'],targetProjects:['/wrong']}
function fixture() {
  const state = {projects:[{id:'p1',path:'/projects/one',status:'valid'}],skills:[],saved:[],injected:[]}
  const api = {
    listManagedProjects: async()=>state.projects,
    loadLocalSkills:async()=>state.skills,
    saveLocalSkill:async value=>{state.saved.push(value);state.skills.push(value);return true},
    injectSkill:async(id,value)=>{state.injected.push({id,...value});return {success:true}},
  }
  return {state,api}
}
{
  const {state,api}=fixture()
  await addSkillToScope(api,skill,{scope:'global'})
  assert.equal(state.saved.length,1)
  assert.deepEqual(state.saved[0].targetTools,[])
  assert.deepEqual(state.saved[0].targetProjects,[])
  assert.deepEqual(state.injected,[])
}
{
  const {state,api}=fixture()
  await addSkillToScope(api,skill,target)
  assert.deepEqual(state.injected,[{id:'example',scope:'project',projectPath:'/projects/one',relPath:'.agents/skills'}])
  await addSkillToScope(api,{...skill,name:'overwrite'},target)
  assert.equal(state.saved.length,1,'Retry must not overwrite central user edits')
}
for (const projects of [[],[{id:'p1',path:'/projects/other',status:'valid'}],[{id:'p1',path:'/projects/one',status:'missing'}]]) {
  const {state,api}=fixture();state.projects=projects
  await assert.rejects(addSkillToScope(api,skill,target),/目标项目/)
  assert.equal(state.saved.length,0);assert.equal(state.injected.length,0)
}
{
  const {state,api}=fixture();api.saveLocalSkill=async()=>false
  await assert.rejects(addSkillToScope(api,skill,target),/保存 Skill 失败/)
  assert.equal(state.injected.length,0)
}
{
  const {state,api}=fixture();api.injectSkill=async()=>({success:false,error:'existing real directory'})
  await assert.rejects(addSkillToScope(api,skill,target),/已保留在全局技能库.*existing real directory/)
  assert.equal(state.saved.length,1)
}
{
  const {state,api}=fixture()
  api.saveLocalSkill=async()=>{state.projects=[];return true}
  await assert.rejects(addSkillToScope(api,skill,target),/已保留在全局技能库/)
  assert.equal(state.injected.length,0,'Removed target cannot silently fall back to another project')
}
const collection=[{id:'global'}, {id:'one',targetProjects:['/projects/one/']},{id:'two',targetProjects:['/projects/two']}]
assert.deepEqual(skillsInScope(collection,target).map(s=>s.id),['one'])
assert.deepEqual(skillsInScope(collection,{scope:'global'}),collection)
assert.deepEqual(skillsInScope(collection,null),[])
console.log('PASS OPC-66: scope isolation, explicit injection, invalid targets, save failure, partial failure, retry preservation, removal during add')

// Exercise the same renderer orchestration against the real filesystem managers.
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const { addProject, listManagedProjects } = await import('../apps/desktop/electron/project-manager.ts')
const { injectSkillToTarget, ensureSkillCentralDirectory } = await import('../apps/desktop/electron/skill-injection-manager.ts')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-opc66-')))
try {
  const traceHome = path.join(root, 'trace')
  const one = path.join(root, 'one'), two = path.join(root, 'two')
  fs.mkdirSync(one); fs.mkdirSync(two)
  addProject(one, traceHome); addProject(two, traceHome)
  const project = listManagedProjects(traceHome).find(project => project.path === one)
  const source = {...skill, description:'fixture', apps:[], skillMarkdown:'# Fixture\n'}
  const file = path.join(traceHome, 'skills', 'example.json')
  const api = {
    listManagedProjects: async()=>listManagedProjects(traceHome),
    loadLocalSkills: async()=>fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file,'utf8'))] : [],
    saveLocalSkill: async skill=>{ensureSkillCentralDirectory(skill,traceHome);fs.writeFileSync(file,JSON.stringify(skill));return true},
    injectSkill: async(id,target)=>injectSkillToTarget(id,target,{traceHome}),
  }
  await addSkillToScope(api,source,{scope:'project',id:project.id,name:project.name,path:one})
  assert.equal(fs.realpathSync(path.join(one,'.agents/skills/example')),path.join(traceHome,'skills/example'))
  assert.equal(fs.existsSync(path.join(two,'.agents')),false)
  const loaded = await api.loadLocalSkills()
  assert.deepEqual(loaded[0].targetTools,[])
  assert.deepEqual(skillsInScope(loaded,{scope:'project',id:project.id,name:project.name,path:one}).map(s=>s.id),['example'])
  fs.writeFileSync(path.join(traceHome,'skills/example/SKILL.md'),'# User edited\n')
  await addSkillToScope(api,source,{scope:'project',id:project.id,name:project.name,path:one})
  assert.equal(fs.readFileSync(path.join(one,'.agents/skills/example/SKILL.md'),'utf8'),'# User edited\n')
  console.log('PASS OPC-66 filesystem integration: managed project → central asset → exact symlink → refreshed scope → edit-preserving retry')
} finally { fs.rmSync(root,{recursive:true,force:true}) }
