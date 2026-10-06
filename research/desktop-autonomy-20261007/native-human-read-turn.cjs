'use strict';
// Inserted into the pinned native harness proof's lexical scope by its adapter.
// Uses only that proof's isolated owners, exact process and private receipt.
module.exports = async function sendOne(view, engine, mode, providerId, modelId) {
  phase = `human-read-${engine}`;
  assert(receipt.realPromptsSent < receipt.maxRealPrompts);
  const owned = await owner();
  assert(owned.isolated && owned.projectId === view.projectId && owned.sessionId === view.sessionId);
  const project = await page.evaluate(async id => (await window.namzu.projects()).find(item => item.id === id), view.projectId);
  assert(project?.isChat && project.trusted && !project.palId);
  const projectPath = fs.realpathSync(project.path);
  const relative = path.relative(fs.realpathSync(home), projectPath);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Fixture workspace escaped its private home.');
  const file = path.join(projectPath, 'proof-note.txt');
  const text = 'The demo is called Green Finch.\nThe target is Linux desktop.\nNext: verify reading position during streaming.\n';
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, { flag: 'wx' });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  const prompt = 'Could you read proof-note.txt and tell me the two project facts and the next step? Please answer in English in three short bullets. This is a read-only review; leave files unchanged.';
  const before = await page.evaluate(async ({ projectId, sessionId }) => {
    const value = await window.namzu.openConversation(projectId, sessionId);
    return { count: value.messages.length, turn: value.thread?.turn ?? 0 };
  }, view);
  await page.evaluate(({ sessionId }) => {
    window.__namzuHarnessProbe?.dispose();
    const state = { prompted: false, ended: false, idle: false, permission: null, eventKinds: {}, phases: [] };
    const observe = () => {
      const label = document.querySelector('.normal-transcript > .working[aria-hidden="false"]')?.getAttribute('aria-label');
      if (label && !state.phases.includes(label)) state.phases.push(label);
    };
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    const unsubscribe = window.namzu.onEvent(event => {
      const ownerId = event.kind === 'permission' ? event.request.sessionId : event.sessionId;
      if (ownerId !== sessionId) return;
      const kind = event.kind === 'update' ? event.update.kind : event.kind;
      state.eventKinds[kind] = (state.eventKinds[kind] ?? 0) + 1;
      if (event.kind === 'prompt') { state.prompted = true; state.idle = false; }
      if (event.kind === 'update' && event.update.kind === 'turn_ended') state.ended = true;
      if (event.kind === 'state' && state.prompted && !event.running) state.idle = true;
      if (event.kind === 'permission') state.permission = event.request;
    });
    window.__namzuHarnessProbe = { state, dispose: () => { observer.disconnect(); unsubscribe(); } };
  }, view);
  await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).fill(prompt);
  activeTurn = true;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  receipt.realPromptsSent++;
  let approvals = 0;
  for (;;) {
    // Real integration waits for the admitted event, without a race/speed assertion.
    await page.waitForFunction(() => {
      const state = window.__namzuHarnessProbe?.state;
      return state?.permission || (state?.prompted && state?.ended && state?.idle);
    }, undefined, { timeout: 180000 });
    const observed = await page.evaluate(() => window.__namzuHarnessProbe.state);
    if (!observed.permission) break;
    const permission = observed.permission;
    assert(permission.sessionId === view.sessionId && permission.projectId === view.projectId);
    assert(approvals < 2 && permission.calls.length === 1, 'Unexpected permission batch; preserve fixture for review.');
    const call = permission.calls[0];
    assert(call.input && typeof call.input === 'object');
    // Native ACP conservatively marks every review as destructive. Its exact
    // read contract below is checked independently; Namzu's marker still holds.
    assert(engine !== 'namzu' || !call.isDestructive);
    const readPath = call.input.path ?? call.input.file_path;
    const sameFile = candidate => {
      if (typeof candidate !== 'string') return false;
      const resolved = path.resolve(projectPath, candidate);
      const entry = fs.lstatSync(resolved, { bigint: true });
      const exact = fs.lstatSync(file, { bigint: true });
      return entry.isFile() && !entry.isSymbolicLink() && entry.dev === exact.dev && entry.ino === exact.ino;
    };
    const sameDirectory = candidate => {
      if (typeof candidate !== 'string') return false;
      const entry = fs.statSync(candidate, { bigint: true });
      const exact = fs.statSync(projectPath, { bigint: true });
      return entry.isDirectory() && entry.dev === exact.dev && entry.ino === exact.ino;
    };
    const fileRead = (engine === 'namzu' ? /^(read|read_file)$/.test(call.name) : engine === 'claude-code' && call.name === 'Read') && typeof readPath === 'string' &&
      sameFile(readPath);
    const commandRead = engine === 'codex-cli' && call.name === 'Approve Codex command' &&
      sameDirectory(call.input.cwd) && typeof call.input.command === 'string' &&
      /^(cat (?:\.\/)?proof-note\.txt|Get-Content (?:\.\\)?proof-note\.txt|type proof-note\.txt)$/.test(call.input.command.trim());
    assert(fileRead || commandRead, 'Only the exact fixture file read can be approved.');
    const stillOwned = await owner();
    assert(stillOwned.isolated && stillOwned.projectId === view.projectId && stillOwned.sessionId === view.sessionId);
    const firstPending = await page.evaluate(async ({ projectId, sessionId }) =>
      (await window.namzu.openConversation(projectId, sessionId)).thread?.permissions?.[0], view);
    assert(firstPending?.id === permission.id && firstPending.sessionId === view.sessionId && firstPending.projectId === view.projectId &&
      JSON.stringify(firstPending.calls) === JSON.stringify(permission.calls), 'The visible approval is not the exact validated pending read.');
    await page.getByRole('region', { name: 'Tool approval', exact: true }).getByRole('button', { name: 'Allow once', exact: true }).click();
    approvals++;
    await page.evaluate(id => {
      if (window.__namzuHarnessProbe.state.permission?.id === id) window.__namzuHarnessProbe.state.permission = null;
    }, permission.id);
  }
  await page.waitForFunction(() => !document.querySelector('.normal-transcript > .working[aria-hidden="false"]'));
  const terminal = await page.evaluate(async ({ projectId, sessionId, count }) => {
    const value = await window.namzu.openConversation(projectId, sessionId);
    const appended = value.messages.slice(count);
    const route = (await window.namzu.providers(projectId, sessionId)).selected;
    const answer = appended.filter(row => row.role === 'assistant' && row.phase !== 'commentary').map(row => row.text).join('\n');
    const observed = window.__namzuHarnessProbe.state;
    const tools = Object.values(value.thread?.tools ?? {});
    return {
      stopReason: value.thread?.stopReason ?? null, error: Boolean(value.thread?.error),
      userRows: appended.filter(row => row.role === 'user').length,
      assistantRows: appended.filter(row => row.role === 'assistant' && row.text.trim()).length,
      factsMatch: /green finch/i.test(answer) && /linux/i.test(answer) && /reading|scroll/i.test(answer),
      toolRows: tools.length, completedToolRows: tools.filter(tool => tool.status === 'completed').length, toolStates: tools.map(tool => tool.status),
      visiblePhaseLabels: observed.phases, publicEventCounts: observed.eventKinds,
      count: value.messages.length, turn: value.thread?.turn ?? 0, running: value.thread?.running,
      selectedRoute: { provider: route?.id ?? null, model: route?.model ?? null },
      liveStatusVisible: Boolean(document.querySelector('.normal-transcript > .working[aria-hidden="false"]')),
    };
  }, { ...view, count: before.count });
  assert(terminal.count > before.count && terminal.turn > before.turn && !terminal.running);
  terminal.routeMatches = terminal.selectedRoute.provider === providerId && terminal.selectedRoute.model === modelId;
  delete terminal.selectedRoute;
  terminal.fixtureBytesUnchanged = fs.readFileSync(file, 'utf8') === text;
  terminal.approvedExactFixtureReads = approvals;
  await page.evaluate(() => { window.__namzuHarnessProbe.dispose(); window.__namzuHarnessProbe = undefined; });
  activeTurn = false;
  assert(terminal.fixtureBytesUnchanged);
  return { mode, ...terminal };
};
