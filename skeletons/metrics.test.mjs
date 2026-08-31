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

test('⭐ F26 — 접힌 접두사끼리는 짝이 아니다 (서로 다른 명령이 뭉친 자리라 승인으로 셀 수 없다)', () => {
  const s = summarize([fire(1, 'ask', '(unparsed)'), after(2, '(unparsed)')]);
  assert.equal(s.intervention.approved, 0, '문자열이 같아도 열쇠가 아니다');
  assert.equal(s.intervention.asks, 1, '분모(ask 발동)는 그대로 센다');
});

test('⭐ 빈 접두사도 짝이 아니다 — 빈 값끼리 맞아떨어져 승인이 되면 안 된다', () => {
  const s = summarize([fire(1, 'ask', ''), after(2, '')]);
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
  // v1 3종(docs/13 §2) + v2 확장 3종(docs/15 §6 — 사고·승격·강등) + 판정 마커 1종(docs/13 §6 절차 1,
  // v1 판정 절에서 임시 사용 후 등재). 확장은 전부 additive 다.
  assert.deepEqual(KNOWN_LABELS, [
    'false-positive',
    'false-green',
    'bootstrap-minutes',
    'incident',
    'promoted',
    'demoted',
    'fp-reviewed',
    'recurrence',
    'caught-defect',
  ]);
});

// ── 오탐 판정 경계(fp-reviewed) — "라벨 0" 은 "오탐 없음" 이 아니다 ──────────────────

const review = (m, rule) => ({ ts: t(m), event: 'note', label: 'fp-reviewed', rule });

test('⭐ 판정 마커가 없으면 발동은 전부 미판정 — 오탐 라벨 0 이 오탐 없음으로 둔갑하지 않는다', () => {
  const s = summarize([fire(1, 'deny', 'x'), fire(2, 'deny', 'x'), pass(3)]);
  assert.equal(s.gate.falsePositives, 0);
  assert.equal(s.gate.reviewed, 0);
  assert.equal(s.gate.unreviewed, 2);
  assert.match(render(s), /오탐 판정 0\/2 \(미판정 2 — 라벨 0 ≠ 오탐 없음/);
});

test('fp-reviewed 의 ts 가 경계다 — 이전 발동은 판정 완료, 이후 발동은 미판정', () => {
  const s = summarize([fire(1, 'deny', 'x'), fire(2, 'deny', 'x'), review(3), fire(4, 'deny', 'x')]);
  assert.equal(s.gate.reviewed, 2);
  assert.equal(s.gate.unreviewed, 1);
  assert.match(render(s), /오탐 판정 2\/3 \(미판정 1/);
});

test('전부 판정되면 "완료" 로 표기된다 — 오탐률 표기는 그대로 남는다', () => {
  const s = summarize([
    fire(1, 'deny', 'x'),
    { ts: t(2), event: 'note', label: 'false-positive', rule: 'r' },
    review(3),
  ]);
  assert.equal(s.gate.falsePositives, 1);
  assert.match(render(s), /오탐률 1\/1 · 오탐 판정 1\/1 완료/);
});

test('rule 이 있는 fp-reviewed 는 그 규칙의 발동만 덮는다', () => {
  const other = { ...fire(1, 'deny', 'y'), rule: 'other' };
  const s = summarize([other, fire(2, 'deny', 'x'), review(3, 'r')]);
  assert.equal(s.gate.reviewed, 1);
  assert.equal(s.gate.unreviewed, 1);
});

test('프로브 발동은 판정 대상에도 들지 않는다', () => {
  const s = summarize([fire(1, 'deny', 'x', true), fire(2, 'deny', 'x'), review(3)]);
  assert.equal(s.gate.reviewed, 1);
  assert.equal(s.gate.unreviewed, 0);
});

test('발동 0 이면 판정 표기 자체가 없다 — 없는 것을 완료로 적지 않는다', () => {
  const s = summarize([pass(1), review(2)]);
  assert.equal(s.gate.reviewed, 0);
  assert.doesNotMatch(render(s), /오탐 판정/);
});

// ── 판정 층 보조 표기 (recurrence · caught-defect) — F24·F25 ────────────────────────

const label = (m, name, rule) => ({ ts: t(m), event: 'note', label: name, rule });

test('⭐ 판정 층 라벨이 하나도 없으면 보조 줄을 내지 않는다 — 0 은 "안 셌다" 이지 "없다" 가 아니다', () => {
  const s = summarize([fire(1, 'deny', 'x'), review(2)]);
  assert.equal(s.gate.recurrences, 0);
  assert.equal(s.gate.caughtDefects, 0);
  assert.doesNotMatch(render(s), /판정 층/);
});

test('재발·결함 적발은 건수로 세어 보조 줄에 나온다', () => {
  const s = summarize([
    fire(1, 'deny', 'x'),
    fire(2, 'deny', 'x'),
    label(3, 'recurrence', 'r'),
    label(4, 'caught-defect', 'r'),
    review(5),
  ]);
  assert.equal(s.gate.recurrences, 1);
  assert.equal(s.gate.caughtDefects, 1);
  assert.match(render(s), /판정 층 — 같은 원인 재발 1건 · 차단이 결함을 드러냄 1건/);
});

test('⭐ 보조 표기는 비율이 되지 않는다 — 분모가 판정 범위에 따라 흔들리기 때문', () => {
  const s = summarize([fire(1, 'deny', 'x'), label(2, 'recurrence', 'r'), review(3)]);
  const out = render(s);
  assert.match(out, /비율 아님/);
  assert.doesNotMatch(out, /재발 1\/\d/, '재발을 분수로 찍지 않는다');
});

test('⭐ 두 라벨은 오탐률 정의를 건드리지 않는다 — additive', () => {
  const base = summarize([fire(1, 'deny', 'x'), review(2)]);
  const withLabels = summarize([
    fire(1, 'deny', 'x'),
    label(2, 'recurrence', 'r'),
    label(3, 'caught-defect', 'r'),
    review(4),
  ]);
  assert.equal(withLabels.gate.falsePositives, base.gate.falsePositives);
  assert.equal(withLabels.gate.fires, base.gate.fires);
  assert.equal(withLabels.gate.reviewed, base.gate.reviewed);
});
