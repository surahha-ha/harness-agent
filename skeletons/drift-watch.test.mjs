/**
 * 골격 4 감시의 테스트.
 *
 * 여기서 보는 것도 **판정 구조**다 — 미러 목록은 프로젝트 설정에서 오므로 합성 미러로 한다.
 * 파일시스템은 io 로 주입해 실제 디스크 없이 비교 경로 전부를 돈다.
 *
 * 실행: node --test skeletons/drift-watch.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEol, checkMirror, filterApproved, statusOf } from './drift-watch.mjs';

/**
 * 합성 파일시스템.
 * @param {Record<string,string>} files 경로 → 내용 (디렉토리는 경로 접두로 유추)
 * @param {Record<string,string>} mtimes 경로 → 수정 시점 표기
 */
function fakeIo(files = {}, mtimes = {}) {
  const keys = Object.keys(files);
  return {
    kind: (p) => {
      if (p in files) return 'file';
      if (keys.some((k) => k.startsWith(p + '/'))) return 'dir';
      return null;
    },
    read: (p) => files[p],
    mtime: (p) => mtimes[p] ?? null,
    listFiles: (dir) => keys.filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1)),
  };
}

// ── checkMirror: 파일 쌍 ─────────────────────────────────────────────────────

test('파일 쌍의 내용이 같으면 발견 없음', () => {
  const io = fakeIo({ 'a.md': 'x', 'b.md': 'x' });
  assert.deepEqual(checkMirror({ a: 'a.md', b: 'b.md' }, io).findings, []);
});

test('파일 쌍의 내용이 다르면 양쪽 경로와 수정 시점을 함께 준다 — 어느 쪽을 고칠지 판단할 정보', () => {
  const io = fakeIo({ 'a.md': 'x', 'b.md': 'y' }, { 'a.md': '2026-08-01', 'b.md': '2026-08-10' });
  const [f] = checkMirror({ a: 'a.md', b: 'b.md' }, io).findings;
  assert.equal(f.kind, 'content');
  assert.equal(f.aMtime, '2026-08-01');
  assert.equal(f.bMtime, '2026-08-10');
});

test('⭐ 개행 차이는 드리프트가 아니다 — CRLF/LF 정규화 후 비교한다', () => {
  const io = fakeIo({ 'a.md': 'x\r\ny\r\n', 'b.md': 'x\ny\n' });
  assert.deepEqual(checkMirror({ a: 'a.md', b: 'b.md' }, io).findings, []);
  assert.equal(normalizeEol('a\r\nb\rc'), 'a\nb\nc');
});

test('existence 비교는 내용이 달라도 잡지 않는다 — 표기가 달라질 수밖에 없는 자산용', () => {
  const io = fakeIo({ 'a.md': 'x', 'b.md': 'y' });
  assert.deepEqual(checkMirror({ a: 'a.md', b: 'b.md', compare: 'existence' }, io).findings, []);
});

// ── checkMirror: 디렉토리 쌍 ─────────────────────────────────────────────────

test('⭐ 양방향 — 한쪽에만 있는 파일을 어느 방향이든 잡는다 (원본이 낡은 역방향 포함)', () => {
  const io = fakeIo({ 'A/one.mjs': 'x', 'B/one.mjs': 'x', 'B/two.mjs': 'y' });
  const r = checkMirror({ a: 'A', b: 'B' }, io);
  assert.deepEqual(
    r.findings.map((f) => [f.kind, f.path]),
    [['only-b', 'two.mjs']],
  );
});

test('디렉토리 쌍에서 내용 차이도 상대 경로로 잡는다', () => {
  const io = fakeIo({ 'A/g/x.mjs': '1', 'B/g/x.mjs': '2' });
  const [f] = checkMirror({ a: 'A', b: 'B' }, io).findings;
  assert.equal(f.kind, 'content');
  assert.equal(f.path, 'g/x.mjs');
  assert.equal(f.a, 'A/g/x.mjs');
});

test('existence 비교의 디렉토리 쌍은 존재 차이만 잡는다', () => {
  const io = fakeIo({ 'A/x.mjs': '1', 'B/x.mjs': '2', 'A/y.mjs': '3' });
  const r = checkMirror({ a: 'A', b: 'B', compare: 'existence' }, io);
  assert.deepEqual(
    r.findings.map((f) => [f.kind, f.path]),
    [['only-a', 'y.mjs']],
  );
});

test('⭐ 상대가 아예 없으면 조용히 no-op — 감시 도구가 배치 전제를 강요하면 안 된다', () => {
  const io = fakeIo({ 'A/x.mjs': '1' });
  const r = checkMirror({ a: 'A', b: '../peer/.harness' }, io);
  assert.equal(r.state, 'absent');
  assert.deepEqual(r.findings, []);
});

test('한쪽은 파일, 한쪽은 디렉토리면 종류 불일치로 잡는다', () => {
  const io = fakeIo({ 'a.md': 'x', 'B/x.mjs': '1' });
  assert.equal(checkMirror({ a: 'a.md', b: 'B' }, io).findings[0].kind, 'type');
});

// ── filterApproved ──────────────────────────────────────────────────────────

const findings = [
  { kind: 'content', path: 'g/x.mjs', a: 'A/g/x.mjs', b: 'B/g/x.mjs', aMtime: null, bMtime: null },
  { kind: 'only-a', path: 'y.mjs', a: 'A/y.mjs', b: 'B/y.mjs', aMtime: null, bMtime: null },
];

test('⭐ 승인된 차이는 조용히 두고, 목록에 없는 차이만 알린다 — 경고 피로는 감시 도구의 사인이다', () => {
  const r = filterApproved(findings, [{ path: 'g/x.mjs', why: '실행 위치에 따라 표기가 다르다' }]);
  assert.deepEqual(
    r.fresh.map((f) => f.path),
    ['y.mjs'],
  );
  assert.equal(r.suppressed.length, 1);
});

test('승인 항목은 절대 표기(a/b 쪽 경로)로도 맞출 수 있다', () => {
  const r = filterApproved(findings, [{ path: 'A/y.mjs', why: '의도된 비대칭' }]);
  assert.deepEqual(
    r.fresh.map((f) => f.path),
    ['g/x.mjs'],
  );
});

test('승인 목록이 비면 전부 새 차이다', () => {
  assert.equal(filterApproved(findings, []).fresh.length, 2);
  assert.equal(filterApproved(findings).fresh.length, 2);
});

// ── statusOf ────────────────────────────────────────────────────────────────

test('⭐ 미러가 0개면 active 가 아니라 empty 다 — 거짓 활성은 미설치보다 나쁘다', () => {
  assert.equal(statusOf({ drift: { mirrors: [] } }).state, 'empty');
  assert.equal(statusOf(undefined).state, 'empty');
});

test('a·b 가 모두 있는 미러만 센다 — 반쪽 선언은 감시가 아니다', () => {
  const s = statusOf({ drift: { mirrors: [{ a: 'A', b: 'B' }, { a: 'A' }], approvedDifferences: [{ path: 'p' }] } });
  assert.equal(s.state, 'active');
  assert.equal(s.mirrors, 1);
  assert.equal(s.approved, 1);
});
