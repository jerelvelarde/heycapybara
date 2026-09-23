export function validateSkillMarkdown(markdown: string) {
  if (markdown.length > 100_000) throw new Error("Skill exceeds 100 KB");
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!front)
    throw new Error("Skill needs YAML frontmatter with name and description");
  if (!/^name: [a-z0-9]+(?:-[a-z0-9]+)*\s*$/m.test(front[1]))
    throw new Error("Skill name must be lowercase with hyphens");
  if (!/^description: .+$/m.test(front[1]))
    throw new Error("Skill description is required");
  if (!markdown.slice(front[0].length).trim())
    throw new Error("Skill instructions are required");
}
