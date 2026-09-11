#!/usr/bin/env python3
"""Synthetic built-CLI benchmark. Preparation/collection never invoke a model.

Prepare (default, no model calls): python3 research/resident/tool-loading.py
Execute explicitly after build: python3 research/resident/tool-loading.py run /tmp/namzu-resident-tools-...
Extract again without execution: python3 research/resident/tool-loading.py collect /tmp/namzu-resident-tools-...
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
BIN = REPO / 'packages/cli/dist/bin.js'
NODE = shutil.which('node')
MODEL = 'muse-spark-1.3-contributor-free'
README = '# Synthetic resident benchmark\n\nThe verification tag is amber-river-731.\n'
OBJECTIVES = {
    'no-tool': 'This is a minimal synthetic task. Complete this pursuit now with the exact summary resident-benchmark-ready. Do not use tools, search for tools, read files, run commands, write memory, delegate work, or change anything. Use the required resident JSON decision format.',
    'readme': 'Read only README.md in the current directory exactly once using the file-reading tool. If the tool is deferred, discover it first. Complete this pursuit with a short summary containing the verification tag found in that file. Do not read other files, execute shell commands, change files, write memory, delegate work, or send messages. Use the required resident JSON decision format.',
}
USAGE_KEYS = ('promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens')


def save(path, value):
    path = Path(path)
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def load(path):
    return json.loads(Path(path).read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def env_for(cell):
    # Retain ordinary process/network settings; do not copy ambient provider keys,
    # NAMZU config overrides, NODE_OPTIONS, telemetry exporters, or plugin flags.
    names = ('PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ',
             'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
             'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
             'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS')
    env = {name: os.environ[name] for name in names if name in os.environ}
    env.update(NAMZU_HOME=str(cell / 'home'), OPENCODE_API_KEY='public',
               OPENCODE_AUTH_CONTENT='{}', NO_COLOR='1', CI='1',
               XDG_DATA_HOME=str(cell / 'xdg-data'),
               XDG_CONFIG_HOME=str(cell / 'xdg-config'),
               XDG_CACHE_HOME=str(cell / 'xdg-cache'))
    return env


def command(cell, action, *extra):
    return [NODE, str(BIN), '--format', 'json', 'resident', action,
            '--cwd', str(cell / 'project'), *extra]


def prepare():
    if not NODE or not BIN.is_file():
        raise RuntimeError('Built CLI or Node unavailable; build first.')
    base = Path(tempfile.mkdtemp(prefix='namzu-resident-tools-'))
    cells = []
    for task, mode in [('no-tool', 'eager'), ('no-tool', 'deferred'),
                       ('readme', 'eager'), ('readme', 'deferred')]:
        name = f'{task}-{mode}'
        cell = base / name
        for directory in (cell, cell / 'project', cell / 'home', cell / 'xdg-data',
                          cell / 'xdg-config', cell / 'xdg-cache'):
            directory.mkdir(mode=0o700)
        (cell / 'project' / 'README.md').write_text(README)
        (cell / 'project' / 'README.md').chmod(0o600)
        # One actual managed child checks launch/worker flag propagation.
        action = 'start' if name == 'no-tool-deferred' else 'run'
        execute = command(cell, action, '--trust', '--provider', 'zen', '--model', MODEL,
                          '--effort', 'low', '--permission-mode', 'plan',
                          '--tool-loading', mode, '--max-steps', '1', '--max-idle-ms', '1000',
                          '--max-iterations', '4', '--token-budget', '40000')
        cells.append(dict(name=name, task=task, toolLoading=mode, action=action,
                          objective=OBJECTIVES[task], path=str(cell),
                          add=command(cell, 'add', '--trust', '--', OBJECTIVES[task]),
                          execute=execute, readmeSha256=sha(cell / 'project' / 'README.md')))
    manifest = dict(version=1, repo=str(REPO), cli=str(BIN), cells=cells,
                    provider='zen', model=MODEL, effort='low', permissionMode='plan',
                    maxSteps=1, maxIterations=4, tokenBudget=40000,
                    explicitPublicProvider=True,
                    note='One sample per task/mode; no-tool deferred uses background start. Compare first request and whole-step totals separately. Actual schemas are not persisted; envelope records names/digest only.')
    save(base / 'manifest.json', manifest)
    print(base)
    print(f'Prepared only. Run explicitly after building: python3 {Path(__file__).resolve()} run {base}')


def invoke(cell, argv, label, timeout=150):
    out_path, err_path = cell / f'{label}.stdout.json', cell / f'{label}.stderr.log'
    with out_path.open('w') as out, err_path.open('w') as err:
        out_path.chmod(0o600)
        err_path.chmod(0o600)
        proc = subprocess.Popen(argv, cwd=cell / 'project', env=env_for(cell),
                                stdin=subprocess.DEVNULL, stdout=out, stderr=err)
        deadline, report = time.monotonic() + timeout, time.monotonic() + 15
        while proc.poll() is None:
            now = time.monotonic()
            if now >= deadline:
                # Signal only this directly spawned process, never a PID from state.
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    raise RuntimeError(f'{label} did not drain; inspect {cell}, no replay attempted.')
                raise RuntimeError(f'{label} timed out; inspect {cell}, no replay attempted.')
            if now >= report:
                print(f'{cell.name}: waiting for {label}', flush=True)
                report = now + 15
            time.sleep(0.2)
    return proc.returncode


def wait_background(cell):
    deadline, count = time.monotonic() + 150, 0
    while time.monotonic() < deadline:
        count += 1
        label = f'poll-{count:03d}'
        if invoke(cell, command(cell, 'status'), label, timeout=15) != 0:
            raise RuntimeError(f'Background status failed; inspect {cell}.')
        state = load(cell / f'{label}.stdout.json')
        owner = (state.get('runner') or {}).get('owner') or {}
        if owner.get('phase') == 'stopped':
            return
        if owner.get('phase') == 'released':
            raise RuntimeError(f'Unexpected released owner at {cell}.')
        time.sleep(2)
    invoke(cell, command(cell, 'stop'), 'timeout-stop', timeout=30)
    raise RuntimeError(f'Background run exceeded deadline; stop requested, inspect {cell}.')


def summarize_cell(spec):
    cell = Path(spec['path'])
    status_path = cell / 'final-status.stdout.json'
    status = load(status_path) if status_path.exists() else {}
    pursuit_states = [dict(id=p.get('id'), phase=p.get('state', {}).get('phase'),
                           claimId=p.get('state', {}).get('claimId'),
                           stepsAdmitted=p.get('state', {}).get('stepsAdmitted'))
                      for p in (status.get('agenda') or {}).get('pursuits', [])]
    final_owner = (status.get('runner') or {}).get('owner') or {}
    attempts = []
    for start_path in sorted((cell / 'home').glob('projects/*/cli/residents/default/attempts/*/start.json')):
        start = load(start_path)
        finish_path = start_path.with_name('finish.json')
        finish = load(finish_path) if finish_path.exists() else {}
        project_root = start_path.parents[5]
        run_dir = project_root / 'sessions' / start['sessionId'] / 'runs' / start['runId']
        run_path = run_dir / 'run.json'
        run = load(run_path) if run_path.exists() else {}
        transcript = run_dir / 'transcript.jsonl'
        events = [json.loads(line) for line in transcript.read_text().splitlines()] if transcript.exists() else []
        responses = [dict(iteration=e.get('iteration'), stopReason=e.get('stopReason'), usage=e.get('usage'))
                     for e in events if e.get('type') == 'message_completed']
        envelopes = [dict(iteration=e.get('iteration'), toolNames=e.get('toolNames'),
                          toolCount=len(e.get('toolNames', [])), toolSchemaDigest=e.get('toolSchemaDigest'),
                          systemPromptChars=len(e.get('systemPrompt', '')),
                          systemPromptUtf8Bytes=len(e.get('systemPrompt', '').encode()))
                     for e in events if e.get('type') == 'request_envelope']
        tools = [dict(type=e['type'], toolName=e.get('toolName'), isError=e.get('isError'),
                      toolUseId=e.get('toolUseId')) for e in events
                 if e.get('type') in ('tool_executing', 'tool_completed')]
        read_results = [e for e in events if e.get('type') == 'tool_completed' and
                        e.get('toolName') == 'read' and not e.get('isError')]
        usage_sum = {key: sum((r.get('usage') or {}).get(key, 0) for r in responses) for key in USAGE_KEYS}
        attempts.append(dict(startReceipt=str(start_path), finishReceipt=str(finish_path),
                             sessionId=start['sessionId'], runId=start['runId'], runMetadata=str(run_path),
                             transcript=str(transcript), messages=str(run_dir / 'messages.json'),
                             selectedProvider=start.get('provider'), selectedModel=start.get('model'),
                             persistedSdkPermissionMode=run.get('metadata', {}).get('config', {}).get('permissionMode'),
                             runStatus=run.get('status'), stopReason=finish.get('stopReason'),
                             cleanup=finish.get('cleanup'), decision=finish.get('decision'),
                             hasError=bool(finish.get('error')), actualUsage=run.get('tokenUsage'),
                             responseUsageSum=usage_sum, responses=responses, requestEnvelopes=envelopes,
                             toolEvents=tools, successfulReads=len(read_results),
                             readContainsExpectedTag=any('amber-river-731' in e.get('result', '') for e in read_results),
                             cost=finish.get('usage', {}).get('cost')))
    unchanged = ((cell / 'project' / 'README.md').is_file() and
                 sha(cell / 'project' / 'README.md') == spec['readmeSha256'] and
                 sorted(p.name for p in (cell / 'project').iterdir()) == ['README.md'])
    successful = len(attempts) == 1 and all(a['cleanup'] == 'confirmed' and
                 a['stopReason'] == 'end_turn' and (a['decision'] or {}).get('kind') == 'complete'
                 and not a['hasError'] for a in attempts)
    if spec['task'] == 'no-tool':
        task_ok = successful and not attempts[0]['toolEvents'] and (attempts[0]['decision'] or {}).get('summary') == 'resident-benchmark-ready'
    else:
        task_ok = successful and attempts[0]['successfulReads'] == 1 and attempts[0]['readContainsExpectedTag'] and 'amber-river-731' in (attempts[0]['decision'] or {}).get('summary', '') and all(t['toolName'] in ('read', 'search_tools') for t in attempts[0]['toolEvents'])
    return dict(name=spec['name'], action=spec['action'], toolLoading=spec['toolLoading'],
                requestedPermissionMode='plan', attempts=attempts, fixtureUnchanged=unchanged,
                finalStatusPath=str(status_path), finalPursuitStates=pursuit_states,
                finalRunnerPhase=final_owner.get('phase'), finalRunnerOutcome=final_owner.get('outcome'),
                finalAdmissionPaused=(status.get('agenda') or {}).get('paused'),
                taskVerified=bool(task_ok and unchanged and len(pursuit_states) == 1 and
                                  pursuit_states[0]['phase'] == 'complete' and
                                  pursuit_states[0]['claimId'] is None and
                                  final_owner.get('phase') == 'stopped'))


def collect(base):
    manifest = load(base / 'manifest.json')
    rows = [summarize_cell(spec) for spec in manifest['cells']]
    result = dict(version=1, manifest=str(base / 'manifest.json'), cells=rows,
                  allTasksVerified=all(row['taskVerified'] for row in rows),
                  caveats=['Single sample per case; different project identities and one background launch.',
                           'Prompt/completion usage comes from provider reports, not local estimates.',
                           'SDK permissionMode auto is stored below the CLI review policy; requested plan is recorded separately.',
                           'Request envelopes persist tool names/digest, not actual schema bytes.',
                           'Unpriced zero cost does not establish a measured bill.'])
    save(base / 'metrics.json', result)
    for row in rows:
        for attempt in row['attempts']:
            print(json.dumps(dict(case=row['name'], verified=row['taskVerified'], usage=attempt['actualUsage'],
                                  responses=len(attempt['responses']), firstRequest=attempt['requestEnvelopes'][:1])))
    print(f'Metrics and receipt/session paths: {base / "metrics.json"}')
    return result


def execute(base):
    manifest = load(base / 'manifest.json')
    # Refuse a second execution of a partially finished matrix; never auto-replay.
    marker = base / 'execution-started.json'
    with marker.open('x') as file:
        json.dump({'startedAt': time.time()}, file)
    marker.chmod(0o600)
    files = [BIN, REPO / 'packages/cli/dist/tui/agent.js',
             REPO / 'packages/cli/dist/commands/resident-flags.js',
             REPO / 'packages/cli/dist/integrations/resident/session-step.js',
             REPO / 'packages/cli/dist/integrations/resident/runner-worker.js']
    save(base / 'executed-build.json', {str(p.relative_to(REPO)): sha(p) for p in files})
    try:
        for spec in manifest['cells']:
            cell = Path(spec['path'])
            print(f'Running {spec["name"]} ({spec["action"]})', flush=True)
            if invoke(cell, spec['add'], 'add', timeout=20) != 0:
                raise RuntimeError(f'Add failed; inspect {cell}.')
            if invoke(cell, spec['execute'], 'execution') != 0:
                raise RuntimeError(f'Execution failed; inspect {cell}.')
            if spec['action'] == 'start':
                wait_background(cell)
            if invoke(cell, command(cell, 'status'), 'final-status', timeout=20) != 0:
                raise RuntimeError(f'Final status failed; inspect {cell}.')
            row = summarize_cell(spec)
            save(cell / 'metrics.json', row)
            print(f'{spec["name"]}: taskVerified={row["taskVerified"]}', flush=True)
    finally:
        result = collect(base)
    if not result['allTasksVerified']:
        raise RuntimeError(f'One or more task outcomes failed verification; inspect {base}.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'run', 'collect'], nargs='?', default='prepare')
    parser.add_argument('base', nargs='?', type=Path)
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare()
    elif args.base is None:
        parser.error('run/collect require the prepared base directory')
    elif args.action == 'run':
        execute(args.base.resolve())
    else:
        collect(args.base.resolve())


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # No raw CLI/provider error text or credential-bearing environment output.
        print(f'Benchmark stopped: {exc}', file=sys.stderr)
        sys.exit(1)
