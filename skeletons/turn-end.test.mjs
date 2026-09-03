/**
 * 턴 종료 훅의 테스트 (docs/16 §5 기준 3).
 *
 * 여기서 지키는 계약: **stdout 에 아무것도 쓰지 않는다**(Stop 훅의 stdout 은 종료를 막는 프로토콜 —
 * 계측이 개입이 되면 안 된다), **항상 0 으로 끝난다**(fail-open), **열쇠가 빠진 stop 도 기록된다**
 * (조용히 버리면 "훅 안 돎" 과 "환경이 열쇠를 안 줌" 이 똑같이 보인다).
 *
 * 실행: node --test skeletons/turn-end.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopEventFrom, GATE } from './turn-end.mjs';
import { readLog, logEvent } from './lib/log.mjs';

const HOOK = fileURLToPath(new URL('./turn-end.mjs', import.meta.url));
const run = (root, stdin, args = []) =>
  spawnSync(process.execPath, [HOOK, ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_ROOT: root, CLAUDE_PROJECT_DIR: '' },
  });
const fresh = () => mkdtempSync(path.join(tmpdir(), 'harness-stop-'));
const payload = (o = {}) =>
  JSON.stringify({
    session_id: 's-1',
    prompt_id: 'p-1',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'done',
    ...o,
  });

test('⭐ Stop 페이로드 → stop 이벤트: session·turn 만 싣고 그 외(마지막 메시지 등)는 싣지 않는다', () => {
  assert.deepEqual(stopEventFrom(payload()), { session: 's-1', turn: 'p-1', event: 'stop', gate: GATE });
  const ev = stopEventFrom(payload({ last_assistant_message: '/home/someone/secret' }));
  assert.ok(!JSON.stringify(ev).includes('secret'), '대화 내용은 로그 대상이 아니다');
});

test('⭐ prompt_id 가 없어도 이벤트는 만든다 — 빠진 turn 은 계약 검사가 위반으로 드러내야 한다', () => {
  assert.deepEqual(stopEventFrom(JSON.stringify({ session_id: 's-1' })), { session: 's-1', event: 'stop', gate: GATE });
});

test('페이로드가 JSON 이 아니거나 객체가 아니면 null — 없는 사실은 적지 않는다', () => {
  assert.equal(stopEventFrom(''), null);
  assert.equal(stopEventFrom('{broken'), null);
  assert.equal(stopEventFrom('"just a string"'), null);
  assert.equal(stopEventFrom('null'), null);
});

test('⭐ 훅 경로 — 로그에 한 줄 append, stdout 은 비어 있고, 종료코드 0', () => {
  const root = fresh();
  const r = run(root, payload());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'Stop 훅의 stdout 은 종료를 막는 프로토콜이다 — 계측은 아무것도 쓰지 않는다');
  const { events, broken } = readLog(root);
  assert.equal(broken, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'stop');
  assert.equal(events[0].gate, GATE);
  assert.equal(events[0].turn, 'p-1');
  assert.equal(events[0].session, 's-1');
  assert.ok(events[0].ts);
});

test('⭐ 깨진 페이로드에도 종료코드 0 — stderr 로만 알리고 기록은 없다 (fail-open)', () => {
  const root = fresh();
  const r = run(root, '{broken');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /읽지 못했습니다/);
  assert.equal(existsSync(path.join(root, '.harness', 'log.jsonl')), false);
});

test('--status: stop 이벤트가 없으면 "관찰 없음" 으로 1, 있으면 건수·최근 시각으로 0', () => {
  const root = fresh();
  const none = run(root, '', ['--status']);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /관찰 없음/);
  logEvent({ event: 'stop', gate: GATE, session: 's', turn: 't' }, root);
  const some = run(root, '', ['--status']);
  assert.equal(some.status, 0);
  assert.match(some.stdout, /활성 — stop 이벤트 1건/);
});

// ── 검증 축 대체 경로 — auditOnStop (docs/16 §5 기준 4) ──────────────────────────────
// 여기서 지키는 계약: **스위치는 enabled 가 아니라 auditOnStop 하나**(이중 게이트·거짓 활성 없이 시계열만),
// **audit 은 stop 과 같은 식별자를 싣는다**, **꺼져 있으면 audit 을 남기지 않는다**(미수집은 미수집으로).

import { writeFileSync, mkdirSync } from 'node:fs';
import { auditOnStop, auditEventFrom } from './turn-end.mjs';

/** 합성 설치처 — 경계 안 파일 하나(테스트 없음)를 가진 git 저장소 + 설정. */
function siteWith(config) {
  const root = fresh();
  mkdirSync(path.join(root, 'src', 'engine'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'engine', 'calc.ts'), 'export const x = 1;\n', 'utf8');
  writeFileSync(
    path.join(root, 'harness.config.mjs'),
    `export default ${JSON.stringify(config).replace('"__SCOPE__"', '/^src\\/engine\\/.*\\.ts$/')};\n`,
    'utf8',
  );
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  return root;
}
const cfg = (auditOnStopFlag) => ({
  testFirst: {
    enabled: false,
    auditOnStop: auditOnStopFlag,
    scopes: [{ decision: 'deny', pattern: '__SCOPE__', what: '계산' }],
    exempt: [],
  },
});

test('⭐ 스위치는 testFirst.auditOnStop 하나다 — enabled 는 보지 않는다', () => {
  assert.equal(auditOnStop({ testFirst: { enabled: true } }), false);
  assert.equal(auditOnStop({ testFirst: { enabled: false, auditOnStop: true } }), true);
  assert.equal(auditOnStop({}), false);
  assert.equal(auditOnStop(null), false);
});

test('audit 이벤트는 stop 과 같은 session·turn 을 싣고 수치는 --audit 과 같은 다섯 개다', () => {
  const ev = auditEventFrom(
    { session: 's-1', turn: 'p-1', event: 'stop', gate: GATE },
    { total: 10, inScope: 3, missing: 2, deny: 1, ask: 1, list: [{ path: 'x' }] },
  );
  assert.deepEqual(ev, { session: 's-1', turn: 'p-1', event: 'audit', gate: 'test-first', total: 10, inScope: 3, missing: 2, deny: 1, ask: 1 });
  assert.ok(!('list' in ev), '파일 목록(경로 원문)은 로그에 싣지 않는다');
});

test('⭐ 훅 경로 — auditOnStop:true 면 stop 뒤에 turn 이 실린 audit 이 한 줄 더 남는다', () => {
  const root = siteWith(cfg(true));
  const r = run(root, payload());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const { events } = readLog(root);
  assert.deepEqual(events.map((e) => e.event), ['stop', 'audit']);
  const a = events[1];
  assert.equal(a.gate, 'test-first');
  assert.equal(a.turn, 'p-1');
  assert.equal(a.session, 's-1');
  assert.equal(a.inScope, 1);
  assert.equal(a.missing, 1);
});

test('⭐ auditOnStop 이 꺼져 있으면 stop 만 남는다 — 검증 축은 미수집으로 남는 것이 정직하다', () => {
  const root = siteWith(cfg(false));
  run(root, payload());
  assert.deepEqual(readLog(root).events.map((e) => e.event), ['stop']);
});

test('설정이 없어도 stop 은 남고 종료코드 0 — 선실측은 있으면 하는 것이지 조건이 아니다', () => {
  const root = fresh();
  const r = run(root, payload());
  assert.equal(r.status, 0);
  assert.deepEqual(readLog(root).events.map((e) => e.event), ['stop']);
});
