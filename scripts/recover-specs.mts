#!/usr/bin/env node
// Recover spec documents from subagent transcripts: each agent attempted a
// Write to docs/spec/*.md that was permission-denied; the content is in the
// tool_use input. Extract the last such Write per transcript and save it.
import * as fs from "node:fs";

const TASK_DIR =
  "/private/tmp/claude-501/-Users-rickbowman-projects-obsidian-claude-threads/a84ab1ad-fbf3-4b1d-9fd3-fedb960016a0/tasks";
const OUT_DIR = "/Users/rickbowman/projects/geode/docs/spec";

const agents: Record<string, string> = {
  a88ab2d92a23ef5df: "01-core-app.md",
  a021ff438ff04f4a4: "02-core-plugins.md",
  a038ae1ca88c7c79c: "03-plugin-api.md",
  a84693e925955bb08: "04-formats-and-platform.md",
};

for (const [id, outName] of Object.entries(agents)) {
  const path = `${TASK_DIR}/${id}.output`;
  if (!fs.existsSync(path)) {
    console.log(`MISSING transcript: ${path}`);
    continue;
  }
  const lines = fs.readFileSync(path, "utf8").split("\n");
  let best: { file_path: string; content: string } | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type === "tool_use" &&
        block?.name === "Write" &&
        typeof block?.input?.content === "string" &&
        block.input.content.length > 500
      ) {
        best = { file_path: block.input.file_path ?? "?", content: block.input.content };
      }
    }
  }
  if (best) {
    fs.writeFileSync(`${OUT_DIR}/${outName}`, best.content);
    console.log(
      `RECOVERED ${outName}: ${best.content.length} chars (agent wrote to ${best.file_path})`
    );
  } else {
    console.log(`NO Write payload found for ${outName}`);
  }
}
