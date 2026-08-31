import {
  normalizeRepositorySlug,
  parseRepositorySkillList,
} from '../apps/desktop/electron/skill-repository-search.ts'

const sampleOutput = `
Source: https://github.com/kacperkapusciak/goldie.git

Available Skills

│    goldie
│      Create App Store screenshots and preview videos.

Use --skill <name> to install a specific skill
`

const result = parseRepositorySkillList(
  normalizeRepositorySlug('https://github.com/kacperkapusciak/goldie.git'),
  sampleOutput,
)

if (
  result.repository !== 'kacperkapusciak/goldie'
  || result.skills.length !== 1
  || result.skills[0].name !== 'goldie'
  || !result.skills[0].description.includes('App Store')
) {
  throw new Error(`Repository skill parsing failed: ${JSON.stringify(result)}`)
}

for (const unsafeValue of ['goldie', 'owner/repo; touch /tmp/nope', '../owner/repo']) {
  try {
    normalizeRepositorySlug(unsafeValue)
    throw new Error(`Unsafe repository input was accepted: ${unsafeValue}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unsafe repository input')) throw error
  }
}

console.log('Repository search OK: strict owner/repo validation -> goldie parsed')
