'use strict';

// Native, observational navigation benchmark. No prompts, model requests, guest
// actions or profile edits. Run with the existing Windows development runtime.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = process.argv[2];
const output = process.argv[3];
assert(root && output);
const { chromium } = require(path.join(root, 'runtime/packages/p39'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'launch.json'), 'utf8'));
const groups = node => !node ? [] : node.kind === 'group' ? [node] : [...groups(node.first), ...groups(node.second)];
const placement = layout => JSON.stringify({ version: layout.version, windows: layout.windows });

async function main() {
  assert.equal(process.platform, 'win32');
  const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Namzu/DevToolsActivePort'), 'utf8').split('\n')[0]);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  const receipt = { version: 1, nativeWindows: true, noModelRequest: true, noComputerAction: true,
    pid: Number(fs.readFileSync(path.join(root, 'desktop.pid'), 'utf8')), samples: [],
    scope: 'Real sidebar and tab clicks through the existing native renderer; observational timings, not test thresholds.' };
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(p => p.url() === new URL(config.url).href);
    assert(page);
    const api = (name, args = []) => page.evaluate(async ({ name, args }) => window.namzu[name](...args), { name, args });
    const initial = await api('workspace');
    const window = initial.layout.windows.find(w => w.id === initial.windowId);
    const group = groups(window.root).find(g => g.id === window.focusedGroupId);
    assert(group && groups(window.root).length === 1, 'Benchmark only the single existing owning pane.');
    const pals = await api('pals');
    const names = ['Sıtkı', 'Kiro'];
    const expected = pals.filter(p => names.includes(p.name));
    assert.equal(expected.length, 2);
    receipt.models = expected.map(p => ({ name: p.name, revision: p.revision, model: p.model }));
    await page.evaluate(() => {
      window.__palNavigationMeasure = { tasks: [], samples: [] };
      const observer = new PerformanceObserver(list => {
        window.__palNavigationMeasure.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })));
      });
      observer.observe({ type: 'longtask', buffered: false });
      window.__palNavigationMeasure.observer = observer;
    });
    const added = new Set();
    const select = async (name, route) => {
      await page.evaluate(name => {
        const data = window.__palNavigationMeasure;
        data.current = { name, started: null, selected: null, profile: null, ready: null };
        data.done = new Promise(resolve => {
          const check = () => {
            const sample = data.current;
            if (sample.started === null) return;
            const elapsed = performance.now() - sample.started;
            const selected = [...document.querySelectorAll('.sidebar-pal-row[aria-current="page"]')].some(e => e.textContent.includes(name));
            const profile = [...document.querySelectorAll('.pal-context-identity h2')].some(e => e.textContent === name);
            if (selected && sample.selected === null) sample.selected = elapsed;
            if (profile && sample.profile === null) sample.profile = elapsed;
            const editor = document.querySelector('main.workspace textarea[aria-label="Message Namzu"]');
            if (selected && profile && editor && !editor.disabled && sample.ready === null) {
              sample.ready = elapsed;
              requestAnimationFrame(() => requestAnimationFrame(() => {
                sample.painted = performance.now() - sample.started;
                observer.disconnect();
                resolve(sample);
              }));
            }
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
          document.addEventListener('click', () => { data.current.started = performance.now(); check(); }, { once: true, capture: true });
        });
      }, name);
      const button = route === 'sidebar'
        ? page.locator('.sidebar-pal-row').filter({ hasText: name }).first()
        : page.getByRole('tab', { name, exact: true }).first();
      await button.click();
      await page.waitForFunction(() => window.__palNavigationMeasure.current?.painted !== undefined, { timeout: 20000 });
      const measured = await page.evaluate(() => window.__palNavigationMeasure.done);
      const workspace = await api('workspace');
      const current = groups(workspace.layout.windows.find(w => w.id === workspace.windowId)?.root).find(g => g.id === group.id);
      assert(current);
      for (const id of current.tabs) if (!group.tabs.includes(id)) added.add(id);
      receipt.samples.push({ route, name, selectedMs: measured.selected, profileMs: measured.profile, composerMs: measured.ready, paintedMs: measured.painted });
      receipt.expectedTabs = current.tabs;
    };
    try {
      for (const name of ['Sıtkı', 'Kiro', 'Sıtkı', 'Kiro', 'Sıtkı', 'Kiro']) await select(name, 'sidebar');
      for (const name of ['Sıtkı', 'Kiro', 'Sıtkı', 'Kiro']) await select(name, 'tab');
      receipt.longTasks = await page.evaluate(() => window.__palNavigationMeasure.tasks);
      receipt.profilesUnchanged = JSON.stringify(await api('pals')) === JSON.stringify(pals);
      assert(receipt.profilesUnchanged);
    } finally {
      await page.evaluate(() => {
        window.__palNavigationMeasure.observer.disconnect();
      });
      const workspace = await api('workspace');
      const current = groups(workspace.layout.windows.find(w => w.id === workspace.windowId)?.root).find(g => g.id === group.id);
      assert(current && JSON.stringify(current.tabs) === JSON.stringify(receipt.expectedTabs), 'Another actor changed tabs; do not restore over user changes.');
      for (const id of added) await api('workspaceAction', [{ kind: 'close', groupId: group.id, tabId: id }]);
      if (group.activeTabId) await api('workspaceAction', [{ kind: 'activate', groupId: group.id, tabId: group.activeTabId }]);
      const restored = await api('workspace');
      // Layout's monotonically increasing revision records each legitimate
      // navigation action; restoration compares placement, focus and bounds.
      receipt.layoutRestored = placement(restored.layout) === placement(initial.layout);
      assert(receipt.layoutRestored);
    }
    receipt.passed = true;
  } finally {
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
    await browser.close();
  }
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
main().catch(e => { console.error(JSON.stringify({ error: e.name, message: e.message })); process.exitCode = 1; });
