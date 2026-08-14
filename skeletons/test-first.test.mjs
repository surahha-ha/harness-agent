/**
 * 골격 2 가드의 테스트.
 *
 * 여기서 보는 것도 **판정 구조**다 — 경계표 내용은 프로젝트 설정에서 오므로 합성 설정으로 한다.
 * 파일시스템은 io 로 주입해 실제 디스크 없이 판정 경로 전부를 돈다.
 *
 * 실행: node --test skeletons/test-first.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, findTest, evaluate, audit, statusOf, extractFilePath } from './test-first.mjs';

/** 합성 설정 — 실제 프로젝트 경계표가 아니라 구조를 보기 위한 최소값. */
const cfg = {
  testFirst: {
    enabled: true,
    grandfather: true,
    scopes: [
      { decision: 'deny', pattern: /^src\/engine\/.*\.ts$/, what: '순수 계산' },
      { decision: 'ask', pattern: /^src\/utils\/.*\.ts$/, what: '계산·래퍼 혼재' },
    ],
    exempt: [/(^|\/)__tests__\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /\.(md|json)$/],
    testLookup: {
      dirs: ['__tests__', '.'],
      pattern: '^{base}[\\w.\\-]*\\.(test|spec)\\.[cm]?[jt]sx?$',
    },
    offEnv: 'HARNESS_TEST_FIRST',
  },
};

/** 합성 파일시스템 — files: 존재하는 파일 경로 집합, dirs: 디렉토리 → 파일명 목록. */
function fakeIo({ files = [], dirs = {} } = {}) {
  return {
    fileExists: (rel) => files.includes(rel.replace(/\\/g, '/')),
    listDir: (dir) => dirs[dir.replace(/\\/g, '/')] ?? null,
  };
}

// ── classify ────────────────────────────────────────────────────────────────

test('경계 안 파일을 경계표의 판정으로 분류한다', () => {
  assert.equal(classify('src/engine/calc.ts', cfg.testFirst).decision, 'deny');
  assert.equal(classify('src/utils/fmt.ts', cfg.testFirst).decision, 'ask');
});

test('경계 밖 파일은 null — 판정 대상이 아니다', () => {
  assert.equal(classify('src/views/Page.vue', cfg.testFirst), null);
});

test('⭐ 테스트 파일 자신은 항상 exempt — Red 를 못 쓰면 가드가 자기모순이다', () => {
  assert.equal(classify('src/engine/calc.test.ts', cfg.testFirst), 'exempt');
  assert.equal(classify('src/engine/__tests__/calc.spec.ts', cfg.testFirst), 'exempt');
});

test('역슬래시 경로도 같은 판정을 받는다 — OS 표기 차이로 규칙이 새면 안 된다', () => {
  assert.equal(classify('src\\engine\\calc.ts', cfg.testFirst).decision, 'deny');
});

