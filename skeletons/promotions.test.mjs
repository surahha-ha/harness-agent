/**
 * v2 위임 승격의 테스트 (docs/15 §8 기준 2·3).
 *
 * 여기서 지키는 계약: **강등 조건이 빈 레코드는 무효다**, **강등 3종(사고 note·수동·정의 변경)이
 * 자동으로 승격을 실효시킨다**(합성 note 로 실증 — 실사고를 기다리지 않는다), **후보 판정은
 * 구분 불가를 승격에 유리하게 해석하지 않는다**(after 부재 = 실패 = 스트릭 리셋),
 * **deny 는 승격 대상이 아니다**, **후보 0 은 침묵이 아니라 "부족한 축" 으로 표기된다.**
 *
 * 실행: node --test skeletons/promotions.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordValidity,
  promotionStateFor,
  currentPatternOf,
  candidateFor,
  slotsReady,
  DEMOTION_NOTE_LABELS,
} from './lib/promotions.mjs';
import { promotionReport } from './metrics.mjs';

const SLOTS = { n: 3, immediateSeconds: 5, spreadDays: 2 };

/** 합성 이벤트 — d일 m분, ask fire 와 그 승인(after)을 지연초와 함께 만든다. */
const ts = (d, m, s = 0) =>
  `2026-08-${String(d).padStart(2, '0')}T06:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`;
const fire = (d, m, rule = 'r1', cmdPrefix = 'tool sub') => ({
  ts: ts(d, m), event: 'fire', gate: 'danger-guard', rule, decision: 'ask', probe: false, cmdPrefix,
});
const after = (d, m, s, cmdPrefix = 'tool sub') => ({
  ts: ts(d, m, s), event: 'after', gate: 'danger-guard', probe: false, cmdPrefix,
});
/** 승인된 ask 1쌍 — latency 초 뒤 after. */
const approved = (d, m, latency = 30, rule = 'r1') => [fire(d, m, rule), after(d, m, latency)];

const RECORD = {
  ts: ts(10, 0),
  rule: 'r1',
  approvedBy: '{승인 주체}',
  pattern: '/\\brisky\\b/',
  evidence: { streak: 3, days: 2, latencySeconds: [30, 40, 50], asks: 3 },
  demotion: { onNoteLabels: ['false-positive', 'false-green', 'incident'], manual: true, onPatternChange: true },
};

// ── 레코드 유효성 (기준 2) ──────────────────────────────────────────────────

test('⭐ 강등 조건이 빈 레코드는 무효다 — 강등 없는 승격은 구조로 막힌다', () => {
  const v = recordValidity({ ...RECORD, demotion: {} });
  assert.equal(v.valid, false);
  assert.match(v.reason, /강등/);
  assert.equal(recordValidity({ ...RECORD, demotion: undefined }).valid, false);
});

test('승인 주체·근거 스냅샷이 없는 레코드도 무효다', () => {
  assert.equal(recordValidity({ ...RECORD, approvedBy: undefined }).valid, false);
  assert.equal(recordValidity({ ...RECORD, evidence: undefined }).valid, false);
});

test('필수 필드가 다 있으면 유효하다', () => {
  assert.equal(recordValidity(RECORD).valid, true);
});

// ── 승격 상태와 강등 3종 (기준 3 — 합성 note 실증) ──────────────────────────

test('유효 레코드 + 강등 신호 없음 = 승격 활성', () => {
  const s = promotionStateFor('r1', [RECORD], [], RECORD.pattern);
  assert.equal(s.active, true);
});

test('⭐ 강등 ⓐ — 승격 이후의 오탐 note(rule 일치) 1건으로 즉시 실효', () => {
  const noteEvt = { ts: ts(11, 0), event: 'note', label: 'false-positive', rule: 'r1' };
  const s = promotionStateFor('r1', [RECORD], [noteEvt], RECORD.pattern);
  assert.equal(s.active, false);
  assert.match(s.reason, /ⓐ/);
});

test('승격 이전의 note 는 실효 사유가 아니다 — 그 오탐은 스트릭이 이미 반영했다', () => {
  const noteEvt = { ts: ts(9, 0), event: 'note', label: 'false-positive', rule: 'r1' };
  assert.equal(promotionStateFor('r1', [RECORD], [noteEvt], RECORD.pattern).active, true);
});

test('rule 이 다르거나 없는 note 는 이 규칙을 강등하지 않는다', () => {
  const other = { ts: ts(11, 0), event: 'note', label: 'incident', rule: 'r2' };
  const noRule = { ts: ts(11, 0), event: 'note', label: 'incident' };
  assert.equal(promotionStateFor('r1', [RECORD], [other, noRule], RECORD.pattern).active, true);
});

