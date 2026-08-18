/**
 * 골격 1 가드의 테스트.
 *
 * 가드를 신뢰하려면 가드를 검증해야 한다. 여기서 보는 것은 **판정 구조**다 —
 * 규칙 내용은 프로젝트 설정에서 오므로 테스트도 합성 설정으로 한다.
 *
 * 실행: node --test skeletons/danger-guard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, extractCommand, statusOf } from './danger-guard.mjs';
import { compile } from './lib/config.mjs';

/** 합성 설정 — 실제 프로젝트 규칙이 아니라 구조를 보기 위한 최소값. */
const cfg = {
  dangerGuard: {
    enabled: true,
    deny: [{ pattern: '\\bwipe-all\\b', why: '전부 지웁니다.', recover: '백업에서 복원하세요.' }],
    ask: [{ pattern: '\\bwipe-all\\b', why: 'ask 쪽에도 같은 패턴이 있다.' }],
    shared: {
      targetPattern: '--target\\s+shared',
      writePattern: '\\b(WRITE|DELETE)\\b',
      why: '공유 대상에 쓰기.',
    },
  },
};

test('deny 가 ask 보다 먼저다 — 더 강한 판정이 이긴다', () => {
  assert.equal(evaluate('wipe-all', cfg).decision, 'deny');
});

test('규칙에 적힌 복구 경로를 그대로 돌려준다', () => {
  assert.equal(evaluate('wipe-all', cfg).recover, '백업에서 복원하세요.');
});

test('복구 경로가 없으면 기본 문구가 들어간다 — 비어 있지 않다', () => {
  const c = { dangerGuard: { enabled: true, ask: [{ pattern: 'risky', why: '위험' }] } };
  const hit = evaluate('risky', c);
  assert.equal(hit.decision, 'ask');
  assert.ok(hit.recover.length > 0);
});

test('공유 자원은 대상과 쓰기의 교집합일 때만 잡는다', () => {
  assert.equal(evaluate('cmd --target shared WRITE x', cfg).decision, 'ask');
});

test('공유 대상이어도 조회면 잡지 않는다 — 읽기를 막으면 가드가 꺼진다', () => {
  assert.equal(evaluate('cmd --target shared READ x', cfg), null);
});

test('쓰기여도 대상이 공유가 아니면 잡지 않는다', () => {
  assert.equal(evaluate('cmd --target local WRITE x', cfg), null);
});

test('enabled:false 면 아무것도 판정하지 않는다', () => {
  assert.equal(evaluate('wipe-all', { dangerGuard: { ...cfg.dangerGuard, enabled: false } }), null);
});

test('규칙이 하나도 없으면 통과시킨다 — 설정이 곧 정책이다', () => {
  assert.equal(evaluate('wipe-all', { dangerGuard: { enabled: true } }), null);
});

test('잘못된 패턴 하나가 나머지 규칙을 죽이지 않는다', () => {
  const c = {
    dangerGuard: {
      enabled: true,
      deny: [
        { pattern: '[', why: '깨진 패턴' },
        { pattern: 'boom', why: '정상 규칙' },
      ],
    },
  };
  assert.equal(evaluate('boom', c).why, '정상 규칙');
});

test('빈 명령은 판정하지 않는다', () => {
  assert.equal(evaluate('   ', cfg), null);
});

test('정규식 리터럴을 패턴으로 쓸 수 있다 — 권장 형태', () => {
  const c = { dangerGuard: { enabled: true, deny: [{ pattern: /\bvolume\s+rm\b/, why: '리터럴' }] } };
  assert.equal(evaluate('toolx volume rm data', c).why, '리터럴');
});

