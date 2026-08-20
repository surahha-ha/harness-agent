/**
 * v1 지표 집계의 테스트.
 *
 * 여기서 지키는 계약: **프로브는 지표에서 제외**된다, **승인은 근사임이 드러난다**
 * (같은 접두사의 after 만 짝이 되고, 한 after 를 두 번 쓰지 않는다),
 * **미수집은 0 으로 둔갑하지 않는다.**
 *
 * 실행: node --test skeletons/metrics.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, render, KNOWN_LABELS } from './metrics.mjs';

const t = (m) => `2026-08-18T06:${String(m).padStart(2, '0')}:00Z`;
const fire = (m, decision, cmdPrefix, probe = false) => ({
  ts: t(m), event: 'fire', gate: 'danger-guard', rule: 'r', decision, probe, cmdPrefix,
});
const after = (m, cmdPrefix) => ({
  ts: t(m), event: 'after', gate: 'danger-guard', rule: 'r', decision: 'ask', probe: false, cmdPrefix,
});
const pass = (m) => ({ ts: t(m), event: 'pass', gate: 'danger-guard', cmdPrefix: 'git status' });

test('ask 발동 뒤 같은 접두사의 after = 승인(근사)', () => {
  const s = summarize([fire(1, 'ask', 'git push'), after(2, 'git push')]);
  assert.equal(s.intervention.asks, 1);
  assert.equal(s.intervention.approved, 1);
  assert.equal(s.intervention.unresolved, 0);
});

test('after 가 없으면 "거부/이탈(구분 불가)" — 거부로 단정하지 않는다', () => {
  const s = summarize([fire(1, 'ask', 'git push')]);
  assert.equal(s.intervention.approved, 0);
  assert.equal(s.intervention.unresolved, 1);
  assert.match(render(s), /구분 불가/);
});

test('⭐ after 하나가 ask 두 건의 승인이 되지 않는다', () => {
  const s = summarize([fire(1, 'ask', 'git push'), fire(2, 'ask', 'git push'), after(3, 'git push')]);
  assert.equal(s.intervention.approved, 1);
  assert.equal(s.intervention.unresolved, 1);
});

test('접두사가 다르면 짝이 아니다 — 시간만으로 승인 처리하지 않는다', () => {
  const s = summarize([fire(1, 'ask', 'git push'), after(2, 'docker rm')]);
  assert.equal(s.intervention.approved, 0);
});

test('fire 보다 앞선 after 는 짝이 아니다', () => {
  const s = summarize([after(1, 'git push'), fire(2, 'ask', 'git push')]);
  assert.equal(s.intervention.approved, 0);
});

test('⭐ 프로브 발동은 모든 지표에서 제외되고, 제외 수는 보인다', () => {
  const s = summarize([fire(1, 'deny', 'echo probe', true), pass(2)]);
  assert.equal(s.gate.fires, 0);
  assert.equal(s.gate.denominator, 1); // pass 만
  assert.equal(s.probesExcluded, 1);
  assert.match(render(s), /프로브 1건.*제외/);
});

test('분모 = pass + fire — 발동만 세면 비율이 없다 (§227.50 교훈)', () => {
  const s = summarize([pass(1), pass(2), fire(3, 'deny', 'wipe-all')]);
  assert.equal(s.gate.denominator, 3);
  assert.equal(s.gate.fires, 1);
});

test('오탐률 = false-positive 라벨 / 발동', () => {
  const s = summarize([
    fire(1, 'deny', 'wipe-all'),
    fire(2, 'deny', 'wipe-all'),
    { ts: t(3), event: 'note', label: 'false-positive', text: '규칙이 과잉이었다' },
  ]);
  assert.equal(s.gate.falsePositives, 1);
  assert.match(render(s), /오탐률 1\/2/);
});

test('개입 간 시간 — 발동 2건 이상일 때만 중앙값이 나온다', () => {
  assert.equal(summarize([fire(1, 'deny', 'a')]).gap.medianMinutes, null);
  const s = summarize([fire(1, 'deny', 'a'), fire(5, 'deny', 'a'), fire(7, 'deny', 'a')]);
  assert.equal(s.gap.medianMinutes, 3); // 간격 4분·2분 → 중앙값 3분
});

test('완주율 — test-first audit 시계열의 처음과 끝', () => {
  const s = summarize([
    { ts: t(1), event: 'audit', gate: 'test-first', total: 311, inScope: 39, missing: 29, deny: 7, ask: 22 },
    { ts: t(2), event: 'audit', gate: 'test-first', total: 311, inScope: 39, missing: 0, deny: 0, ask: 0 },
  ]);
  assert.equal(s.completion.audits, 2);
  assert.equal(s.completion.first.missing, 29);
  assert.equal(s.completion.last.missing, 0);
  assert.match(render(s), /29 → 0 \(닫힘\)/);
});

test('⭐ 경계표 없는 audit(inScope 0)은 완주율 시계열에서 빠진다 — "잰 것 없음" ≠ "다 닫힘"', () => {
  const s = summarize([
    { ts: t(1), event: 'audit', gate: 'test-first', total: 446, inScope: 0, missing: 0, deny: 0, ask: 0 },
    { ts: t(2), event: 'audit', gate: 'test-first', total: 446, inScope: 0, missing: 0, deny: 0, ask: 0 },
  ]);
  assert.equal(s.completion.audits, 0);
  assert.equal(s.completion.emptyAudits, 2);
  const out = render(s);
  assert.match(out, /1 완주율\s+미수집/);
  assert.match(out, /경계표 없는 audit 2회 제외/);
});

test('경계표 있는 audit 과 없는 audit 이 섞이면 있는 것만 센다', () => {
  const s = summarize([
    { ts: t(1), event: 'audit', gate: 'test-first', total: 400, inScope: 0, missing: 0, deny: 0, ask: 0 },
    { ts: t(2), event: 'audit', gate: 'test-first', total: 400, inScope: 30, missing: 5, deny: 2, ask: 3 },
    { ts: t(3), event: 'audit', gate: 'test-first', total: 400, inScope: 30, missing: 0, deny: 0, ask: 0 },
  ]);
  assert.equal(s.completion.audits, 2);
  assert.equal(s.completion.first.missing, 5);
  assert.match(render(s), /5 → 0 \(닫힘\) \(경계표 없는 audit 1회 제외\)/);
});

test('⭐ 미수집은 "미수집" 으로 표기된다 — 0 으로 둔갑하지 않는다', () => {
  const out = render(summarize([pass(1)]));
  assert.match(out, /1 완주율\s+미수집/);
  assert.match(out, /2 개입 분해\s+미수집/);
  assert.match(out, /3 개입 간 시간\s+미수집/);
  assert.match(out, /5 비용\/작업\s+미수집/);
});

test('이벤트 0건에서도 render 가 죽지 않고 전부 미수집이다', () => {
  const out = render(summarize([]));
  assert.match(out, /4 게이트 발동\s+미수집/);
});

test('부트스트랩 시간은 시계열로 나열된다', () => {
  const s = summarize([
    { ts: t(1), event: 'note', label: 'bootstrap-minutes', value: 7 },
    { ts: t(2), event: 'note', label: 'bootstrap-minutes', value: 11 },
  ]);
  assert.deepEqual(s.cost.bootstrapMinutes, [7, 11]);
  assert.match(render(s), /7·11분 \(2점\)/);
});

test('drift-watch audit 은 부가 정보로 보인다', () => {
  const s = summarize([
    { ts: t(1), event: 'audit', gate: 'drift-watch', mirrors: 6, fresh: 1, suppressed: 0, absent: 2 },
  ]);
  assert.equal(s.driftAudits.count, 1);
  assert.match(render(s), /drift-watch 검사 1회 · 최근 새 차이 1/);
});

test('알려진 라벨 어휘가 문서와 어긋나지 않는다', () => {
  // v1 3종(docs/13 §2) + v2 확장 3종(docs/15 §6 — 사고·승격·강등). 확장은 additive 다.
  assert.deepEqual(KNOWN_LABELS, [
    'false-positive',
    'false-green',
    'bootstrap-minutes',
    'incident',
    'promoted',
    'demoted',
  ]);
});