test('fp-reviewed(판정 마커) note 는 rule 을 가리켜도 강등 사유가 아니다 — 판정 사실 ≠ 오탐 확정', () => {
  const marker = { ts: ts(11, 0), event: 'note', label: 'fp-reviewed', rule: 'r1' };
  assert.equal(DEMOTION_NOTE_LABELS.includes('fp-reviewed'), false);
  assert.equal(promotionStateFor('r1', [RECORD], [marker], RECORD.pattern).active, true);
});

test('⭐ recurrence·caught-defect 는 rule 을 가리켜도 강등 사유가 아니다 — 판정 관찰이지 규칙 과잉의 확정이 아니다', () => {
  for (const name of ['recurrence', 'caught-defect']) {
    const marker = { ts: ts(11, 0), event: 'note', label: name, rule: 'r1' };
    assert.equal(DEMOTION_NOTE_LABELS.includes(name), false, `${name} 은 강등 어휘 밖`);
    assert.equal(
      promotionStateFor('r1', [RECORD], [marker], RECORD.pattern).active,
      true,
      `${name} 이 승격을 실효시키면 안 된다`,
    );
  }
});

test('⭐ 강등 ⓑ — 수동 demoted note 로 즉시 실효', () => {
  const noteEvt = { ts: ts(11, 0), event: 'note', label: 'demoted', rule: 'r1', text: '사유' };
  const s = promotionStateFor('r1', [RECORD], [noteEvt], RECORD.pattern);
  assert.equal(s.active, false);
  assert.match(s.reason, /수동/);
});

test('⭐ 강등 ⓒ — 규칙 정의가 승격 시점과 다르면 자동 실효', () => {
  const s = promotionStateFor('r1', [RECORD], [], '/\\brisky-changed\\b/');
  assert.equal(s.active, false);
  assert.match(s.reason, /ⓒ/);
});

test('강등 ⓒ — 규칙이 설정에서 사라져도(=현행 패턴 null) 실효', () => {
  assert.equal(promotionStateFor('r1', [RECORD], [], null).active, false);
});

test('레코드가 없거나 무효면 승격 없음 — 보수 방향', () => {
  assert.equal(promotionStateFor('r1', [], [], RECORD.pattern).active, false);
  const invalid = { ...RECORD, demotion: {} };
  assert.equal(promotionStateFor('r1', [invalid], [], RECORD.pattern).active, false);
});

test('currentPatternOf — ask·deny·shared 에서 규칙 id 의 현행 패턴을 찾는다', () => {
  const g = {
    ask: [{ id: 'r1', pattern: /\brisky\b/ }],
    deny: [{ id: 'd1', pattern: /\bwipe\b/ }],
    shared: { targetPattern: /shared/, writePattern: /WRITE/ },
  };
  assert.equal(currentPatternOf(g, 'r1'), String(/\brisky\b/));
  assert.equal(currentPatternOf(g, 'd1'), String(/\bwipe\b/));
  assert.match(currentPatternOf(g, 'shared'), /∩/);
  assert.equal(currentPatternOf(g, 'none'), null);
});

// ── 후보 판정 4축 (기준 1) ──────────────────────────────────────────────────

test('4축 전부 충족 = 후보 (스트릭 3 · 2일 분산 · 즉답 아님)', () => {
  const events = [...approved(1, 0), ...approved(1, 10), ...approved(2, 0)];
  const c = candidateFor('r1', events, SLOTS);
  assert.equal(c.qualified, true);
  assert.equal(c.streak, 3);
  assert.equal(c.days, 2);
});

test('⭐ after 부재(거부/이탈/미발화 — 구분 불가) = 실패로 세어 스트릭이 리셋된다', () => {
  // 승인 2 → 실패 1(다른 접두사라 짝짓기가 정확) → 승인 2 : 스트릭은 마지막 2 뿐이다.
  const events = [
    ...approved(1, 0), ...approved(1, 10),
    fire(2, 0, 'r1', 'tool other'), // after 없음
    ...approved(2, 10), ...approved(3, 0),
  ];
  const c = candidateFor('r1', events, SLOTS);
  assert.equal(c.streak, 2);
  assert.equal(c.failures, 1);
  assert.equal(c.qualified, false);
  assert.ok(c.lacking.some((l) => l.includes('축1')));
});

test('⭐ 같은 접두사에서 짝짓기가 어긋나면 스트릭은 짧아지는 쪽으로만 어긋난다 — 보수 방향', () => {
  // 근사의 한계: 미승인 fire 가 뒤 fire 의 after 를 가로채면 실패가 끝으로 밀린다.
  // 그 결과는 스트릭 과소(여기선 0)이지 과대가 아니다 — 구분 불가는 승격을 늦출 뿐이다 (docs/15 §7).
  const events = [
    ...approved(1, 0), ...approved(1, 10),
    fire(2, 0), // after 없음 — 같은 접두사
    ...approved(2, 10), ...approved(3, 0),
  ];
  const c = candidateFor('r1', events, SLOTS);
  assert.equal(c.failures, 1);
  assert.ok(c.streak <= 2, `스트릭이 실제(2)보다 길게 계산되면 안 된다 — 실측 ${c.streak}`);
  assert.equal(c.qualified, false);
});

