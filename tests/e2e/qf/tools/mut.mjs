import fs from "node:fs";
const [id, file, from, to] = process.argv.slice(2);
const s = fs.readFileSync(file, "utf8");
if (!s.includes(from)) { fs.appendFileSync("/tmp/mut-pre.txt", `${id}:NOCHANGE `); process.exit(0); }
fs.writeFileSync(file, s.replace(from, to));
