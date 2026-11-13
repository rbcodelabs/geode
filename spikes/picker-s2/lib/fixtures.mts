/**
 * Fixture artifacts for spike S2: static pages, white background, no scripts (the artifact CSP blocks inline script
 * and inline style, so everything is in style.css). Targets carry `data-s2` and ids t0, t1, ...; the harness colours
 * them with a distinct saturated colour through the CSSOM, so the fixtures stay plain structure.
 *
 * Layouts keep the interesting content inside the top-left 340 x 700 css px so it is on screen in the mobile preset.
 */

export interface Scene { name: string; page?: number; inner?: number }
export interface Fixture {
  id: string;
  title: string;
  html: string;
  css: string;
  /** Scroll positions to measure after the geometry conditions (page = window scrollY, inner = scrollTop of #box). */
  scenes?: Scene[];
  /** Conditions to run: "full" runs every geometry condition, "core" a reduced set. */
  coverage: "full" | "core";
}

const page = (body: string, title: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;

export const FIXTURES: Fixture[] = [
  {
    id: "plain",
    title: "S2 plain",
    coverage: "full",
    html: page(`<div id="t0" data-s2></div><div id="t1" data-s2></div><div id="t2" data-s2></div><div id="t3" data-s2></div><div id="t4" data-s2></div>`, "plain"),
    css: `html,body{margin:0;background:#fff}
#t0{position:absolute;left:20px;top:20px;width:120px;height:60px}
#t1{position:absolute;left:200.5px;top:30.25px;width:99.5px;height:33.3px}
#t2{position:absolute;left:30px;right:30px;top:120px;height:90px}
#t3{position:absolute;left:150px;top:300px;width:40px;height:40px}
#t4{position:absolute;left:50%;top:400px;width:25%;height:7vh}`,
  },
  {
    id: "scroller",
    title: "S2 inner scroller",
    coverage: "core",
    scenes: [{ name: "scroll-inner-300", page: 0, inner: 300 }, { name: "scroll-page-1200-inner-300", page: 1200, inner: 300 }],
    html: page(`<div id="t0" data-s2></div><div id="box"><div id="inner"><div id="t1" data-s2></div><div id="t2" data-s2></div></div></div><div id="t3" data-s2></div>`, "scroller"),
    css: `html,body{margin:0;background:#fff;height:2200px}
#t0{position:absolute;left:20px;top:20px;width:100px;height:40px}
#box{position:absolute;left:20px;top:100px;width:300px;height:220px;overflow:auto;border:1px solid #ccc;background:#fff}
#inner{position:relative;height:700px}
#t1{position:absolute;left:20px;top:30px;width:120px;height:40px}
#t2{position:absolute;left:150px;top:400px;width:100px;height:40px}
#t3{position:absolute;left:20px;top:1500px;width:160px;height:50px}`,
  },
  {
    id: "transform",
    title: "S2 CSS transforms on ancestors",
    coverage: "core",
    html: page(`<div id="w1"><div id="t0" data-s2></div><div id="t1" data-s2></div></div>
<div id="w2"><div id="t2" data-s2></div></div>
<div id="w3"><div id="w4"><div id="t3" data-s2></div></div></div>
<div id="w5"><div id="t4" data-s2></div></div>`, "transform"),
    css: `html,body{margin:0;background:#fff}
#w1{position:absolute;left:20px;top:20px;width:200px;height:140px;transform:scale(0.75) translate(10px,20px);transform-origin:0 0}
#w1 #t0{position:absolute;left:0;top:0;width:100px;height:50px}
#w1 #t1{position:absolute;left:30px;top:70px;width:140px;height:40px}
#w2{position:absolute;left:20px;top:200px;width:150px;height:100px;transform:scale(1.5);transform-origin:0 0;will-change:transform}
#w2 #t2{position:absolute;left:0;top:0;width:100px;height:40px}
#w3{position:absolute;left:10px;top:400px;width:80px;height:80px;transform:scale(2);transform-origin:0 0}
#w4{width:80px;height:80px;transform:scale(0.5) translate(7px,3px);transform-origin:0 0}
#w4 #t3{position:absolute;left:0;top:0;width:60px;height:30px}
#w5{position:absolute;left:200px;top:420px;width:100px;height:60px;transform:translate(0.4px,0.6px)}
#w5 #t4{position:absolute;left:0;top:0;width:50px;height:30px}`,
  },
  {
    id: "sticky",
    title: "S2 sticky and fixed",
    coverage: "core",
    scenes: [{ name: "scroll-page-300", page: 300 }, { name: "scroll-page-800", page: 800 }],
    html: page(`<div id="t0" data-s2></div><div id="sc"><div id="t1" data-s2></div></div><div id="t2" data-s2></div><div id="t3" data-s2></div>`, "sticky"),
    css: `html,body{margin:0;background:#fff;height:2400px}
#t0{position:fixed;left:20px;top:10px;width:200px;height:30px}
#sc{position:absolute;left:20px;top:100px;width:300px;height:1200px}
#t1{position:sticky;top:60px;margin-top:150px;width:160px;height:40px}
#t2{position:absolute;left:20px;top:700px;width:120px;height:40px}
#t3{position:fixed;right:20px;bottom:20px;width:90px;height:36px}`,
  },
  {
    id: "zoomcss",
    title: "S2 CSS zoom",
    coverage: "core",
    html: page(`<div id="z1"><div id="t0" data-s2></div><div id="t1" data-s2></div></div><div id="z2"><div id="t2" data-s2></div></div><div id="z3"><div id="z4"><div id="t3" data-s2></div></div></div>`, "zoomcss"),
    css: `html,body{margin:0;background:#fff}
#z1{position:absolute;left:20px;top:20px;zoom:1.5}
#z1 #t0{position:absolute;left:0;top:0;width:100px;height:40px}
#z1 #t1{position:absolute;left:0;top:50px;width:80px;height:30px}
#z2{position:absolute;left:200px;top:20px;zoom:0.8}
#z2 #t2{position:absolute;left:0;top:0;width:100px;height:50px}
#z3{position:absolute;left:20px;top:260px;zoom:1.25}
#z4{zoom:0.9}
#z4 #t3{position:absolute;left:0;top:0;width:120px;height:40px}`,
  },
  {
    id: "extremes",
    title: "S2 tiny and huge elements",
    coverage: "core",
    html: page(`<div id="t0" data-s2></div><div id="t1" data-s2></div><div id="t2" data-s2></div><div id="t3" data-s2></div><div id="t4" data-s2></div><div id="t5" data-s2></div><div id="t6" data-s2></div>`, "extremes"),
    css: `html,body{margin:0;background:#fff;overflow:hidden}
#t0{position:absolute;left:20px;top:20px;width:1px;height:1px}
#t1{position:absolute;left:40px;top:20px;width:2px;height:2px}
#t2{position:absolute;left:60px;top:20px;width:3px;height:1px}
#t3{position:absolute;left:80px;top:20px;width:1px;height:120px}
#t4{position:absolute;left:100px;top:60px;width:120px;height:1px}
#t5{position:absolute;left:240px;top:20px;width:1.5px;height:80px}
#t6{position:absolute;left:20px;top:300px;width:5000px;height:3000px}`,
  },
  {
    id: "svgchart",
    title: "S2 SVG chart marks",
    coverage: "core",
    html: page(`<svg id="chart" viewBox="0 0 400 200" width="360" height="180"><rect id="t0" data-s2 x="40" y="80" width="60" height="100"/><rect id="t1" data-s2 x="140" y="50" width="60" height="130"/><rect id="t2" data-s2 x="240" y="110" width="60" height="70"/><circle id="t3" data-s2 cx="70" cy="40" r="14"/><rect id="t4" data-s2 x="320" y="20" width="10" height="10"/></svg>
<svg id="letterbox" viewBox="0 0 100 100" width="330" height="170" preserveAspectRatio="xMidYMid meet"><rect id="t5" data-s2 x="10" y="10" width="30" height="20"/></svg>`, "svgchart"),
    css: `html,body{margin:0;background:#fff}
svg{position:absolute;display:block}
#chart{left:15px;top:20px}
#letterbox{left:15px;top:260px}`,
  },
];
