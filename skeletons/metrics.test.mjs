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
import {
  summarize,
  render,
  parseWindow,
  KNOWN_LABELS,
  auditContract,
  renderContract,
  renderContractLine,
} from './metrics.mjs';

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

// ── 정확 짝짓기 (call) 와 턴 단위 (docs/16) ──────────────────────────────────────

test('⭐ call 이 있으면 같은 도구 호출로만 짝짓는다 — 접두사가 같아도 다른 호출은 짝이 아니다', () => {
  const s = summarize([
    { ...fire(1, 'ask', 'git push'), call: 'c1' },
    { ...after(2, 'git push'), call: 'c2' }, // 다른 호출
  ]);
  assert.equal(s.intervention.approved, 0);
  const t = summarize([{ ...fire(1, 'ask', 'git push'), call: 'c1' }, { ...after(2, 'git push'), call: 'c1' }]);
  assert.equal(t.intervention.approvedExact, 1);
  assert.equal(t.intervention.approvedApprox, 0);
  assert.match(render(t), /승인 1 \(정확 1 · 근사 0\)/);
});

test('⭐ call 이 있는 ask 는 근사로 떨어지지 않는다 — 옛 after 를 접두사로 집으면 남의 승인이다', () => {
  const s = summarize([{ ...fire(1, 'ask', 'git push'), call: 'c1' }, after(2, 'git push')]);
  assert.equal(s.intervention.approved, 0);
});

test('call 이 없는 옛 로그는 종전 근사 그대로 — 두 수는 따로 보인다(혼합 금지)', () => {
  const s = summarize([
    fire(1, 'ask', 'git push'),
    after(2, 'git push'),
    { ...fire(3, 'ask', 'docker rm'), call: 'c9' },
    { ...after(4, 'docker rm'), call: 'c9' },
  ]);
  assert.equal(s.intervention.approvedApprox, 1);
  assert.equal(s.intervention.approvedExact, 1);
  assert.equal(s.intervention.approved, 2);
});