test('deny 와 ask 에 모두 걸리면 deny 가 이긴다', () => {
  const tf = {
    scopes: [
      { decision: 'ask', pattern: /^src\// },
      { decision: 'deny', pattern: /^src\/engine\// },
    ],
  };
  assert.equal(classify('src/engine/a.ts', tf).decision, 'deny');
});

// ── findTest ────────────────────────────────────────────────────────────────

test('탐색 규칙의 디렉토리 순서대로 대응 테스트를 찾는다', () => {
  const io = fakeIo({ dirs: { 'src/engine/__tests__': ['calc.test.ts'] } });
  assert.equal(findTest('src/engine/calc.ts', cfg.testFirst, io).found, 'src/engine/__tests__/calc.test.ts');
});

test('같은 디렉토리의 테스트도 찾는다 ({base} 치환)', () => {
  const io = fakeIo({ dirs: { 'src/engine': ['calc.ts', 'calc.spec.ts'] } });
  assert.equal(findTest('src/engine/calc.ts', cfg.testFirst, io).found, 'src/engine/calc.spec.ts');
});

test('파일명에 정규식 특수문자가 있어도 오판정하지 않는다 — {base} 는 이스케이프된다', () => {
  // 'calc.util' 의 '.' 이 와일드카드로 풀리면 'calcXutil.test.ts' 같은 무관한 파일이 걸린다.
  const io = fakeIo({ dirs: { src: ['calcXutil.test.ts'] } });
  assert.equal(findTest('src/calc.util.ts', { testLookup: cfg.testFirst.testLookup }, io).found, null);
});

test('탐색 디렉토리가 없으면 오류가 아니라 "없음" 이다 — 배치 전제를 강요하지 않는다', () => {
  assert.equal(findTest('src/engine/calc.ts', cfg.testFirst, fakeIo()).found, null);
});

// ── evaluate ────────────────────────────────────────────────────────────────

test('신규 파일이 deny 경계 안이고 테스트가 없으면 deny', () => {
  const hit = evaluate('src/engine/calc.ts', cfg, fakeIo());
  assert.equal(hit.decision, 'deny');
  assert.match(hit.recover, /Red 를 먼저/);
});

test('⭐ 복구 경로가 경계표 위치를 알려준다 — 표를 고칠 수 있어야 가드가 안 꺼진다', () => {
  const hit = evaluate('src/engine/calc.ts', cfg, fakeIo());
  assert.match(hit.recover, /testFirst\.scopes/);
});

test('대응 테스트가 있으면 통과한다', () => {
  const io = fakeIo({ dirs: { 'src/engine/__tests__': ['calc.test.ts'] } });
  assert.equal(evaluate('src/engine/calc.ts', cfg, io), null);
});

test('⭐ 유예(grandfather) — 이미 있던 파일은 테스트가 없어도 통과한다', () => {
  const io = fakeIo({ files: ['src/engine/calc.ts'] });
  assert.equal(evaluate('src/engine/calc.ts', cfg, io), null);
});

test('grandfather:false 면 기존 파일도 판정한다', () => {
  const c = { testFirst: { ...cfg.testFirst, grandfather: false } };
  const io = fakeIo({ files: ['src/engine/calc.ts'] });
  assert.equal(evaluate('src/engine/calc.ts', c, io).decision, 'deny');
});

test('ask 경계는 ask 로 판정한다', () => {
  assert.equal(evaluate('src/utils/fmt.ts', cfg, fakeIo()).decision, 'ask');
});

test('경계 밖·면제 파일은 판정하지 않는다', () => {
  assert.equal(evaluate('src/views/Page.vue', cfg, fakeIo()), null);
  assert.equal(evaluate('src/engine/calc.test.ts', cfg, fakeIo()), null);
});

test('enabled 가 true 가 아니면 아무것도 판정하지 않는다 — 기본값은 꺼짐이다', () => {
  const c = { testFirst: { ...cfg.testFirst, enabled: false } };
  assert.equal(evaluate('src/engine/calc.ts', c, fakeIo()), null);
  assert.equal(evaluate('src/engine/calc.ts', {}, fakeIo()), null);
});

test('탐색 규칙이 깨지면 조용히 deny 하지 않는다 — 판정 불가는 통과시키되 보이게 남긴다', () => {
  const c = {
    testFirst: { ...cfg.testFirst, testLookup: { dirs: ['.'], pattern: '^{base}[' } },
  };
  assert.equal(evaluate('src/engine/calc.ts', c, fakeIo()), null);
});

// ── audit ───────────────────────────────────────────────────────────────────

test('--audit 은 경계 안인데 테스트 없는 파일을 센다', () => {
  const files = [
    'src/engine/calc.ts', // deny · 테스트 없음
    'src/engine/rate.ts', // deny · 테스트 있음
    'src/utils/fmt.ts', // ask · 테스트 없음
    'src/views/Page.vue', // 경계 밖
    'src/engine/calc.test.ts', // 면제
  ];
  const io = fakeIo({ dirs: { 'src/engine/__tests__': ['rate.test.ts'] } });
  const a = audit(files, cfg, io);
  assert.equal(a.total, 5);
  assert.equal(a.inScope, 3);
  assert.deepEqual(
    a.missing.map((m) => m.path),
    ['src/engine/calc.ts', 'src/utils/fmt.ts'],
  );
});

test('⭐ --audit 은 enabled:false 여도 센다 — 켜기 전에 세는 것이 목적이다', () => {
  const c = { testFirst: { ...cfg.testFirst, enabled: false } };
  const a = audit(['src/engine/calc.ts'], c, fakeIo());
  assert.equal(a.missing.length, 1);
});

test('⭐ --audit 은 유예를 무시한다 — 기존 위반 수가 곧 유예의 근거다', () => {
  const io = fakeIo({ files: ['src/engine/calc.ts'] });
  const a = audit(['src/engine/calc.ts'], cfg, io);
  assert.equal(a.missing.length, 1);
});

// ── statusOf ────────────────────────────────────────────────────────────────

test('⭐ 경계가 0개면 active 가 아니라 empty 다 — 거짓 활성은 미설치보다 나쁘다', () => {
  assert.equal(statusOf({ testFirst: { enabled: true, scopes: [] } }).state, 'empty');
});

test('enabled:false 는 off — 기본 상태다', () => {
  assert.equal(statusOf(cfg && { testFirst: { ...cfg.testFirst, enabled: false } }).state, 'off');
  assert.equal(statusOf(undefined).state, 'off');
});

test('⭐ 탈출구 환경변수가 설정돼 있으면 escaped — 켜 두고 잊은 상태를 보이게 한다', () => {
  const s = statusOf(cfg, { HARNESS_TEST_FIRST: '1' });
  assert.equal(s.state, 'escaped');
  assert.equal(s.offEnv, 'HARNESS_TEST_FIRST');
});

test('경계가 있고 탈출구가 비어 있으면 active — deny/ask 수를 보고한다', () => {
  const s = statusOf(cfg, {});
  assert.equal(s.state, 'active');
  assert.equal(s.deny, 1);
  assert.equal(s.ask, 1);
});

// ── extractFilePath ─────────────────────────────────────────────────────────

test('훅 입력 JSON 에서 대상 파일 경로를 꺼낸다', () => {
  assert.equal(extractFilePath('{"tool_input":{"file_path":"src/a.ts"}}'), 'src/a.ts');
});

test('경로가 없거나 JSON 이 아니면 null — 임의 텍스트에서 경로를 추정하지 않는다', () => {
  assert.equal(extractFilePath('{"tool_input":{"command":"ls"}}'), null);
  assert.equal(extractFilePath('그냥 텍스트'), null);
});
