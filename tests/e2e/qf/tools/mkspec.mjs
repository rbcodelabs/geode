import fs from "node:fs";
import { execSync } from "node:child_process";
// usage: node mkspec.mjs <variant> <pluginRef> <specs,comma> <digestLen> [timeoutS] [extraEnv k=v;k=v]
const [variant, pluginRef, specs, L, timeoutS = "2400", extra = ""] = process.argv.slice(2);
execSync("cd /tmp/qf/h && tar czf /tmp/qf/h.tgz tests", { stdio: "inherit" });
const b64 = fs.readFileSync("/tmp/qf/h.tgz").toString("base64");
const dec = fs.readFileSync("/tmp/qf/h/tests/e2e/qf/decode.mjs", "utf8");
const decB64 = Buffer.from(dec).toString("base64");
const envs = extra.split(";").filter(Boolean).join(" ");
const steps = [
  { name: "install", run: "npm ci" },
  { name: "build", run: "npm run build" },
  { name: "stage", run: `echo ${b64} | base64 -d | tar xz -C . && echo ${decB64} | base64 -d > /tmp/decode.mjs` },
  { name: "plugin", run: `rm -rf /tmp/plug /tmp/qf-plugin && git clone -q https://github.com/rbcodelabs/threads-artifacts.git /tmp/plug && cd /tmp/plug && git checkout -q ${pluginRef} && npm install --legacy-peer-deps --no-package-lock --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 && mkdir -p /tmp/qf-plugin && cp manifest.json main.js /tmp/qf-plugin/ && test -s /tmp/qf-plugin/main.js` },
  { name: "run", run: `(QF_PLUGIN=/tmp/qf-plugin QF_VARIANT=${variant} QF_OUT=/tmp/qf-out ${envs} PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/qf-res.json xvfb-run -a npx playwright test --workers=1 --retries=0 --reporter=json ${specs.split(",").join(" ")} > /tmp/qf-stdout.txt 2>&1) ; true` },
  { name: "digest", run: `node /tmp/decode.mjs digest ${L}` },
];
for (let k = 0; k <= Number(L); k++) steps.push({ name: `e${k}`, run: `node /tmp/decode.mjs emit ${k}` });
fs.writeFileSync("/tmp/qf/spec.json", JSON.stringify({ node: "22", steps, database: false, timeout_s: Number(timeoutS), reserve_mb: 2816, env: { npm_config_fund: "false", npm_config_audit: "false" } }));
