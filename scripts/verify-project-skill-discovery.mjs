import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverProjectSkills } from '../apps/desktop/electron/project-skill-discovery.ts'
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-project-discovery-')))
const a = path.join(root,'a'), b = path.join(root,'b'), trace = path.join(root,'trace')
const write = (file, text) => {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
const link = (source, destination) => {fs.mkdirSync(path.dirname(destination),{recursive:true});fs.symlinkSync(source,destination,'dir')}
const snapshot = directory => {
  const result = {}
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir,name), stat = fs.lstatSync(file)
      result[path.relative(directory,file)] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(file)}` : stat.isDirectory() ? 'dir' : fs.readFileSync(file,'utf8')
      if(stat.isDirectory()) walk(file)
    }
  };walk(directory);return result
}
try {
  fs.mkdirSync(a);fs.mkdirSync(b)
  write(path.join(a,'.agents/skills/local/SKILL.md'),'---\nname: Local\ndescription: >\n  project source\n  multiline description\ntags: [one, two]\n---\n# Local body\n')
  write(path.join(b,'.agents/skills/local/SKILL.md'),'---\nname: Local\n---\n# Different project\n')
  const external = path.join(root,'external')
  write(path.join(external,'SKILL.md'),'# External skill\n')
  link(external,path.join(a,'.claude/skills/shared'))
  link(external,path.join(a,'.cursor/skills/shared'))
  // Same basename from different physical sources cannot overwrite each other.
  write(path.join(a,'.github/skills/local/SKILL.md'),'# Other local\n')
  link(path.join(root,'missing'),path.join(a,'.gemini/skills/broken'))
  fs.mkdirSync(path.join(a,'.trae/skills/no-markdown'),{recursive:true})
  const central = path.join(trace,'skills/managed')
  write(path.join(central,'SKILL.md'),'# Current central document\n')
  write(path.join(trace,'skills/managed.json'),JSON.stringify({id:'managed',name:'Managed',targetProjects:[a],skillMarkdown:'stale metadata copy'}))
  link(central,path.join(a,'.agents/skills/managed'))
  const before = snapshot(root)
  const result = discoverProjectSkills(a,trace)
  assert.equal(result.skills.length,4)
  assert.ok(result.errors.some(error=>error.includes('broken')))
  const local = result.skills.find(skill=>skill.skillPath===path.join(a,'.agents/skills/local'))
  assert.equal(local.name,'Local')
  assert.equal(local.description.trim(),'project source multiline description')
  assert.deepEqual(local.tags,['one','two'])
  assert.equal(local.projectSource.managedSkillId,undefined)
  const shared = result.skills.find(skill=>skill.skillPath===external)
  assert.equal(shared.projectSource.relativePaths.length,2)
  assert.equal(result.skills.filter(skill=>path.basename(skill.skillPath)==='local').length,2)
  const managed = result.skills.find(skill=>skill.id==='managed')
  assert.equal(managed.projectSource.managedSkillId,'managed')
  assert.equal(managed.skillMarkdown,'# Current central document\n')
  const other = discoverProjectSkills(b,trace)
  assert.equal(other.skills.length,1)
  assert.notEqual(other.skills[0].id,local.id)
  assert.ok(other.skills[0].skillMarkdown.includes('Different project'))
  assert.deepEqual(discoverProjectSkills(a,trace).skills.map(s=>s.id),result.skills.map(s=>s.id),'IDs remain stable across scans')
  assert.deepEqual(snapshot(root),before,'Discovery must not import, persist or mutate any source')
  fs.unlinkSync(path.join(a,'.agents/skills/managed'))
  assert.ok(!discoverProjectSkills(a,trace).skills.some(s=>s.id==='managed'),'Stale metadata cannot invent a removed physical link')
  fs.rmSync(path.join(a,'.agents/skills/local'),{recursive:true})
  assert.ok(!discoverProjectSkills(a,trace).skills.some(s=>s.id===local.id),'External deletion is reflected on refresh')
  write(path.join(b,'.cursor/skills/malformed/SKILL.md'),'---\nname: [broken\n---\n# Still readable\n')
  const malformed = discoverProjectSkills(b,trace)
  assert.equal(malformed.skills.length,2)
  assert.ok(malformed.errors.some(e=>e.includes('元数据解析失败')))
  assert.throws(()=>discoverProjectSkills(path.join(root,'missing-project'),trace))
  const empty = path.join(root,'empty');fs.mkdirSync(empty)
  assert.deepEqual(discoverProjectSkills(empty,trace),{skills:[],errors:[]})
  console.log('PASS project discovery: physical folders, links, dedup, collisions, project isolation, source markdown, managed provenance, stale associations, invalid roots, partial errors, read-only scanning')
} finally {fs.rmSync(root,{recursive:true,force:true})}
