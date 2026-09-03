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
