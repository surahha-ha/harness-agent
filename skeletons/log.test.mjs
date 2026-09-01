/**
 * v1 로그 층의 테스트.
 *
 * 핵심 계약 둘을 본다 — **원문 명령이 로그에 들어가지 않는다**(접두사 정규화),
 * **기록 실패가 판정을 막지 않는다**(fail-open). 지표는 이 층을 신뢰하고 쌓이므로
 * 이 계약이 깨지면 위로 쌓인 전부가 무효다.
 *
 * 실행: node --test skeletons/log.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeCmdPrefix,
  logEvent,
  readLog,
  logPath,
  isPairablePrefix,
  extractContext,
  UNPARSED_PREFIX,
} from './lib/log.mjs';

// ── 식별자 셋 — 훅 페이로드에서 (docs/16) ─────────────────────────────────────────

test('⭐ 세션·턴·호출 식별자는 훅 페이로드에서 온다 — 환경변수가 아니다', () => {
  const raw = JSON.stringify({
    session_id: 's1',
    prompt_id: 'p1',
    tool_use_id: 'toolu_1',
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
  });
  assert.deepEqual(extractContext(raw), { session: 's1', turn: 'p1', call: 'toolu_1' });
});

test('없는 식별자는 필드 자체가 생략된다 — 빈 값과 없음을 구분', () => {
  assert.deepEqual(extractContext(JSON.stringify({ session_id: 's1', prompt_id: '' })), { session: 's1' });
  assert.deepEqual(extractContext(JSON.stringify({ tool_input: { command: 'x' } })), {});
});

test('페이로드가 JSON 이 아니면 빈 객체 — 식별자 부재가 판정을 막지 않는다', () => {
  assert.deepEqual(extractContext('git status'), {});
  assert.deepEqual(extractContext(''), {});
});

test('logEvent 는 이벤트에 실린 session 을 환경변수보다 우선한다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  const prev = process.env.CLAUDE_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = 'from-env';
  try {
    logEvent({ session: 'from-payload', turn: 'p1', event: 'pass', gate: 'g', cmdPrefix: 'git' }, root);
    logEvent({ event: 'pass', gate: 'g', cmdPrefix: 'git' }, root);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = prev;
  }
  const { events } = readLog(root);
  assert.equal(events[0].session, 'from-payload');
  assert.equal(events[0].turn, 'p1');
  assert.equal(events[1].session, 'from-env', '페이로드가 없으면 종전대로 환경변수');
});

test('접두사 = 첫 토큰 + 첫 서브커맨드', () => {
  assert.equal(normalizeCmdPrefix('git push origin main'), 'git push');
  assert.equal(normalizeCmdPrefix('docker volume rm data'), 'docker volume');
});

test('⭐ 두 번째 토큰이 플래그·경로·리다이렉션이면 버린다 — 원문 유입 차단', () => {
  assert.equal(normalizeCmdPrefix('rm -rf /var/data'), 'rm');
  assert.equal(normalizeCmdPrefix('cat ./secret/path.txt'), 'cat');
  assert.equal(normalizeCmdPrefix('echo >file.txt'), 'echo');
  assert.equal(normalizeCmdPrefix("psql 'INSERT INTO t'"), 'psql');
});

test('빈 명령은 빈 접두사 — 던지지 않는다', () => {
  assert.equal(normalizeCmdPrefix(''), '');
  assert.equal(normalizeCmdPrefix('   '), '');
  assert.equal(normalizeCmdPrefix(null), '');
});

test('⭐ F26 — 첫 토큰이 명령 이름이 아니면 통째로 접는다 (변수 대입에 실린 절대경로 유입 차단)', () => {
  // 공백이 없어 한 토큰인 변수 대입 — 판별이 없던 시절 이 원문이 그대로 로그에 실렸다.
  assert.equal(normalizeCmdPrefix('TMP="/home/someone/work/secret"; mkdir -p "$TMP"'), UNPARSED_PREFIX);
  assert.equal(normalizeCmdPrefix('K=\'A1b2C3d4\'; use "$K"'), UNPARSED_PREFIX);
  assert.equal(normalizeCmdPrefix('$sp="C:/Users/someone/tmp"; ls'), UNPARSED_PREFIX);
  assert.equal(normalizeCmdPrefix('/absolute/path/to/tool run'), UNPARSED_PREFIX);
});

test('⭐ F26 — 접는 값은 잘라 남기지 않는다 (남은 조각도 원문이다)', () => {
  const out = normalizeCmdPrefix('LOG="/home/someone/build.log"; tail "$LOG"');
  assert.equal(out, UNPARSED_PREFIX);
  assert.ok(!out.includes('someone'), '경로의 어떤 조각도 남지 않는다');
  assert.ok(!out.includes('/'), '구분자조차 남지 않는다');
});

test('정상 명령과 한 마디 상대경로 실행은 그대로 유지된다 — 접기가 과잉이면 지표가 죽는다', () => {
  assert.equal(normalizeCmdPrefix('git push origin main'), 'git push');
  assert.equal(normalizeCmdPrefix('./gradlew test'), './gradlew test');
  assert.equal(normalizeCmdPrefix('_myfunc arg'), '_myfunc arg');
  assert.equal(normalizeCmdPrefix('node script.mjs'), 'node script.mjs');
});

test('여러 마디 상대경로는 접는다 — 저장소 내부 구조도 접두사에 남길 것이 아니다', () => {
  // `./gradlew` 같은 한 마디 실행은 승격 단위로 쓸 값이 있지만, 마디가 늘어나면 그때부터는
  // 명령 이름이 아니라 경로다. 경계를 "한 마디" 에 둬야 판별이 서고, 애매한 쪽은 접는다.
  assert.equal(normalizeCmdPrefix('../tools/run.sh'), UNPARSED_PREFIX);
  assert.equal(normalizeCmdPrefix('./scripts/deploy/run.sh --now'), UNPARSED_PREFIX);
});

test('⭐ 접힌 접두사는 짝짓기 열쇠가 될 수 없다 — 뭉친 것을 같다고 보면 남의 승인을 센다', () => {
  assert.equal(isPairablePrefix('git push'), true);
  assert.equal(isPairablePrefix(UNPARSED_PREFIX), false);
  assert.equal(isPairablePrefix(''), false);
  assert.equal(isPairablePrefix(undefined), false);
});

test('기록 → 읽기 왕복. ts 는 기록 시점에 찍힌다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  assert.equal(logEvent({ event: 'pass', gate: 'danger-guard', cmdPrefix: 'git status' }, root), true);
  assert.equal(
    logEvent({ event: 'fire', gate: 'danger-guard', rule: 'r1', decision: 'deny', probe: false, cmdPrefix: 'wipe-all' }, root),
    true,
  );
  const { events, broken } = readLog(root);
  assert.equal(events.length, 2);
  assert.equal(broken, 0);
  assert.equal(events[0].event, 'pass');
  assert.ok(events[0].ts, 'ts 가 자동으로 찍혀야 한다');
  assert.equal(events[1].rule, 'r1');
});

test('로그 파일이 없으면 빈 결과 — 오류가 아니다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  assert.deepEqual(readLog(root), { events: [], broken: 0 });
});

test('⭐ 깨진 줄은 건너뛰되 개수를 센다 — 못 읽은 줄을 모르는 집계는 집계가 아니다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  logEvent({ event: 'pass', gate: 'g', cmdPrefix: 'ls' }, root);
  // 손상 시뮬레이션 — 로그 끝에 잘린 줄이 붙는다 (프로세스 중단 등).
  const p = logPath(root);
  const raw = readFileSync(p, 'utf8');
  appendFileSync(p, '{"event":"fire","broken', 'utf8');
  const r = readLog(root);
  assert.equal(r.events.length, 1);
  assert.equal(r.broken, 1);
  assert.ok(raw.length > 0);
});

test('⭐ 기록 실패는 false 를 돌려주고 던지지 않는다 — 로그는 게이트가 아니다', () => {
  // 파일을 루트처럼 넘겨 mkdir 를 실패시킨다.
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  const asFile = path.join(root, 'not-a-dir');
  writeFileSync(asFile, 'x', 'utf8');
  assert.equal(logEvent({ event: 'pass', gate: 'g', cmdPrefix: 'ls' }, asFile), false);
});