test('⭐ 이스케이프가 소실된 문자열 패턴은 조용히 통과시키지 않는다', () => {
  // '\bfoo' 를 문자열로 쓰면 JS 가 \b 를 백스페이스로 만든다. 오류는 안 나고 뜻만 달라진다 —
  // 규칙이 영원히 안 걸리는데 아무도 모르는 상태가 된다. 그래서 오류로 돌린다.
  const broken = String.fromCharCode(8) + 'volume';
  const r = compile(broken);
  assert.ok(r.error, '제어문자가 섞인 패턴은 error 를 돌려줘야 한다');
  assert.match(r.error, /정규식 리터럴/);
});

test('패턴이 문자열도 정규식도 아니면 오류로 돌린다', () => {
  assert.ok(compile(42).error);
});

test('⭐ 규칙이 0개면 active 가 아니라 empty 다 — 거짓 활성은 미설치보다 나쁘다', () => {
  assert.equal(statusOf({ dangerGuard: { enabled: true } }).state, 'empty');
  assert.equal(statusOf({ dangerGuard: { enabled: true, deny: [], ask: [] } }).state, 'empty');
});

test('규칙이 하나라도 있으면 active', () => {
  assert.equal(statusOf(cfg).state, 'active');
});

test('공유자원 규칙만 있어도 active 다', () => {
  const c = { dangerGuard: { enabled: true, shared: { targetPattern: /a/, writePattern: /b/ } } };
  assert.equal(statusOf(c).state, 'active');
});

test('enabled:false 는 off — empty 와 구분한다', () => {
  assert.equal(statusOf({ dangerGuard: { enabled: false, deny: [{}] } }).state, 'off');
});

test('설정 자체가 없어도 상태 판정이 죽지 않는다', () => {
  assert.equal(statusOf(undefined).state, 'empty');
});

test('⭐ 프로브 — 표식이 든 명령은 deny 로 잡히고 probe:true 로 표시된다 (F13)', () => {
  const c = { dangerGuard: { enabled: true, probe: { token: 'HARNESS-PROBE-7f3a' } } };
  const hit = evaluate('echo HARNESS-PROBE-7f3a', c);
  assert.equal(hit.decision, 'deny');
  assert.equal(hit.probe, true);
  assert.equal(hit.rule, 'probe');
});

test('⭐ 프로브만 있으면 empty 다 — 프로브가 규칙 수를 채워 활성으로 보이면 거짓 활성의 재발이다', () => {
  const c = { dangerGuard: { enabled: true, probe: { token: 'HARNESS-PROBE-7f3a' } } };
  const s = statusOf(c);
  assert.equal(s.state, 'empty');
  assert.equal(s.probe, true);
});

test('프로브는 실규칙에 앞선다 — 프로브 명령이 실규칙에도 걸리면 그 프로브는 기준 위반이다', () => {
  const c = {
    dangerGuard: {
      enabled: true,
      deny: [{ pattern: /PROBE/, why: '실규칙이 우연히 덮는다' }],
      probe: { token: 'HARNESS-PROBE-7f3a' },
    },
  };
  assert.equal(evaluate('echo HARNESS-PROBE-7f3a', c).probe, true);
});

test('실규칙 발동은 probe:false 이고 rule 은 id, 없으면 패턴 문자열이다', () => {
  const withId = {
    dangerGuard: { enabled: true, deny: [{ id: 'no-wipe', pattern: /\bwipe-all\b/, why: 'w' }] },
  };
  assert.equal(evaluate('wipe-all', withId).rule, 'no-wipe');
  assert.equal(evaluate('wipe-all', withId).probe, false);
  assert.equal(evaluate('wipe-all', cfg).rule, '\\bwipe-all\\b');
});

test('공유 자원 발동의 rule 은 shared 다', () => {
  assert.equal(evaluate('cmd --target shared WRITE x', cfg).rule, 'shared');
});

test('훅 입력 JSON 에서 명령을 꺼낸다', () => {
  assert.equal(extractCommand('{"tool_input":{"command":"ls -al"}}'), 'ls -al');
});

test('JSON 이 아니면 원문 전체를 훑는다 — 파싱 실패로 구멍을 만들지 않는다', () => {
  assert.equal(extractCommand('wipe-all'), 'wipe-all');
});