test('⭐ 축3 — 전부 즉답(임계 미만)이면 마찰 없음이 아니라 "안 읽음" 으로 부적격', () => {
  const events = [...approved(1, 0, 2), ...approved(1, 10, 3), ...approved(2, 0, 2)];
  const c = candidateFor('r1', events, SLOTS);
  assert.equal(c.qualified, false);
  assert.ok(c.lacking.some((l) => l.includes('축3')));
});

test('축4 — 하루 몰아치기 스트릭은 분산 미달로 부적격', () => {
  const events = [...approved(1, 0), ...approved(1, 10), ...approved(1, 20)];
  const c = candidateFor('r1', events, SLOTS);
  assert.equal(c.qualified, false);
  assert.ok(c.lacking.some((l) => l.includes('축4')));
});

test('⭐ 강등 note 이후로 창이 다시 열린다 — 재승격은 스트릭 0 부터', () => {
  const events = [
    ...approved(1, 0), ...approved(1, 10), ...approved(2, 0), // 후보였던 이력
    { ts: ts(3, 0), event: 'note', label: 'demoted', rule: 'r1', text: '사유' },
    ...approved(4, 0), // 강등 뒤 1건뿐
  ];
  const c = candidateFor('r1', events, SLOTS);
  assert.equal(c.windowStart, ts(3, 0));
  assert.equal(c.streak, 1);
  assert.equal(c.qualified, false);
});

test('프로브·다른 규칙의 fire 는 스트릭에 섞이지 않는다', () => {
  const probeFire = { ...fire(1, 5), probe: true, rule: 'probe' };
  const otherRule = fire(1, 6, 'r2', 'other cmd');
  const events = [...approved(1, 0), probeFire, otherRule, ...approved(1, 10), ...approved(2, 0)];
  const c = candidateFor('r1', events, SLOTS);
  assert.equal(c.streak, 3);
  assert.equal(c.qualified, true);
});

test('slotsReady — 셋 다 유한 양수여야 판정한다', () => {
  assert.equal(slotsReady(SLOTS), true);
  assert.equal(slotsReady({ n: 3, immediateSeconds: 5 }), false);
  assert.equal(slotsReady(undefined), false);
  assert.equal(slotsReady({ n: 0, immediateSeconds: 5, spreadDays: 2 }), false);
});

// ── 후보 리포트 (기준 1 — 침묵하지 않는다) ──────────────────────────────────

const CFG = {
  dangerGuard: {
    enabled: true,
    deny: [{ id: 'd1', pattern: /\bwipe\b/, why: '파괴' }],
    ask: [{ id: 'r1', pattern: /\brisky\b/, why: '위험' }],
  },
  promotion: SLOTS,
};

test('후보 아님은 부족한 축이 명시된다 — "후보 없음" 은 침묵이 아니다', () => {
  const out = promotionReport(CFG, [], []).join('\n');
  assert.match(out, /r1/);
  assert.match(out, /후보 아님/);
  assert.match(out, /축1/);
});

test('deny 규칙은 리포트의 승격 대상에 아예 나오지 않는다', () => {
  const out = promotionReport(CFG, [], []).join('\n');
  assert.doesNotMatch(out, /d1/);
});

test('4축 충족이면 후보로 표기되고 적용 명령이 안내된다', () => {
  const events = [...approved(1, 0), ...approved(1, 10), ...approved(2, 0)];
  const out = promotionReport(CFG, events, []).join('\n');
  assert.match(out, /★ r1/);
  assert.match(out, /--promote/);
});

test('슬롯 미설정이면 후보 판정을 하지 않고 그 사실을 말한다', () => {
  const cfg = { ...CFG, promotion: {} };
  const out = promotionReport(cfg, [], []).join('\n');
  assert.match(out, /슬롯 미설정/);
});

test('활성 승격은 ✔, note 로 실효된 승격은 ✖ 로 표기된다', () => {
  const record = { ...RECORD, pattern: String(/\brisky\b/) };
  const active = promotionReport(CFG, [], [record]).join('\n');
  assert.match(active, /✔ r1/);
  const noteEvt = { ts: ts(11, 0), event: 'note', label: 'incident', rule: 'r1' };
  const demoted = promotionReport(CFG, [noteEvt], [record]).join('\n');
  assert.match(demoted, /✖ r1/);
});
