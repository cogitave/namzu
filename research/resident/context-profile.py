#!/usr/bin/env python3
"""Compare resident context profiles on a two-admission shipping review.

Default preparation makes no model calls. After building, run explicitly:
  python3 research/resident/context-profile.py run /tmp/namzu-resident-context-...
Recollect receipts without invoking models:
  python3 research/resident/context-profile.py collect /tmp/namzu-resident-context-...

One execution per prepared directory; semantic failures are recorded, never retried.
The resident profile's second admission uses a managed background runner.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

HELPER_PATH = Path(__file__).with_name('tool-loading.py')
HELPER_SPEC = importlib.util.spec_from_file_location('resident_tool_loading', HELPER_PATH)
helper = importlib.util.module_from_spec(HELPER_SPEC)
HELPER_SPEC.loader.exec_module(helper)
REPO, BIN, MODEL = helper.REPO, helper.BIN, helper.MODEL
save, load, sha = helper.save, helper.load, helper.sha
command, invoke, wait_background = helper.command, helper.invoke, helper.wait_background

INITIAL_NOTES = '''# Shipping review

Shipping date: 2026-10-01
Review: pending
Next action: wait for reviewer sign-off.
Evidence tag: amber-review-113
'''
APPROVED_NOTES = '''# Shipping review

Shipping date: 2026-10-08
Review: approved
Next action: prepare the release packaging checklist.
Evidence tag: amber-approved-827
'''
PROJECT_POLICY = '''# Project instructions

PROJECT_CONTEXT_RETAINED: This project permits a read-only shipping review.
Use notes.md as the source of shipping facts. Preserve its exact shipping date
and review status in findings. Do not modify files, execute shell commands,
write persistent memory, delegate work, or send external messages.
'''
CURATED_MEMORY = '''# Project memory

CURATED_CONTEXT_RETAINED: Distinguish reviewer approval from shipping completion.
'''
OBJECTIVE = (
    'Monitor the shipping review in notes.md. Read it and retain concise findings '
    'including the current shipping date and review status. While the review is '
    'pending, keep this pursuit open and wait for new reviewer evidence without '
    'scheduling polls. After reviewer approval arrives, check the current notes '
    'again and report the current shipping date and next action, then complete '
    'this review. This is read-only work: do not change files, run shell commands, '
    'save memory, delegate, or send messages.'
)
WAKE = 'Reviewer approval is available in notes.md. Check its current contents and finish the requested shipping review.'
REQUIRED_FILES = {'AGENTS.md', 'notes.md', '.namzu/MEMORY.md'}


def digest_text(text):
    return hashlib.sha256(text.encode()).hexdigest()


def prepare():
    if not helper.NODE or not BIN.is_file():
        raise RuntimeError('Built CLI or Node unavailable; build first.')
    base = Path(tempfile.mkdtemp(prefix='namzu-resident-context-'))
    profiles = []
    for profile in ('interactive', 'resident'):
        cell = base / profile
        for directory in (cell, cell / 'project', cell / 'home', cell / 'xdg-data',
                          cell / 'xdg-config', cell / 'xdg-cache', cell / 'project' / '.namzu'):
            directory.mkdir(mode=0o700)
        for name, content in [('notes.md', INITIAL_NOTES), ('AGENTS.md', PROJECT_POLICY),
                              ('.namzu/MEMORY.md', CURATED_MEMORY)]:
            path = cell / 'project' / name
            path.write_text(content)
            path.chmod(0o600)
        actions = ['run', 'start' if profile == 'resident' else 'run']
        commands = [command(cell, action, '--trust', '--provider', 'zen', '--model', MODEL,
                            '--effort', 'low', '--permission-mode', 'plan',
                            '--tool-loading', 'deferred', '--context-profile', profile,
                            '--max-steps', '1', '--max-idle-ms', '1000',
                            '--max-iterations', '4', '--token-budget', '40000')
                    for action in actions]
        profiles.append(dict(profile=profile, path=str(cell), actions=actions, executions=commands,
                             add=command(cell, 'add', '--trust', '--', OBJECTIVE)))
    save(base / 'manifest.json', dict(
        version=1, repo=str(REPO), cli=str(BIN), profiles=profiles,
        objective=OBJECTIVE, wakeEvidence=WAKE, initialNotes=INITIAL_NOTES,
        approvedNotes=APPROVED_NOTES, projectPolicy=PROJECT_POLICY, curatedMemory=CURATED_MEMORY,
        provider='zen', model=MODEL, effort='low', requestedPermissionMode='plan',
        toolLoading='deferred', maxStepsPerInvocation=1, maxIterations=4,
        tokenBudgetPerStep=40000, maximumAdmittedSteps=4, explicitPublicProvider=True,
        executionNote='Separate synthetic state and project per profile; one sample each; no retries.',
    ))
    print(base)
    print(f'Prepared only. Execute: python3 {Path(__file__).resolve()} run {base}')


def read_status(cell, label):
    code = invoke(cell, command(cell, 'status'), label, timeout=20)
    if code != 0:
        raise RuntimeError(f'{cell.name}: status command failed; inspect {label}.')
    return load(cell / f'{label}.stdout.json')


def fixture_matches(cell, notes):
    project = cell / 'project'
    files = {str(path.relative_to(project)) for path in project.rglob('*') if path.is_file()}
    return (files == REQUIRED_FILES and (project / 'notes.md').read_text() == notes
            and (project / 'AGENTS.md').read_text() == PROJECT_POLICY
            and (project / '.namzu/MEMORY.md').read_text() == CURATED_MEMORY)


def attempts(cell):
    found = []
    for start_path in (cell / 'home').glob('projects/*/cli/residents/default/attempts/*/start.json'):
        start = load(start_path)
        finish_path = start_path.with_name('finish.json')
        finish = load(finish_path) if finish_path.exists() else {}
        run_dir = start_path.parents[5] / 'sessions' / start['sessionId'] / 'runs' / start['runId']
        run_path, transcript_path = run_dir / 'run.json', run_dir / 'transcript.jsonl'
        run = load(run_path) if run_path.exists() else {}
        events = ([json.loads(line) for line in transcript_path.read_text().splitlines()]
                  if transcript_path.exists() else [])
        messages_path = run_dir / 'messages.json'
        messages = load(messages_path).get('messages', []) if messages_path.exists() else []
        system = [message for message in messages if message.get('role') == 'system']
        static = next((m.get('content', '') for m in system if m.get('cacheHint') == 'cache'), '')
        dynamic = next((m.get('content', '') for m in system if m.get('cacheHint') == 'ephemeral'), '')
        envelopes = [event for event in events if event.get('type') == 'request_envelope']
        first_envelope = envelopes[0] if envelopes else {}
        first_prompt = first_envelope.get('systemPrompt', '')
        # First envelopes contain synthetic host context only; keep raw text locally.
        if first_envelope:
            save(start_path.with_name('first-envelope.json'), first_envelope)
        responses = [dict(iteration=e.get('iteration'), stopReason=e.get('stopReason'), usage=e.get('usage'))
                     for e in events if e.get('type') == 'message_completed']
        started = [e for e in events if e.get('type') == 'tool_executing']
        completed = [e for e in events if e.get('type') == 'tool_completed']
        tool_events = [dict(type=e['type'], toolName=e.get('toolName'), toolUseId=e.get('toolUseId'),
                            **({'input': e.get('input')} if e['type'] == 'tool_executing' else
                               {'isError': e.get('isError'), 'result': e.get('result')}))
                       for e in events if e.get('type') in ('tool_executing', 'tool_completed')]
        read_only_notes = all(
            e.get('toolName') == 'read'
            and isinstance((e.get('input') or {}).get('path'), str)
            and (cell / 'project' / e['input']['path']).resolve() == cell / 'project' / 'notes.md'
            for e in started)
        reads = [e for e in completed if e.get('toolName') == 'read' and not e.get('isError')]
        policy = [m for m in messages if (m.get('source') or {}).get('type') == 'project-instructions']
        cost = (finish.get('usage') or {}).get('cost')
        found.append(dict(
            startedAt=start.get('startedAt'), finishedAt=finish.get('finishedAt'),
            startReceipt=str(start_path), finishReceipt=str(finish_path),
            runMetadata=str(run_path), messagesPath=str(messages_path), transcript=str(transcript_path),
            firstEnvelopePath=str(start_path.with_name('first-envelope.json')),
            pursuitId=start.get('pursuitId'), sessionId=start['sessionId'], runId=start['runId'],
            selectedProvider=start.get('provider'), selectedModel=start.get('model'),
            persistedSdkPermissionMode=run.get('metadata', {}).get('config', {}).get('permissionMode'),
            runStatus=run.get('status'), stopReason=finish.get('stopReason'),
            cleanup=finish.get('cleanup'), decision=finish.get('decision'), hasError=bool(finish.get('error')),
            actualUsage=run.get('tokenUsage'), responses=responses, modelResponses=len(responses),
            firstRequest=dict(iteration=first_envelope.get('iteration'),
                              toolNames=first_envelope.get('toolNames'),
                              toolCount=len(first_envelope.get('toolNames', [])),
                              toolSchemaDigest=first_envelope.get('toolSchemaDigest'),
                              systemPromptChars=len(first_prompt), systemPromptSha256=digest_text(first_prompt),
                              providerUsage=responses[0].get('usage') if responses else None),
            segments=dict(staticChars=len(static), staticSha256=digest_text(static),
                          dynamicChars=len(dynamic), dynamicSha256=digest_text(dynamic),
                          objectiveInStatic=OBJECTIVE in static, objectiveInDynamic=OBJECTIVE in dynamic,
                          oldShippingDateInStatic='2026-10-01' in static,
                          oldShippingDateInDynamic='2026-10-01' in dynamic,
                          projectPolicyRetained=any('PROJECT_CONTEXT_RETAINED' in m.get('content', '')
                                                    and m.get('retain') for m in policy),
                          curatedMemoryPresent='CURATED_CONTEXT_RETAINED' in static + dynamic,
                          planReplyDoctrinePresent='Then stop and wait' in first_prompt,
                          residentGuidancePresent='## Resident work' in first_prompt),
            capturedSnapshotText=next((piece for piece in (static + '\n\n' + dynamic).split('\n\n')
                                      if piece.startswith('{"identity":') and '"previousSummary":' in piece), None),
            toolEvents=tool_events, onlyReadNotes=read_only_notes, successfulReads=len(reads),
            readSawPending=any('2026-10-01' in e.get('result', '') and 'Review: pending' in e.get('result', '') for e in reads),
            readSawApproved=any('2026-10-08' in e.get('result', '') and 'Review: approved' in e.get('result', '') for e in reads),
            cost=cost, measuredCostUsd=None if not cost or cost.get('unpricedTokens', 0) else cost.get('totalCost'),
        ))
    return sorted(found, key=lambda attempt: attempt.get('startedAt') or 0)


def summarize(spec):
    cell = Path(spec['path'])
    observed = attempts(cell)
    statuses = {}
    for phase in ('first', 'final'):
        path = cell / f'{phase}-status.stdout.json'
        statuses[phase] = load(path) if path.exists() else {}
    states = {phase: [p.get('state', {}) for p in (status.get('agenda') or {}).get('pursuits', [])]
              for phase, status in statuses.items()}
    owners = {phase: (status.get('runner') or {}).get('owner') or {} for phase, status in statuses.items()}
    first = observed[0] if observed else {}
    second = observed[1] if len(observed) > 1 else {}
    first_decision, second_decision = first.get('decision') or {}, second.get('decision') or {}
    first_summary, second_summary = first_decision.get('summary', ''), second_decision.get('summary', '')
    second_snapshot = json.loads(second['capturedSnapshotText']) if second.get('capturedSnapshotText') else {}
    checks = dict(
        exactlyTwoAdmissions=len(observed) == 2,
        firstWaitsForEvidence=first_decision.get('kind') == 'wait' and first_decision.get('wakeAfterMs', 1) is None,
        firstReadPending=bool(first.get('readSawPending')),
        firstRetainsPendingFacts='2026-10-01' in first_summary and 'pending' in first_summary.lower(),
        secondReadFreshApproval=bool(second.get('readSawApproved')),
        secondCompletesCurrentReview=second_decision.get('kind') == 'complete' and '2026-10-08' in second_summary
                                     and 'packaging checklist' in second_summary.lower(),
        secondReceivesExactSavedSummary=bool(first_summary) and second_snapshot.get('previousSummary') == first_summary,
        objectivePreserved=second_snapshot.get('objective') == OBJECTIVE,
        wakeEvidencePreserved=second_snapshot.get('wakeReason') == WAKE,
        isolatedSessions=bool(second) and first.get('sessionId') != second.get('sessionId'),
        cleanSettlements=len(observed) == 2 and all(a['cleanup'] == 'confirmed' and not a['hasError']
                                                   and a['stopReason'] == 'end_turn' for a in observed),
        onlyFileReads=len(observed) == 2 and all(a['onlyReadNotes'] and a['successfulReads'] >= 1 for a in observed),
        projectPolicyAndMemoryRetained=len(observed) == 2 and all(a['segments']['projectPolicyRetained']
                                                                 and a['segments']['curatedMemoryPresent'] for a in observed),
        firstClaimDrained=len(states['first']) == 1 and states['first'][0].get('claimId') is None
                          and owners['first'].get('phase') == 'stopped',
        finalClaimDrained=len(states['final']) == 1 and states['final'][0].get('claimId') is None
                          and states['final'][0].get('phase') == 'complete' and owners['final'].get('phase') == 'stopped',
        finalFixtureOnlyHostChanged=fixture_matches(cell, APPROVED_NOTES),
    )
    if spec['profile'] == 'resident':
        checks.update(
            stableStaticPrefix=bool(second) and first['segments']['staticSha256'] == second['segments']['staticSha256'],
            refreshedDynamicSnapshot=bool(second) and first['segments']['dynamicSha256'] != second['segments']['dynamicSha256'],
            secondActuallyBackground=owners['final'].get('mode') == 'background',
            profileReachesBothSteps=len(observed) == 2 and all(a['segments']['residentGuidancePresent']
                                                             and not a['segments']['planReplyDoctrinePresent'] for a in observed),
        )
    totals = {key: sum((attempt.get('actualUsage') or {}).get(key, 0) for attempt in observed)
              for key in helper.USAGE_KEYS}
    return dict(profile=spec['profile'], actions=spec['actions'], attempts=observed,
                checks=checks, taskVerified=all(checks.values()), totalUsage=totals,
                modelResponses=sum(a['modelResponses'] for a in observed),
                firstState=states['first'], finalState=states['final'],
                firstRunner=owners['first'], finalRunner=owners['final'])


def collect(base):
    manifest = load(base / 'manifest.json')
    rows = [summarize(spec) for spec in manifest['profiles']]
    baseline, candidate = rows
    comparisons = {}
    for key in helper.USAGE_KEYS:
        before, after = baseline['totalUsage'][key], candidate['totalUsage'][key]
        comparisons[key] = dict(interactive=before, resident=after,
                                residentChangePercent=100 * (after - before) / before if before else None)
    result = dict(
        version=1, kind='resident-context-profile-live', manifest=str(base / 'manifest.json'),
        conditions={key: manifest[key] for key in ('objective', 'wakeEvidence', 'initialNotes', 'approvedNotes',
                                                   'provider', 'model', 'effort', 'requestedPermissionMode', 'toolLoading',
                                                   'maxStepsPerInvocation', 'maxIterations', 'tokenBudgetPerStep')},
        executedBuild=load(base / 'executed-build.json') if (base / 'executed-build.json').exists() else None,
        profiles=rows, allTasksVerified=all(row['taskVerified'] for row in rows),
        totalAdmittedSteps=sum(len(row['attempts']) for row in rows),
        totalModelResponses=sum(row['modelResponses'] for row in rows), comparisons=comparisons,
        measuredCostUsd=None,
        caveats=['One paired synthetic scenario with two admissions per profile; no general performance claim.',
                 'Different project identities and one managed background launch; context-profile order was fixed.',
                 'Provider token reports are actual usage; prompt character counts are not token estimates.',
                 'Each invocation uses a fresh session and retains the previous summary, not its old tool transcript.',
                 'SDK permissionMode auto sits below the CLI requested plan review policy.',
                 'Request envelopes retain tool names and a schema digest, not serialized schema bytes.',
                 'Reported unpriced zero cost does not establish a measured bill.'],
    )
    save(base / 'metrics.json', result)
    for row in rows:
        print(json.dumps(dict(profile=row['profile'], verified=row['taskVerified'], usage=row['totalUsage'],
                              failedChecks=[key for key, passed in row['checks'].items() if not passed],
                              responses=row['modelResponses'])))
    print(f'Metrics: {base / "metrics.json"}')
    return result


def execute(base):
    manifest = load(base / 'manifest.json')
    marker = base / 'execution-started.json'
    with marker.open('x') as file:
        json.dump({'startedAt': time.time()}, file)
    marker.chmod(0o600)
    files = [BIN, REPO / 'packages/cli/dist/tui/agent.js',
             REPO / 'packages/cli/dist/commands/resident-flags.js',
             REPO / 'packages/cli/dist/integrations/resident/session-step.js',
             REPO / 'packages/cli/dist/integrations/resident/runner-worker.js',
             REPO / 'packages/sdk/dist/prompt/resident-step.js',
             REPO / 'packages/sdk/dist/runtime/query/prompt-cache.js', Path(__file__).resolve(), HELPER_PATH]
    save(base / 'executed-build.json', dict(
        hashes={str(path.relative_to(REPO)): sha(path) for path in files},
        gitHead=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
        workingTreeDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True)),
    ))
    try:
        for spec in manifest['profiles']:
            cell = Path(spec['path'])
            print(f'{spec["profile"]}: first admission (foreground)', flush=True)
            if invoke(cell, spec['add'], 'add', timeout=20) != 0:
                raise RuntimeError(f'{cell.name}: add failed; no replay attempted.')
            if invoke(cell, spec['executions'][0], 'first-execution') != 0:
                raise RuntimeError(f'{cell.name}: first execution failed; no replay attempted.')
            first_status = read_status(cell, 'first-status')
            pursuits = (first_status.get('agenda') or {}).get('pursuits', [])
            clean = ((first_status.get('runner') or {}).get('owner') or {}).get('phase') == 'stopped'
            if not fixture_matches(cell, INITIAL_NOTES):
                raise RuntimeError(f'{cell.name}: fixture changed unexpectedly; no second admission.')
            if len(pursuits) != 1 or not clean or pursuits[0]['state'].get('claimId') is not None:
                raise RuntimeError(f'{cell.name}: first claim not drained; no second admission.')
            if pursuits[0]['state']['phase'] != 'waiting':
                save(cell / 'semantic-failure.json', {'reason': 'First admission did not leave a waiting pursuit.'})
                read_status(cell, 'final-status')
                print(f'{cell.name}: semantic failure; no replay or replacement pursuit.', flush=True)
                continue
            # Only the benchmark host changes this one synthetic fixture, after
            # the first process and claim have drained. The wake does not reveal
            # the new date, so the model must read current external evidence.
            (cell / 'project' / 'notes.md').write_text(APPROVED_NOTES)
            save(cell / 'host-update.json', {'afterFirstRunId': attempts(cell)[0]['runId'],
                                           'notesSha256': sha(cell / 'project' / 'notes.md'),
                                           'wakeEvidence': WAKE, 'pursuitId': pursuits[0]['id']})
            if invoke(cell, command(cell, 'wake', pursuits[0]['id'], WAKE), 'wake', timeout=20) != 0:
                raise RuntimeError(f'{cell.name}: wake failed; no second admission.')
            print(f'{spec["profile"]}: second admission ({spec["actions"][1]})', flush=True)
            if invoke(cell, spec['executions'][1], 'second-execution') != 0:
                raise RuntimeError(f'{cell.name}: second execution failed; no replay attempted.')
            if spec['actions'][1] == 'start':
                wait_background(cell)
            read_status(cell, 'final-status')
            row = summarize(spec)
            save(cell / 'metrics.json', row)
            print(f'{cell.name}: taskVerified={row["taskVerified"]}', flush=True)
    finally:
        result = collect(base)
    if not result['allTasksVerified']:
        raise RuntimeError(f'A semantic or lifecycle check failed; inspect {base}; no retry attempted.')


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
    except Exception as error:
        # Summarize failures without printing raw provider or environment data.
        print(f'Comparison stopped: {error}', file=sys.stderr)
        sys.exit(1)
