// Reproduce the exact AppShell → BrowsePage layout chain in a real Chromium
// and measure whether the browser viewport fills the window.
const { chromium } = require("playwright");

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  /* index.html splash block (stays in the DOM): */
  html, body { margin: 0; height: 100%; background: #202020; color: #fff;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }
  /* AppShell Griffel rules (literal values from makeStyles): */
  .shell-root { display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; }
  .titlebar { height: 40px; min-height: 40px; display: flex; align-items: center; }
  .shell-body { display: flex; flex: 1; min-height: 0; }
  .nav { width: 200px; min-height: 0; display: flex; flex-direction: column; gap: 4px; padding: 8px; }
  .content { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
  /* BrowsePage Griffel rules: */
  .browse-root { display: flex; flex-direction: column; height: 100%; gap: 4px; }
  .tabstrip { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .navbar { display: flex; gap: 6px; align-items: center; }
  .viewport { flex: 1; min-height: 80px; border-radius: 6px; background: #333; }
</style></head><body>
<div id="app"></div>
<script>
  // main.tsx: mount node + inline styles applied in boot()
  const app = document.getElementById("app");
  app.style.height = "100%";
  app.style.display = "flex";
  app.style.flexDirection = "column";
  // ThemeProvider: FluentProvider inline style
  const fp = document.createElement("div");
  fp.style.height = "100vh"; fp.style.display = "flex"; fp.style.flexDirection = "column";
  app.appendChild(fp);
  // AppShell
  const root = document.createElement("div"); root.className = "shell-root";
  const titlebar = document.createElement("div"); titlebar.className = "titlebar";
  const body = document.createElement("div"); body.className = "shell-body";
  const nav = document.createElement("div"); nav.className = "nav";
  const main = document.createElement("main"); main.className = "content";
  // BrowsePage
  const broot = document.createElement("div"); broot.className = "browse-root";
  const ts = document.createElement("div"); ts.className = "tabstrip"; ts.style.height = "30px";
  const nb = document.createElement("div"); nb.className = "navbar"; nb.style.height = "32px";
  const vp = document.createElement("div"); vp.className = "viewport";
  broot.append(ts, nb, vp); main.appendChild(broot); body.append(nav, main);
  root.append(titlebar, body); fp.appendChild(root);
</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(HTML);
  const m = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      app: r("#app"),
      fluent: r("body > #app > div"),
      shellRoot: r(".shell-root"),
      body: r(".shell-body"),
      main: r(".content"),
      browseRoot: r(".browse-root"),
      viewport: r(".viewport"),
    };
  });
  console.log(JSON.stringify(m, null, 1));
  await browser.close();
})();
