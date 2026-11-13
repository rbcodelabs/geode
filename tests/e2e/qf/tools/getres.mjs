import { execSync } from "node:child_process";
const id = process.argv[2];
const d = JSON.parse(execSync(`tq results ${id} --json`, { maxBuffer: 1 << 26 }).toString());
const steps = d.exit_info?.steps ?? [];
const base = steps.find((s) => s.name === "e0")?.peakMb;
let out = ""; 
for (const s of steps) { if (/^e\d+$/.test(s.name) && s.name !== "e0") { const v = Math.round((s.peakMb - base) / 4); out += v === 0 ? " " : String.fromCharCode(32 + v); } }
console.log("outcome:", d.outcome, d.outcome_reason, "| steps:", steps.filter(s=>!/^e\d+$/.test(s.name)).map(s=>`${s.name}:${s.exitCode}/${Math.round(s.durationMs/1000)}s`).join(" "));
console.log("base", base, "DIGEST:", out.trimEnd());
