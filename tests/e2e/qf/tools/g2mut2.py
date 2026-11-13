import json,base64
b=lambda p: base64.b64encode(open(p,'rb').read()).decode()
A='src/main/artifact-inspector-anchors.ts'
T='tests/unit/qa-final-g2-trailing.test.ts'
src=open('/tmp/qf/h/'+T,'rb').read()
steps=[{"name":"install","run":"npm ci"},{"name":"stage","run":"echo %s | base64 -d > %s && echo %s | base64 -d > /tmp/mut.mjs && echo %s | base64 -d > /tmp/decode.mjs && rm -f /tmp/mut-res.txt /tmp/mut-pre.txt"%(base64.b64encode(src).decode(),T,b('/tmp/qf/mut.mjs'),b('/tmp/qf/h/tests/e2e/qf/decode.mjs'))},
{"name":"control","run":"npx vitest run %s > /tmp/c.txt 2>&1; echo \"C:$? \" >> /tmp/mut-res.txt; true"%T},
{"name":"m2-trailing","run":"node /tmp/mut.mjs M2 %s %s %s; npx vitest run %s > /tmp/o.txt 2>&1; echo \"M2:$? \" >> /tmp/mut-res.txt; git checkout -- src; true"%(A,json.dumps("if (rectsTimer === null) rectsTimer = deps.setTimeout(() => { rectsTimer = null; measure(); }, wait);"),json.dumps("if (rectsTimer === null) rectsTimer = null;"),T)},
{"name":"m1-nospacing","run":"node /tmp/mut.mjs M1 %s %s %s; npx vitest run %s > /tmp/o.txt 2>&1; echo \"M1:$? \" >> /tmp/mut-res.txt; git checkout -- src; true"%(A,json.dumps("const wait = lastRectsSentAt + INSPECTOR_CAPS.anchorRectsSpacingMillis - deps.now();"),json.dumps("const wait = 0;"),T)},
{"name":"digest","run":"cat /tmp/mut-pre.txt /tmp/mut-res.txt 2>/dev/null | tr -d '\\n' > /tmp/d.txt; python3 -c \"d=open('/tmp/d.txt').read(); open('/tmp/qf-digest.txt','w').write(d[:60].ljust(60))\"; cat /tmp/d.txt; tail -15 /tmp/c.txt"}]
for k in range(0,61): steps.append({"name":"e%d"%k,"run":"node /tmp/decode.mjs emit %d"%k})
json.dump({"node":"22","steps":steps,"database":False,"timeout_s":1800,"reserve_mb":2816,"env":{"npm_config_fund":"false","npm_config_audit":"false"}},open('/tmp/qf/g2mut2.json','w'))