test('⭐ v2 턴 — 분모는 게이트가 본 턴, 분자 후보는 발동 없는 턴', () => {
  const s = summarize([
    { ...pass(1), turn: 't1' },
    { ...pass(2), turn: 't1' },
    { ...fire(3, 'deny', 'x'), turn: 't2' },
    { ...pass(4), turn: 't3' },
  ]);
  assert.deepEqual(s.turns, { gated: 3, fired: 1, quiet: 2, eventsWithoutTurn: 0, outsideWindow: 0 });
  assert.equal(s.window, null, '창을 안 주면 창 표기가 없다 — 누적이 기본');
  assert.match(render(s), /게이트가 본 턴 3 · 발동 있는 턴 1 → 무발동 턴 2\/3 \(게이트 축만/);
});

test('⭐ turn 없는 이벤트는 분모에 안 들어가고 제외 수가 보인다 — 옛 로그가 0 으로 둔갑하지 않는다', () => {
  const s = summarize([pass(1), pass(2), { ...pass(3), turn: 't1' }]);
  assert.equal(s.turns.gated, 1);
  assert.equal(s.turns.eventsWithoutTurn, 2);
  assert.match(render(s), /turn 없는 이벤트 2 제외/);
  const none = render(summarize([pass(1)]));
  assert.match(none, /v2 턴\(게이트 축\)\s+미수집/);
});

test('프로브 발동은 턴 지표에서도 제외된다', () => {
  const s = summarize([{ ...fire(1, 'deny', 'echo probe', true), turn: 't1' }, { ...pass(2), turn: 't1' }]);
  assert.equal(s.turns.fired, 0);
  assert.equal(s.turns.gated, 1);
});

test('⭐ 계약 검사 — session·turn·call 은 식별자라 원문 흔적(UUID)으로 잡히지 않는다', () => {
  const a = auditContract([
    { ...pass(1), session: '550e8400-e29b-41d4-a716-446655440000', turn: '550e8400-e29b-41d4-a716-446655440001', call: 'toolu_01ABC' },
  ]);
  assert.equal(violationCount(a), 0);
  assert.equal(observationCount(a), 0);
  const bad = auditContract([{ ...pass(2), turn: '' }]);
  assert.ok(bad.violations['turn 빈 값']);
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

// ── 스키마 계약 자가 감사 (docs/13 §3 · F26) ─────────────────────────────────────
// 여기서 지키는 계약: **계약은 데이터에 대고 검사된다** — 테스트가 계약의 절반만 보고 그린이던
// F26 의 재발을 막는다. 그리고 **검사 결과에 값이 실리지 않는다** — 위반 내역이 반출 경로가 되면 안 된다.

const okEvents = () => [
  fire(1, 'deny', 'git push'),
  pass(2),
  { ts: t(3), event: 'after', gate: 'danger-guard', rule: 'r', decision: 'ask', probe: false, cmdPrefix: 'git push' },
  { ts: t(4), event: 'audit', gate: 'test-first', total: 3, inScope: 1, missing: 0 },
  { ts: t(5), event: 'note', label: 'bootstrap-minutes', value: 7, text: 'first' },
];
const violationCount = (a) => Object.values(a.violations).reduce((n, b) => n + b.count, 0);
const observationCount = (a) => Object.values(a.observations).reduce((n, b) => n + b.count, 0);

test('계약대로 쓰인 5종 이벤트는 위반도 관찰도 0 — 검사 수는 이벤트 수와 같다', () => {
  const a = auditContract(okEvents(), { user: 'someone' });
  assert.equal(a.checked, 5);
  assert.equal(violationCount(a), 0);
  assert.equal(observationCount(a), 0);
  assert.equal(a.folded, 0);
});

test('⭐ F26 형 — 첫 토큰에 절대경로가 실린 접두사는 위반이다 (정규화의 고정점이 아니다)', () => {
  const bad = { ts: t(1), event: 'pass', gate: 'danger-guard', cmdPrefix: 'VAR="/home/someone/x"; git' };
  const a = auditContract([bad], { user: 'someone' });
  assert.ok(a.violations['cmdPrefix 비정규(원문 잔존)'], '정규화하면 (unparsed) 가 될 값이 그대로 있다');
  assert.ok(a.violations['원문 흔적(절대경로)'], '절대경로 흔적');
  assert.ok(a.violations['원문 흔적(OS 사용자명)'], '사용자명 흔적');
  assert.deepEqual(a.violations['원문 흔적(절대경로)'].where, ['pass.cmdPrefix']);
});

test('접힌 접두사 (unparsed) 는 위반이 아니라 접힘 수로만 센다', () => {
  const a = auditContract([fire(1, 'deny', '(unparsed)'), pass(2)]);
  assert.equal(violationCount(a), 0);
  assert.equal(a.folded, 1);
});

test('세 토큰이 남아 있으면 위반 — 정규화는 두 토큰까지만 남긴다', () => {
  const a = auditContract([fire(1, 'deny', 'git push origin')]);
  assert.ok(a.violations['cmdPrefix 비정규(원문 잔존)']);
});

test('사용자명 검사는 인자로 받는다 — 빈 값이면 그 검사만 생략되고 나머지는 그대로', () => {
  const ev = [{ ...pass(1), cmdPrefix: 'someone' }]; // 명령 이름처럼 생겨 정규화는 통과한다
  assert.equal(violationCount(auditContract(ev)), 0);
  assert.ok(auditContract(ev, { user: 'someone' }).violations['원문 흔적(OS 사용자명)']);
});

test('어휘·타입 위반은 각각 이름 붙은 위반으로 잡힌다 (값이 아니라 이벤트·필드명으로)', () => {
  const a = auditContract([
    { ts: t(1), event: 'fired', gate: 'danger-guard' },
    { ...fire(2, 'deny', 'git push'), probe: 'no' },
    { ...fire(3, 'allow', 'git push') },
    { ...pass(4), decision: 'deny' },
    { ...pass(5), rule: 'r' }, // promoted 없이 rule 만
    { ts: t(6), event: 'audit', gate: 'test-first', total: '3' },
    { ts: t(7), event: 'note', label: 'fp-reviewd' },
    { ts: t(8), event: 'note', label: 'bootstrap-minutes', value: '7' },
    { ts: 'yesterday', event: 'pass', gate: 'danger-guard', cmdPrefix: 'git' },
    { ts: t(9), session: '', event: 'pass', gate: 'danger-guard', cmdPrefix: 'git' },
    { ts: t(10), event: 'fire', gate: 'danger-guard' }, // 필수 필드 결손
  ]);
  assert.deepEqual(a.violations['event 어휘 밖'].where, ['fired']);
  assert.equal(a.violations['probe 비불리언'].count, 1);
  assert.equal(a.violations['decision 어휘 밖'].count, 1);
  assert.equal(a.violations['pass 에 판정 필드'].count, 1);
  assert.equal(a.violations['pass 의 promoted↔rule 불일치'].count, 1);
  assert.deepEqual(a.violations['audit 비수치 필드'].where, ['audit.total']);
  assert.deepEqual(a.violations['note.label 어휘 밖'].where, ['fp-reviewd']);
  assert.equal(a.violations['note.value 비수치'].count, 1);
  assert.equal(a.violations['ts 결손·비ISO'].count, 1);
  assert.equal(a.violations['session 빈 값'].count, 1);
  assert.ok(a.violations['필수 필드 결손'].where.includes('fire.cmdPrefix'));
});

test('승격된 pass(rule + promoted:true)는 계약 안이다 — additive 필드', () => {
  const a = auditContract([{ ...pass(1), rule: 'r', promoted: true }]);
  assert.equal(violationCount(a), 0);
  assert.equal(observationCount(a), 0);
});

test('⭐ 관찰은 위반으로 세지 않는다 — 계약 밖 필드·ts 역행·사람 서술의 경로·패턴 원문 rule', () => {
  const a = auditContract(
    [
      { ...pass(2), why: 'x' },
      pass(1), // 역행
      { ts: t(3), event: 'note', label: 'false-positive', text: 'see /home/someone/log' },
      { ...fire(4, 'deny', 'git push'), rule: '^git\\s+push' },
    ],
    { user: 'someone' },
  );
  assert.equal(violationCount(a), 0);
  assert.deepEqual(a.observations['계약 밖 필드'].where, ['pass.why']);
  assert.equal(a.observations['ts 역행(append 순서와 다름)'].count, 1);
  assert.ok(a.observations['note.text 에 절대경로']);
  assert.ok(a.observations['note.text 에 OS 사용자명']);
  assert.equal(a.observations['rule 이 패턴 원문(id 미부여)'].count, 1);
});

test('⭐ 검사 결과 출력에 값이 실리지 않는다 — 위반 내역이 반출 경로가 되면 안 된다', () => {
  const secret = 'VAR="/home/someone/secret-project"; git';
  const a = auditContract([{ ...pass(1), cmdPrefix: secret }], { user: 'someone' });
  const out = [renderContractLine(a), ...renderContract(a)].join('\n');
  assert.doesNotMatch(out, /secret-project/);
  assert.doesNotMatch(out, /someone/);
  assert.match(out, /pass\.cmdPrefix/, '어디서 났는지는 이벤트·필드명으로 말한다');
});

test('요약 한 줄 — 위반 0 은 "검사했더니 0" 으로, 위반이 있으면 --contract 안내로', () => {
  const clean = renderContractLine(auditContract([...okEvents(), fire(6, 'deny', '(unparsed)')]));
  assert.match(clean, /스키마 위반 0 \/ 6 검사 · \(unparsed\) 접힘 1/);
  const dirty = renderContractLine(auditContract([fire(1, 'deny', 'git push origin')]));
  assert.match(dirty, /⚠️ 스키마 계약 위반 1건 \/ 1 검사 — --contract/);
});

// ── v2 ㄴ 축 — 사람 중단 없음 (docs/16 §5 기준 3 · §5.1 실측 3분기) ──────────────────────
// 여기서 지키는 계약: **세션 마지막 턴은 중단이 아니라 미판정**, **첫 stop 이전 턴은 관찰 이전으로 제외**,
// **stop 이 하나도 없으면 축 전체가 미수집** — 어느 것도 0 이나 중단으로 둔갑하지 않는다.

const stop = (m, turn, session = 's1') => ({ ts: t(m), event: 'stop', gate: 'turn-end', session, turn });
const gp = (m, turn, session = 's1') => ({ ...pass(m), turn, session });

test('⭐ 3분기 — Stop 있음 = 정상 종료 · 없는데 뒤 턴 있음 = 중단 · 없고 마지막 = 미판정', () => {
  const s = summarize([
    gp(1, 't1'), stop(2, 't1'), //          정상 종료
    gp(3, 't2'), //                         stop 없음, 뒤에 t3 → 중단
    gp(5, 't3'), stop(6, 't3'), //          정상 종료
    gp(7, 't4'), //                         stop 없음, 세션 마지막 → 미판정
  ]);
  const te = s.turnEnd;
  assert.equal(te.observed, true);
  assert.deepEqual(
    { completed: te.completed, interrupted: te.interrupted, undetermined: te.undetermined, judged: te.judged },
    { completed: 2, interrupted: 1, undetermined: 1, judged: 3 },
  );
  assert.match(render(s), /v2 턴\(중단 축\)\s+판정 3 = 정상 종료 2 · 중단 1 · 미판정 1\(세션 마지막 턴/);
});

test('⭐ 마지막 턴은 세션 단위다 — 다른 세션의 뒤 턴은 이 세션의 턴을 중단으로 만들지 않는다', () => {
  const s = summarize([
    stop(0, 't0'), // 관찰 경계를 열어 둔다
    gp(1, 'a1', 'sA'), //         sA 마지막 턴, stop 없음
    gp(2, 'b1', 'sB'), stop(3, 'b1', 'sB'), // 다른 세션의 뒤 턴
  ]);
  assert.equal(s.turnEnd.interrupted, 0);
  assert.equal(s.turnEnd.undetermined, 1);
});

test('⭐ 첫 stop 이전에 끝난 턴은 "관찰 이전" 으로 제외된다 — 훅 없던 기간을 중단으로 읽으면 창작이다', () => {
  const s = summarize([
    gp(1, 't1'), gp(2, 't2'), // 훅 연결 전 — stop 이 있을 수 없다
    gp(4, 't3'), stop(5, 't3'), // 연결 뒤 첫 stop
    gp(6, 't4'), gp(7, 't5'), stop(8, 't5'),
  ]);
  const te = s.turnEnd;
  assert.equal(te.preHook, 2);
  assert.equal(te.interrupted, 1, 't4 만 중단');
  assert.equal(te.completed, 2);
  assert.match(render(s), /관찰 이전 2 제외\(첫 stop 이전 턴\)/);
});

test('⭐ stop 이 0 이면 중단 축은 미수집 — 게이트 축 줄은 그대로 나온다', () => {
  const s = summarize([gp(1, 't1'), gp(2, 't2')]);
  assert.equal(s.turnEnd.observed, false);
  assert.equal(s.turnEnd.judged, 0);
  const out = render(s);
  assert.match(out, /v2 턴\(중단 축\)\s+미수집 — stop 이벤트가 0/);
  assert.match(out, /v2 턴\(게이트 축\)\s+게이트가 본 턴 2/);
});

test('⭐ 두 축 모두 참인 수는 같은 분모 위에서 나오고 "완주" 라 불리지 않는다 — 검증 그린 축이 없다', () => {
  const s = summarize([
    gp(1, 't1'), stop(2, 't1'), //                         무발동 + 정상 종료 → 두 축 참
    { ...fire(3, 'deny', 'x'), turn: 't2', session: 's1' }, stop(4, 't2'), // 발동 + 정상 종료 → 한 축만
    gp(5, 't3'), gp(6, 't4'), stop(7, 't4'), //             t3 중단 · t4 무발동 + 정상 종료 → 두 축 참
  ]);
  assert.equal(s.turnEnd.bothTrue, 2);
  assert.equal(s.turnEnd.judged, 4);
  const out = render(s);
  assert.match(out, /두 축 모두 참 2\/4 \(완주 아님 — 검증 그린 축 미수집\)/);
});

test('도구를 안 쓴 턴의 stop 은 분모 밖이지만 보인다 — 질문에 답만 한 턴은 게이트가 본 턴이 아니다', () => {
  const s = summarize([gp(1, 't1'), stop(2, 't1'), stop(3, 'chat-only')]);
  assert.equal(s.turnEnd.stopsOutsideGate, 1);
  assert.equal(s.turnEnd.completed, 1);
  assert.match(render(s), /게이트 밖 턴의 stop 1\(분모 밖\)/);
});

test('세션 식별자가 없는 턴은 뒤 턴을 판단할 수 없어 미판정이다 — 중단으로 단정하지 않는다', () => {
  const s = summarize([
    stop(0, 't0'),
    { ...pass(1), turn: 'x1' }, // session 없음
    { ...pass(2), turn: 'x2' },
  ]);
  assert.equal(s.turnEnd.interrupted, 0);
  assert.equal(s.turnEnd.undetermined, 2);
});

test('같은 턴에 stop 이 두 번 와도(stop_hook_active 연쇄) 한 턴으로 센다', () => {
  const s = summarize([gp(1, 't1'), stop(2, 't1'), stop(3, 't1')]);
  assert.equal(s.turnEnd.completed, 1);
  assert.equal(s.turnEnd.judged, 1);
});

test('⭐ 계약 — 제대로 쓰인 stop 은 위반·관찰 0, turn 없는 stop 은 필수 필드 결손, 판정 필드가 실리면 위반', () => {
  const ok = auditContract([stop(1, 't1')]);
  assert.equal(violationCount(ok), 0);
  assert.equal(observationCount(ok), 0);
  const noTurn = auditContract([{ ts: t(1), event: 'stop', gate: 'turn-end', session: 's1' }]);
  assert.ok(noTurn.violations['필수 필드 결손']);
  assert.ok(noTurn.violations['필수 필드 결손'].where.includes('stop.turn'));
  const withDecision = auditContract([{ ...stop(1, 't1'), decision: 'deny', cmdPrefix: 'git push' }]);
  assert.ok(withDecision.violations['stop 에 판정·명령 필드']);
  const extra = auditContract([{ ...stop(1, 't1'), lastMessage: 'hi' }]);
  assert.equal(violationCount(extra), 0);
  assert.ok(extra.observations['계약 밖 필드'].where.includes('stop.lastMessage'));
  // 리포트에서도 turn 없는 stop 은 경고로 보인다 — 연결을 의심하라는 신호
  assert.match(render(summarize([gp(1, 't1'), stop(2, 't1'), { ts: t(3), event: 'stop', gate: 'turn-end' }])), /turn 없는 stop 1\(계약 위반/);
});

// ── v2 ㄷ 축 — 검증 그린의 대체 경로 (docs/16 §5 기준 4 · 결정 이력 2026-09-03(3)) ────────────────
// 여기서 지키는 계약: **그린 = 테스트 없음이 직전 audit 보다 늘지 않음**(미달 0 이 아니다 — 유예된 기존 위반이
// 있는 설치처를 영원히 레드로 만들지 않는다), **첫 audit 은 미판정**, **turn 없는 audit 은 시계열엔 있어도 턴에
// 붙지 않는다**, **완주는 세 축이 모두 판정된 턴에서만** 세고 그 전에는 그 말을 쓰지 않는다.

const au = (m, turn, missing, session = 's1') => ({
  ts: t(m), event: 'audit', gate: 'test-first', total: 10, inScope: 5, missing, deny: 0, ask: missing, ...(turn ? { turn, session } : {}),
});
const turnDone = (m, turn, missing) => [gp(m, turn), stop(m + 1, turn), au(m + 1, turn, missing)];

test('⭐ 그린 = 직전 audit 보다 테스트 없음이 늘지 않음 · 레드 = 늘어남 · 첫 audit = 미판정', () => {
  const s = summarize([
    ...turnDone(1, 't1', 27), // 첫 audit — 비교 대상 없음
    ...turnDone(3, 't2', 27), // 같음 → 그린
    ...turnDone(5, 't3', 28), // 늘어남 → 레드
    ...turnDone(7, 't4', 20), // 줄어듦 → 그린
  ]);
  const v = s.verify;
  assert.equal(v.observed, true);
  assert.deepEqual({ green: v.green, red: v.red, undetermined: v.undetermined, judged: v.judged }, { green: 2, red: 1, undetermined: 1, judged: 3 });
  const out = render(s);
  assert.match(out, /v2 턴\(검증 축\)\s+판정 3 = 그린 2 · 레드 1 · 미판정 1\(첫 audit/);
  assert.match(out, /대체 경로 — 테스트 없음이 직전 audit 보다 늘지 않음 · 테스트 실행의 그린이 아님/);
});

test('⭐ 수동 --audit(turn 없음)도 같은 시계열이다 — 비교 대상이 되지만 어느 턴에도 붙지 않는다', () => {
  const s = summarize([
    au(0, null, 30), // 수동 선실측
    ...turnDone(1, 't1', 27), // 직전(수동 30)보다 줄었다 → 그린 (첫 audit 이 아니다)
    gp(4, 't2'), stop(5, 't2'), // 턴 종료 audit 없음 → 미수집
  ]);
  assert.equal(s.verify.green, 1);
  assert.equal(s.verify.undetermined, 0);
  assert.equal(s.verify.unobserved, 1);
  assert.match(render(s), /미수집 1\(턴 종료 audit 없음\)/);
});

test('⭐ turn 있는 audit 이 0 이면 검증 축은 미수집이고 auditOnStop 안내가 나온다', () => {
  const s = summarize([gp(1, 't1'), stop(2, 't1'), au(3, null, 5)]);
  assert.equal(s.verify.observed, false);
  assert.match(render(s), /v2 턴\(검증 축\)\s+미수집 — turn 있는 audit 이 0 — testFirst\.auditOnStop: true/);
});

test('경계표 없는 audit(inScope 0)은 시계열 밖 — 비교 대상도 턴 판정도 되지 않는다', () => {
  const s = summarize([
    { ...au(0, null, 0), inScope: 0 },
    ...turnDone(1, 't1', 3), // 앞의 것이 시계열 밖이라 이것이 첫 audit → 미판정
  ]);
  assert.equal(s.verify.undetermined, 1);
  assert.equal(s.verify.judged, 0);
});

test('⭐ 완주(세 축) — 세 축 모두 판정된 턴만 분모, 셋 다 참만 분자', () => {
  const s = summarize([
    ...turnDone(1, 't1', 27), //                      검증 미판정(첫 audit) → 분모 밖
    ...turnDone(3, 't2', 27), //                      무발동 ∧ 정상 종료 ∧ 그린 → 완주
    { ...fire(5, 'deny', 'x'), turn: 't3', session: 's1' }, stop(6, 't3'), au(6, 't3', 27), // 발동 → 완주 아님
    gp(7, 't4'), au(7, 't4', 27), //                  stop 없음, 뒤 턴 있음 → 중단, 그린 → 완주 아님
    ...turnDone(9, 't5', 28), //                      레드 → 완주 아님
  ]);
  assert.deepEqual(s.complete, { observed: true, judged: 4, done: 1 });
  assert.match(render(s), /v2 완주\(세 축\)\s+완주 1\/4 — 세 축 모두 판정된 턴 4 기준/);
});

test('⭐ 한 축이라도 미수집이면 완주 줄은 미수집이고 어느 축이 없는지 말한다 — 그 전에는 "완주" 를 세지 않는다', () => {
  const noVerify = render(summarize([gp(1, 't1'), stop(2, 't1')]));
  assert.match(noVerify, /v2 완주\(세 축\)\s+미수집 — 검증 축 미수집/);
  const noStop = render(summarize([gp(1, 't1'), au(2, 't1', 3)]));
  assert.match(noStop, /v2 완주\(세 축\)\s+미수집 — 중단 축 미수집/);
  const neither = render(summarize([gp(1, 't1')]));
  assert.match(neither, /미수집 — 중단 축·검증 축 미수집/);
});

test('세 축이 있어도 한 턴에 같이 잡힌 적이 없으면 완주 0/0 이라고 그대로 말한다', () => {
  const s = summarize([
    gp(1, 't1'), stop(2, 't1'), //          중단 축만
    gp(3, 't2'), au(4, 't2', 3), //         검증 축(첫 audit → 미판정)
    gp(5, 't3'), au(6, 't3', 3), //         세션 마지막 → 중단 미판정
  ]);
  assert.equal(s.complete.observed, true);
  assert.equal(s.complete.judged, 0);
  assert.match(render(s), /완주 0\/0 — .*아직 세 축이 한 턴에 같이 잡힌 적이 없습니다/);
});

test('turn 이 실린 audit 은 계약 안이다 — 식별자는 공통 필드', () => {
  const a = auditContract([au(1, 't1', 3)]);
  assert.equal(violationCount(a), 0);
  assert.equal(observationCount(a), 0);
});

// ── v2 기간 창 — 기준 5(기준선 1점)와 그 뒤의 "상승" 비교 (docs/16 §5 · 결정 이력 2026-09-04) ──────
// 여기서 지키는 계약: **창은 분모(턴)만 자르고 판정 문맥은 전체 로그를 본다** — 이벤트를 자르면 창의 마지막 턴은
// 뒤 턴이 안 보여 미판정, 첫 턴은 직전 audit 을 잃어 미판정이 되어 창 양 끝이 체계적으로 빠진다. **v1 지표는
// 창을 타지 않는다.** **잘못된 창은 던진다** — 창이 안 걸린 누적이 기준선으로 박히는 쪽이 더 나쁘다.

const win = (fromMin, toMin) => ({
  from: fromMin === null ? null : Date.parse(t(fromMin)),
  to: toMin === null ? null : Date.parse(t(toMin)),
  label: `${fromMin ?? '처음'}~${toMin ?? '끝'}`,
});

test('⭐ 창은 턴의 첫 이벤트 시각으로 분모를 자르고, 창 밖 턴 수를 보인다', () => {
  const events = [
    ...turnDone(1, 't1', 27), // 창 앞
    ...turnDone(5, 't2', 27), // 창 안
    ...turnDone(8, 't3', 27), // 창 안
    ...turnDone(12, 't4', 27), // 창 뒤
  ];
  const s = summarize(events, { window: win(4, 10) });
  assert.equal(s.turns.gated, 2);
  assert.equal(s.turns.outsideWindow, 2);
  assert.equal(s.turnEnd.completed, 2);
  const out = render(s);
  assert.match(out, /v2 기간 창\s+4~10 에 시작한 턴만 분모 \(창 밖 턴 2 제외 · 판정 문맥은 전체 로그 · v1 지표는 누적\)/);
  assert.match(out, /게이트가 본 턴 2 · 발동 있는 턴 0/);
  // 같은 로그를 창 없이 내면 누적 4 — 창이 있을 때만 잘린다
  assert.equal(summarize(events).turns.gated, 4);
});

test('⭐ 창의 마지막 턴은 창 밖의 뒤 턴으로 중단 판정된다 — 문맥을 자르면 미판정으로 둔갑한다', () => {
  const events = [
    stop(0, 't0'), // 관찰 경계
    gp(5, 't1'), //          창 안 · stop 없음
    gp(12, 't2'), stop(13, 't2'), // 창 뒤의 같은 세션 턴 → t1 은 중단
  ];
  const s = summarize(events, { window: win(4, 10) });
  assert.equal(s.turnEnd.interrupted, 1, '창 밖 뒤 턴이 문맥으로 쓰인다');
  assert.equal(s.turnEnd.undetermined, 0);
  assert.equal(s.turns.gated, 1);
});

test('⭐ 창의 첫 턴은 창 밖의 직전 audit 과 비교된다 — 문맥을 자르면 첫 audit 미판정으로 둔갑한다', () => {
  const events = [
    ...turnDone(1, 't1', 30), // 창 앞 — 시계열의 첫 audit
    ...turnDone(5, 't2', 27), // 창 안 — 직전(30)보다 줄었다 → 그린
    ...turnDone(8, 't3', 28), // 창 안 — 늘었다 → 레드
  ];
  const s = summarize(events, { window: win(4, 10) });
  assert.deepEqual(
    { green: s.verify.green, red: s.verify.red, undetermined: s.verify.undetermined },
    { green: 1, red: 1, undetermined: 0 },
  );
  assert.deepEqual(s.complete, { observed: true, judged: 2, done: 1 });
  assert.match(render(s), /v2 완주\(세 축\)\s+완주 1\/2/);
});

test('첫 stop 경계도 전체 로그에서 온다 — 창 앞의 stop 이 창 안 턴을 "관찰 이전" 에서 꺼내 준다', () => {
  const events = [
    gp(1, 't1'), stop(2, 't1'), // 창 앞의 첫 stop
    gp(5, 't2'), gp(7, 't3'), stop(8, 't3'), // 창 안 — t2 는 중단
  ];
  const s = summarize(events, { window: win(4, 10) });
  assert.equal(s.turnEnd.preHook, 0);
  assert.equal(s.turnEnd.interrupted, 1);
});

test('한쪽만 열린 창(--from 만 · --to 만)도 동작한다', () => {
  const events = [...turnDone(1, 't1', 5), ...turnDone(5, 't2', 5), ...turnDone(9, 't3', 5)];
  assert.equal(summarize(events, { window: win(4, null) }).turns.gated, 2);
  assert.equal(summarize(events, { window: win(null, 4) }).turns.gated, 1);
});

test('⭐ v1 지표는 창을 타지 않는다 — 발동·오탐률·완주율(audit 시계열)은 누적 정의 그대로', () => {
  const events = [
    ...turnDone(1, 't1', 30),
    { ...fire(2, 'deny', 'x'), turn: 't1', session: 's1' },
    ...turnDone(5, 't2', 27),
  ];
  const whole = summarize(events);
  const cut = summarize(events, { window: win(4, 10) });
  assert.equal(cut.gate.fires, whole.gate.fires);
  assert.equal(cut.gate.denominator, whole.gate.denominator);
  assert.deepEqual(cut.completion, whole.completion);
  assert.equal(cut.turns.gated, 1, 'v2 분모만 잘린다');
});

test('게이트 밖 턴의 stop 도 창 기준으로 센다', () => {
  const events = [gp(5, 't1'), stop(6, 't1'), stop(7, 'chat-in'), stop(12, 'chat-out')];
  assert.equal(summarize(events, { window: win(4, 10) }).turnEnd.stopsOutsideGate, 1);
  assert.equal(summarize(events).turnEnd.stopsOutsideGate, 2);
});

test('⭐ parseWindow — 날짜는 UTC 자정, from 포함 · to 제외, 창이 없으면 null', () => {
  assert.equal(parseWindow([]), null);
  const w = parseWindow(['--from', '2026-09-04', '--to', '2026-09-18']);
  assert.equal(w.from, Date.parse('2026-09-04T00:00:00Z'));
  assert.equal(w.to, Date.parse('2026-09-18T00:00:00Z'));
  assert.equal(w.label, '2026-09-04 ~ 2026-09-18');
  // 경계: 09-18 00:00Z 에 시작한 턴은 창 밖(제외), 09-17 23:59:59Z 는 창 안
  const at = (iso, turn) => [{ ...pass(0), ts: iso, turn, session: 's1' }];
  assert.equal(summarize([...at('2026-09-18T00:00:00.000Z', 'a')], { window: w }).turns.gated, 0);
  assert.equal(summarize([...at('2026-09-17T23:59:59.000Z', 'b')], { window: w }).turns.gated, 1);
  // ISO 일시도 받는다
  assert.equal(parseWindow(['--from', '2026-09-04T09:00:00Z']).from, Date.parse('2026-09-04T09:00:00Z'));
  assert.equal(parseWindow(['--to', '2026-09-18']).label, '처음 ~ 2026-09-18');
});

test('⭐ parseWindow — 잘못된 창은 던진다: 값 없음 · 못 읽는 날짜 · from ≥ to', () => {
  assert.throws(() => parseWindow(['--from']), /뒤에 날짜가 없습니다/);
  assert.throws(() => parseWindow(['--from', '--to', '2026-09-18']), /뒤에 날짜가 없습니다/);
  assert.throws(() => parseWindow(['--from', '지난주']), /날짜로 읽을 수 없습니다/);
  assert.throws(() => parseWindow(['--from', '2026-09-18', '--to', '2026-09-04']), /보다 앞서야 합니다/);
  assert.throws(() => parseWindow(['--from', '2026-09-04', '--to', '2026-09-04']), /보다 앞서야 합니다/);
});
