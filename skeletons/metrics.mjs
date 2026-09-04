#!/usr/bin/env node
/**
 * v1 계측 — 리포트 명령 (`docs/13-v1-eval-design.md` §4).
 *
 * `.harness/log.jsonl` 을 읽어 지표 5종을 산출한다. 판정하지 않는다 — 게이트가 아니라 거울이다.
 *
 * ⭐ **미수집은 "미수집" 으로 표기한다.** 안 잰 것과 0 은 다르다(골격 공통 규약 4).
 *    데이터가 모자라면 0 이나 빈 값이 아니라 무엇이 몇 개 모자라는지를 말한다.
 * ⭐ 사람 응답은 근사다 — `fire(ask)` 뒤 같은 접두사의 `after` 가 있으면 승인,
 *    없으면 "거부/이탈(구분 불가)". 근사를 정밀 관찰인 것처럼 표기하지 않는다 (docs/13 §2).
 * ⭐ 프로브 발동은 모든 지표에서 제외한다 — 검증 신호를 개입으로 세면 지표가 오염된다.
 *
 * 사용:
 *   node skeletons/metrics.mjs                                  # 지표 5종 리포트 + v2 턴(게이트·중단·검증 축) + 완주(세 축)
 *   node skeletons/metrics.mjs --note <label> [--value N] [--text "..."] [--rule <id>]  # 사람 라벨 기록
 *     label: false-positive(오탐 확정) · false-green(거짓 그린 감사) · bootstrap-minutes(부트스트랩 소요)
 *            incident(사고) · promoted/demoted(승격·강등 사실 — 보통 아래 명령이 대신 남긴다)
 *            fp-reviewed(오탐 판정 마커 — 이 시각까지의 발동을 사람이 전수 판정했다는 경계표.
 *                        오탐 확정이 아니다 — 확정은 false-positive 로 따로 남긴다)
 *            recurrence(그 발동이 이미 판정한 것과 같은 원인의 반복이다 — 안내가 습관을 못 바꾼 신호)
 *            caught-defect(그 차단이 실제 결함을 드러냈다 — 규칙이 만들어 낸 재검토의 값)
 *            ↑ 둘은 판정(§6 절차 1) 중에만 붙인다. 건수로만 보고되고 비율이 되지 않는다.
 *     ⚠️ 오탐·사고 note 에 --rule 을 붙이면 그 규칙의 승격을 즉시 실효시킨다 (docs/15 §6 ⓐ).
 *        fp-reviewed 의 --rule 은 판정 범위를 그 규칙으로 좁힐 뿐, 승격을 건드리지 않는다.
 *   node skeletons/metrics.mjs --promotions                     # v2 승격 후보 리포트 + 레코드 상태
 *   node skeletons/metrics.mjs --promote <규칙id> --approved-by <이름>   # 후보 승격 적용(레코드 작성)
 *   node skeletons/metrics.mjs --demote <규칙id> --text "사유"           # 수동 강등 (docs/15 §6 ⓑ)
 *   node skeletons/metrics.mjs --contract                       # 로그를 스키마 계약(docs/13 §3)에 대고 검사 — 내역
 *     리포트 말미에도 같은 검사의 요약 한 줄이 항상 붙는다. 값은 찍지 않고 건수·필드명만 낸다(로그는 반출 금지).
 *
 * 종료코드: 0 리포트/기록 완료 · 2 도구 오류 · (--contract) 1 계약 위반 있음
 */

import os from 'node:os';
import {
  logEvent,
  readLog,
  logPath,
  isPairablePrefix,
  normalizeCmdPrefix,
  UNPARSED_PREFIX,
} from './lib/log.mjs';
import { projectRoot, loadConfig } from './lib/config.mjs';
import {
  readPromotions,
  appendPromotion,
  promotionStateFor,
  currentPatternOf,
  candidateFor,
  slotsReady,
  DEMOTION_NOTE_LABELS,
} from './lib/promotions.mjs';

/** 사람 라벨의 알려진 어휘 — 지표 집계가 문자열 일치에 걸리므로 오타를 보이게 한다. */
export const KNOWN_LABELS = [
  'false-positive',
  'false-green',
  'bootstrap-minutes',
  'incident',
  'promoted',
  'demoted',
  'fp-reviewed',
  // 아래 둘은 §6 절차 1(오탐 전수 판정)의 그 자리에서만 붙는다 — 사람이 원문을 이미 보고 있는 곳.
  // 강등 어휘 밖이다: recurrence 는 규칙이 과잉이라는 뜻이 아니고, caught-defect 는 그 반대다.
  'recurrence',
  'caught-defect',
];

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 지표 5종을 계산한다. 순수 함수 — 이 함수 자체를 테스트한다.
 * @param {object[]} events 로그 이벤트 (ts 순서는 여기서 정렬한다)
 */
/**
 * 기간 창 인자(`--from`·`--to`)를 해석한다. 값은 `YYYY-MM-DD` 또는 ISO 일시. from 은 포함, to 는 **제외**
 * (`--from 2026-09-04 --to 2026-09-18` = 09-04 00:00Z 부터 09-18 00:00Z 직전까지 — 2주가 날짜 그대로 읽힌다).
 * 잘못된 값은 조용히 무시하지 않고 던진다 — 창이 안 걸린 채 누적이 나오면 기준선을 잘못 잡는다.
 * @returns {{from: number|null, to: number|null, label: string}|null} 창이 없으면 null
 */
export function parseWindow(argv) {
  const pick = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const raw = argv[i + 1];
    if (!raw || raw.startsWith('--')) throw new Error(`${flag} 뒤에 날짜가 없습니다 (YYYY-MM-DD 또는 ISO 일시)`);
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
    if (!Number.isFinite(ms)) throw new Error(`${flag} 값을 날짜로 읽을 수 없습니다: "${raw}"`);
    return { ms, raw };
  };
  const from = pick('--from');
  const to = pick('--to');
  if (!from && !to) return null;
  if (from && to && from.ms >= to.ms) throw new Error(`--from(${from.raw}) 이 --to(${to.raw}) 보다 앞서야 합니다`);
  return {
    from: from ? from.ms : null,
    to: to ? to.ms : null,
    label: `${from ? from.raw : '처음'} ~ ${to ? to.raw : '끝'}`,
  };
}

/**
 * @param {object[]} events 로그 이벤트
 * @param {{window?: {from: number|null, to: number|null, label: string}|null}} [opts]
 *   window — v2 턴 줄의 **분모만** 자른다: 턴의 첫 이벤트 시각이 [from, to) 안인 턴. 판정 문맥(같은 세션의
 *   뒤 턴, 시계열상 직전 audit, 첫 stop 경계)은 전체 로그를 본다 — 이벤트를 잘라 버리면 창의 마지막 턴은
 *   뒤 턴이 안 보여 미판정이 되고 첫 턴은 직전 audit 을 잃어 미판정이 된다(창 양 끝이 체계적으로 빠진다).
 *   v1 지표 5종은 창을 타지 않는다(누적 정의 그대로). docs/16 결정 이력 2026-09-04.
 */
export function summarize(events, opts = {}) {
  const window = opts.window ?? null;
  const sorted = [...events].sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  const fires = sorted.filter((e) => e.event === 'fire' && !e.probe);
  const probes = sorted.filter((e) => (e.event === 'fire' || e.event === 'after') && e.probe);
  const passes = sorted.filter((e) => e.event === 'pass');
  const afters = sorted.filter((e) => e.event === 'after' && !e.probe);
  const notes = sorted.filter((e) => e.event === 'note');
  const stops = sorted.filter((e) => e.event === 'stop');
  // ⭐ 경계표가 비어 있던 audit(inScope 0)은 완주율 시계열에서 뺀다 — "잰 것이 없어 미달 0"
  //    을 "다 닫혀서 미달 0" 으로 읽으면 완주율이 거짓 그린이 된다 (3회차 실적용에서 실측된 결함).
  const tfAudits = sorted.filter(
    (e) => e.event === 'audit' && e.gate === 'test-first' && e.inScope > 0,
  );
  const emptyAudits = sorted.filter(
    (e) => e.event === 'audit' && e.gate === 'test-first' && !(e.inScope > 0),
  ).length;
  const driftAudits = sorted.filter((e) => e.event === 'audit' && e.gate === 'drift-watch');

  // 지표 2 — ask 발동마다 after 하나를 짝짓는다(한 번 쓴 after 는 재사용 금지).
  //   정확: 같은 도구 호출 식별자(call) — 훅 페이로드에서 온 로그만 (docs/16 §4).
  //   근사: call 이 없는 옛 로그만, 같은 접두사 + 시간 순서. ⚠️ call 이 있는 ask 는 근사로 떨어지지 않는다 —
  //   그 after 도 call 을 갖고 왔을 것이므로, 접두사로 남의 after 를 집는 쪽이 오차다. 둘은 따로 센다(혼합 금지).
  const consumed = new Set();
  let approvedExact = 0;
  let approvedApprox = 0;
  const asks = fires.filter((e) => e.decision === 'ask');
  for (const ask of asks) {
    let hit = -1;
    if (ask.call) {
      hit = afters.findIndex((a, i) => !consumed.has(i) && a.call === ask.call);
      if (hit >= 0) approvedExact++;
    } else if (isPairablePrefix(ask.cmdPrefix)) {
      // 열쇠가 될 수 없는 접두사(빈 값·(unparsed))는 짝을 찾지 않는다 — 승인으로 세지 않는 쪽이 보수적이다.
      hit = afters.findIndex(
        (a, i) =>
          !consumed.has(i) && !a.call && a.cmdPrefix === ask.cmdPrefix && String(a.ts) >= String(ask.ts),
      );
      if (hit >= 0) approvedApprox++;
    }
    if (hit >= 0) consumed.add(hit);
  }
  const approved = approvedExact + approvedApprox;

  // v2 — 턴 단위 (docs/16). 분모 = 게이트가 본 턴(pass 나 fire 가 하나라도 있는 turn), 분자 후보 = 발동 없는 턴.
  //   turn 이 없는 이벤트(페이로드 식별자 이전 로그)는 분모에 넣지 않고 **제외 수를 보인다** — 0 으로 둔갑 금지.
  const allGatedTurns = new Set();
  const firedTurns = new Set();
  let eventsWithoutTurn = 0;
  for (const e of [...passes, ...fires]) {
    if (e.turn) allGatedTurns.add(e.turn);
    else eventsWithoutTurn++;
  }
  for (const e of fires) if (e.turn) firedTurns.add(e.turn);

  // v2 ㄴ 축 — 사람 중단 없음 (docs/16 §5.1 실측으로 확정된 3분기). `stop` 은 Stop 훅이 턴마다 남긴다.
  //   Stop 있음 = 정상 종료 · 없는데 같은 세션에 뒤 턴이 있음 = 중단 · 없고 세션 마지막 턴 = 미판정(관찰 경계).
  //   ⭐ 마지막 턴을 중단으로 세지 않는다 — 관찰이 끝난 자리와 사람이 끊은 자리는 다르다.
  //   ⭐ 첫 stop 이전에 끝난 턴은 "관찰 이전" 으로 제외한다 — 훅이 없던 기간을 전부 중단으로 읽으면 창작이다.
  //   분모는 게이트 축과 같은 "게이트가 본 턴" 이다 — 축이 다르다고 분모를 따로 두면 두 축을 합칠 수 없다.
  const turnInfo = new Map(); // turn → { session, first, last }
  for (const e of sorted) {
    if (!e.turn) continue;
    const t = String(e.ts);
    const info = turnInfo.get(e.turn) || { session: e.session, first: t, last: t };
    if (!info.session && e.session) info.session = e.session;
    if (t < info.first) info.first = t;
    if (t > info.last) info.last = t;
    turnInfo.set(e.turn, info);
  }
  // 기간 창 — 턴이 분모에 드는 시각(첫 이벤트)이 창 안인 턴만 분모. 문맥(turnInfo·stops·audit 시계열)은 전체.
  const inWindow = (turn) => {
    if (!window) return true;
    const ms = Date.parse(turnInfo.get(turn)?.first);
    if (!Number.isFinite(ms)) return false; // ts 를 못 읽는 턴은 창 안이라고 단정하지 않는다
    return (window.from === null || ms >= window.from) && (window.to === null || ms < window.to);
  };
  const gatedTurns = new Set([...allGatedTurns].filter(inWindow));
  const turnsOutsideWindow = allGatedTurns.size - gatedTurns.size;
  const stoppedTurns = new Set(stops.filter((e) => e.turn).map((e) => e.turn));
  const boundary = stops.length > 0 ? String(stops[0].ts) : null;
  const turnEnd = {
    observed: stops.length > 0,
    completed: 0,
    interrupted: 0,
    undetermined: 0,
    preHook: 0,
    bothTrue: 0, // 게이트 축 · 중단 축 모두 참 — 아직 완주가 아니다(검증 그린 축 미수집)
    stopsOutsideGate: 0, // 도구를 안 쓴 턴의 stop — 분모 밖이라 세지 않지만 보이게는 한다
    stopsWithoutTurn: stops.filter((e) => !e.turn).length,
  };
  const stopVerdict = new Map(); // turn → 'completed' | 'interrupted' | 'undetermined' | 'preHook'
  if (turnEnd.observed) {
    for (const turn of gatedTurns) {
      const info = turnInfo.get(turn);
      if (stoppedTurns.has(turn)) {
        turnEnd.completed++;
        stopVerdict.set(turn, 'completed');
        if (!firedTurns.has(turn)) turnEnd.bothTrue++;
        continue;
      }
      if (info.last < boundary) {
        turnEnd.preHook++;
        stopVerdict.set(turn, 'preHook');
        continue;
      }
      const laterTurnInSession =
        Boolean(info.session) &&
        [...turnInfo.entries()].some(
          ([other, o]) => other !== turn && o.session === info.session && o.first > info.last,
        );
      if (laterTurnInSession) turnEnd.interrupted++;
      else turnEnd.undetermined++;
      stopVerdict.set(turn, laterTurnInSession ? 'interrupted' : 'undetermined');
    }
    for (const turn of stoppedTurns) if (!allGatedTurns.has(turn) && inWindow(turn)) turnEnd.stopsOutsideGate++;
  }
  turnEnd.judged = turnEnd.completed + turnEnd.interrupted;

  // v2 ㄷ 축 — 검증 그린의 **대체 경로** (docs/16 §5 기준 4 · 결정 이력 2026-09-03(3)).
  //   턴 종료 audit(turn 있음 — turn-end.mjs 가 auditOnStop 으로 남긴다)의 "테스트 없음" 이 시계열상 **직전 audit**
  //   (턴 유무 무관 — 수동 --audit 도 같은 시계열) 보다 늘지 않았으면 그린, 늘었으면 레드.
  //   ⭐ 테스트 실행의 그린이 아니다 — 종료코드는 페이로드에 없다(실측 173/173). 표기에 "대체" 를 박는다.
  //   ⭐ "미달 0" 을 쓰지 않는 이유: 유예(grandfather)된 기존 위반이 있는 설치처는 모든 턴이 영원히 레드가 된다
  //      (실측: 한 설치처 경계 안 39 · 테스트 없음 27). 턴이 한 일은 늘렸는가/안 늘렸는가다.
  //   첫 audit(비교 대상 없음) = 미판정 · 그 턴에 turn 있는 audit 없음 = 미수집 · inScope 0 은 경계표 없음이라 시계열 밖.
  const auditSeries = sorted.filter((e) => e.event === 'audit' && e.gate === 'test-first' && e.inScope > 0);
  const verify = {
    observed: auditSeries.some((e) => e.turn),
    green: 0,
    red: 0,
    undetermined: 0,
    unobserved: 0,
  };
  const verifyVerdict = new Map(); // turn → true(그린) | false(레드) | null(미판정)
  if (verify.observed) {
    for (const turn of gatedTurns) {
      let idx = -1;
      for (let i = auditSeries.length - 1; i >= 0; i--) {
        if (auditSeries[i].turn === turn) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        verify.unobserved++;
        continue;
      }
      if (idx === 0) {
        verify.undetermined++;
        verifyVerdict.set(turn, null);
        continue;
      }
      const green = Number(auditSeries[idx].missing) <= Number(auditSeries[idx - 1].missing);
      verifyVerdict.set(turn, green);
      if (green) verify.green++;
      else verify.red++;
    }
  }
  verify.judged = verify.green + verify.red;

  // v2 완주 — 세 축이 **모두 판정된** 턴만 분모로, 셋 다 참인 턴이 분자 (docs/16 §3). 축 하나라도 미판정·미수집이면
  // 그 턴은 분모에서 빠지고 빠진 수는 각 축 줄에 보인다. 여기서 비로소 "완주" 라는 말을 쓴다.
  const complete = { observed: turnEnd.observed && verify.observed, judged: 0, done: 0 };
  if (complete.observed) {
    for (const turn of gatedTurns) {
      const sv = stopVerdict.get(turn);
      const vv = verifyVerdict.get(turn);
      if ((sv === 'completed' || sv === 'interrupted') && typeof vv === 'boolean') {
        complete.judged++;
        if (!firedTurns.has(turn) && sv === 'completed' && vv) complete.done++;
      }
    }
  }

  // 지표 3 — 인접 발동 간 시간(분). 발동이 2건 미만이면 잴 수 없다.
  const gaps = [];
  for (let i = 1; i < fires.length; i++) {
    const a = Date.parse(fires[i - 1].ts);
    const b = Date.parse(fires[i].ts);
    if (Number.isFinite(a) && Number.isFinite(b)) gaps.push((b - a) / 60000);
  }

  const falsePositives = notes.filter((n) => n.label === 'false-positive').length;
  // ⭐ 오탐 판정 경계 — "라벨 0건" 과 "판정했더니 오탐 없음" 을 가른다 (docs/13 §6 절차 1).
  //    fp-reviewed note 의 ts 가 경계표다: 그 시각 이전의 발동은 판정 완료, 이후는 미판정.
  //    rule 이 있으면 그 규칙의 발동만 덮는다. 오탐률(false-positive/fire) 계산은 건드리지 않는다.
  const reviews = notes.filter((n) => n.label === 'fp-reviewed');
  const reviewedFires = fires.filter((f) =>
    reviews.some(
      (r) => String(f.ts).localeCompare(String(r.ts)) <= 0 && (!r.rule || r.rule === f.rule),
    ),
  ).length;
  // ⭐ 판정 층에서만 나오는 두 수 (docs/13 §4 지표 4 보조 표기 · F24·F25).
  //    자동 산출을 시도하지 않는다 — 접두사는 "같은 원인" 을 가르는 해상도가 없고(F26 실측:
  //    한 설치처의 발동 15건 중 13건이 셸 관용구 하나로 뭉쳤다), 재검토가 일어났는지는 로그에
  //    아예 없다. 사람이 원문을 보는 그 자리(§6 절차 1)에서 붙이는 라벨이 유일하게 정직한 출처다.
  //    ⚠️ 건수로만 표기하고 비율로 만들지 않는다 — 분모("무엇 대비 재발인가")가 판정 범위에
  //    따라 흔들려서, 비율로 굳히면 오탐률처럼 고정된 정의를 가진 척하게 된다.
  const recurrences = notes.filter((n) => n.label === 'recurrence').length;
  const caughtDefects = notes.filter((n) => n.label === 'caught-defect').length;
  const bootstrapMinutes = notes
    .filter((n) => n.label === 'bootstrap-minutes' && Number.isFinite(n.value))
    .map((n) => n.value);

  return {
    completion: {
      audits: tfAudits.length,
      emptyAudits,
      first: tfAudits[0] ?? null,
      last: tfAudits[tfAudits.length - 1] ?? null,
    },
    intervention: {
      asks: asks.length,
      approved,
      approvedExact,
      approvedApprox,
      unresolved: asks.length - approved,
    },
    turns: {
      gated: gatedTurns.size,
      fired: [...gatedTurns].filter((turn) => firedTurns.has(turn)).length,
      quiet: [...gatedTurns].filter((turn) => !firedTurns.has(turn)).length,
      eventsWithoutTurn,
      outsideWindow: turnsOutsideWindow,
    },
    window: window ? { label: window.label } : null,
    turnEnd,
    verify,
    complete,
    gap: { fires: fires.length, medianMinutes: median(gaps) },
    gate: {
      fires: fires.length,
      denies: fires.filter((e) => e.decision === 'deny').length,
      asks: asks.length,
      falsePositives,
      reviewed: reviewedFires,
      unreviewed: fires.length - reviewedFires,
      recurrences,
      caughtDefects,
      denominator: passes.length + fires.length,
    },
    cost: { bootstrapMinutes, pass: passes.length, fire: fires.length },
    // 승격된 규칙의 매치 — pass 이면서 rule·promoted 를 갖는다 (docs/15 §5, 기록은 끊기지 않는다).
    promotedPasses: passes.filter((e) => e.promoted === true).length,
    probesExcluded: probes.length,
    driftAudits: {
      count: driftAudits.length,
      last: driftAudits[driftAudits.length - 1] ?? null,
    },
  };
}

/** 리포트를 사람 읽는 형태로 만든다. 순수 함수 — 문자열만 돌려준다. */
export function render(s) {
  const lines = [];
  const missing = (why) => `미수집 — ${why}`;

  const emptyNote =
    s.completion.emptyAudits > 0 ? ` (경계표 없는 audit ${s.completion.emptyAudits}회 제외)` : '';
  lines.push(
    `1 완주율        ` +
      (s.completion.audits >= 2
        ? `test-first audit ${s.completion.audits}회 — 테스트 없음 ${s.completion.first.missing} → ${s.completion.last.missing}` +
          (s.completion.last.missing === 0 ? ' (닫힘)' : '') +
          emptyNote
        : missing(
            `test-first audit 이벤트가 ${s.completion.audits}개 — 시계열엔 2개 이상이 필요합니다${emptyNote}`,
          )),
  );
  lines.push(
    `2 개입 분해      ` +
      (s.intervention.asks > 0
        ? `ask 발동 ${s.intervention.asks} · 승인 ${s.intervention.approved}` +
          ` (정확 ${s.intervention.approvedExact} · 근사 ${s.intervention.approvedApprox})` +
          ` · 거부/이탈(구분 불가) ${s.intervention.unresolved}`
        : missing('ask 발동이 아직 없습니다')),
  );
  lines.push(
    `3 개입 간 시간   ` +
      (s.gap.medianMinutes !== null
        ? `중앙값 ${Math.round(s.gap.medianMinutes)}분 (발동 ${s.gap.fires}건 기준)`
        : missing(`발동이 ${s.gap.fires}건 — 간격엔 2건 이상이 필요합니다`)),
  );
  lines.push(
    `4 게이트 발동    ` +
      (s.gate.denominator > 0
        ? `발동 ${s.gate.fires} (deny ${s.gate.denies} · ask ${s.gate.asks}) · 오탐 라벨 ${s.gate.falsePositives}` +
          (s.gate.fires > 0 ? ` → 오탐률 ${s.gate.falsePositives}/${s.gate.fires}` : '') +
          // ⭐ 라벨 0 을 오탐 없음으로 읽지 않는다 — 판정 경계(fp-reviewed)가 없는 발동은 미판정이다.
          (s.gate.fires > 0
            ? s.gate.unreviewed > 0
              ? ` · 오탐 판정 ${s.gate.reviewed}/${s.gate.fires} (미판정 ${s.gate.unreviewed} — 라벨 0 ≠ 오탐 없음, --note fp-reviewed 로 경계를 남기세요)`
              : ` · 오탐 판정 ${s.gate.reviewed}/${s.gate.fires} 완료`
            : '') +
          ` · 분모(검사 총량) ${s.gate.denominator}`
        : missing('게이트를 지난 명령이 아직 없습니다 — 훅 연결을 확인하세요(설정≠연결)')),
  );
  // 보조 표기 — 판정 층에서만 나오는 두 수. 라벨이 하나도 없으면 줄 자체를 내지 않는다
  // (0 으로 찍으면 "재발 없음/적발 없음" 으로 읽히는데, 사실은 안 센 것이다 — 공통 규약 4).
  if (s.gate.recurrences > 0 || s.gate.caughtDefects > 0) {
    lines.push(
      `  (판정 층 — 같은 원인 재발 ${s.gate.recurrences}건 · 차단이 결함을 드러냄 ${s.gate.caughtDefects}건` +
        ` / 판정 완료 ${s.gate.reviewed}건 기준, 비율 아님)`,
    );
  }
  lines.push(
    `5 비용/작업      ` +
      (s.cost.bootstrapMinutes.length > 0
        ? `부트스트랩 ${s.cost.bootstrapMinutes.join('·')}분 (${s.cost.bootstrapMinutes.length}점) · 검사 pass ${s.cost.pass} · 발동 ${s.cost.fire}`
        : missing('bootstrap-minutes 라벨이 없습니다 — --note bootstrap-minutes --value N 으로 기록하세요')),
  );
  // v2 — 턴 단위 완주 (docs/16). 게이트 축 하나뿐임을 표기에 박는다 — 중단·검증 그린 축이 붙기 전까지
  // 이 수는 "개입 없이 완주" 가 아니라 "게이트 발동 없이 지나감" 이다.
  const t = s.turns;
  const excluded = t.eventsWithoutTurn > 0 ? ` · turn 없는 이벤트 ${t.eventsWithoutTurn} 제외(식별자 이전 로그)` : '';
  // 기간 창 — 아래 v2 턴 줄들의 분모가 잘렸음을 그 줄들 앞에 박는다. 창 밖 턴 수를 보여 누적과 헷갈리지 않게 한다.
  if (s.window) {
    lines.push(
      `v2 기간 창        ${s.window.label} 에 시작한 턴만 분모 (창 밖 턴 ${t.outsideWindow} 제외 · 판정 문맥은 전체 로그 · v1 지표는 누적)`,
    );
  }
  lines.push(
    `v2 턴(게이트 축)  ` +
      (t.gated > 0
        ? `게이트가 본 턴 ${t.gated} · 발동 있는 턴 ${t.fired} → 무발동 턴 ${t.quiet}/${t.gated}` +
          ` (게이트 축만 — 중단·검증 그린 축 미수집)` +
          excluded
        : missing(`turn 식별자를 가진 이벤트가 0 — 훅 페이로드 식별자 이전 로그입니다${excluded}`)),
  );
  // v2 ㄴ 축 — 같은 분모(게이트가 본 턴)에 대해 따로 표기한다. 두 축이 모두 참인 수를 내되 "완주" 라
  // 부르지 않는다 — 검증 그린 축이 아직 없다 (docs/16 §3: 축이 다 붙기 전엔 완주율이라 부르지 않는다).
  const te = s.turnEnd;
  lines.push(
    `v2 턴(중단 축)    ` +
      (te.observed
        ? `판정 ${te.judged} = 정상 종료 ${te.completed} · 중단 ${te.interrupted}` +
          (te.undetermined > 0 ? ` · 미판정 ${te.undetermined}(세션 마지막 턴 — 관찰 경계)` : '') +
          (te.preHook > 0 ? ` · 관찰 이전 ${te.preHook} 제외(첫 stop 이전 턴)` : '') +
          (te.judged > 0
            ? ` → 게이트·중단 두 축 모두 참 ${te.bothTrue}/${te.judged} (완주 아님 — 검증 그린 축 미수집)`
            : '') +
          (te.stopsOutsideGate > 0 ? ` · 게이트 밖 턴의 stop ${te.stopsOutsideGate}(분모 밖)` : '') +
          (te.stopsWithoutTurn > 0 ? ` · ⚠️ turn 없는 stop ${te.stopsWithoutTurn}(계약 위반 — 연결을 의심)` : '')
        : missing('stop 이벤트가 0 — Stop 훅(turn-end.mjs)이 연결되지 않았거나 연결 뒤 끝난 턴이 없습니다')),
  );
  // v2 ㄷ 축 — 대체 경로임을 줄 안에 박는다. "검증 그린" 이라는 이름이 테스트 실행 결과로 읽히면 안 된다.
  const v = s.verify;
  lines.push(
    `v2 턴(검증 축)    ` +
      (v.observed
        ? `판정 ${v.judged} = 그린 ${v.green} · 레드 ${v.red}` +
          (v.undetermined > 0 ? ` · 미판정 ${v.undetermined}(첫 audit — 비교 대상 없음)` : '') +
          (v.unobserved > 0 ? ` · 미수집 ${v.unobserved}(턴 종료 audit 없음)` : '') +
          ` (대체 경로 — 테스트 없음이 직전 audit 보다 늘지 않음 · 테스트 실행의 그린이 아님)`
        : missing(
            'turn 있는 audit 이 0 — testFirst.auditOnStop: true 로 턴 종료 선실측을 켜세요 (골격 2 시계열 대체 경로)',
          )),
  );
  // v2 완주 — 세 축이 다 있을 때만 이 줄이 값을 갖는다.
  const c = s.complete;
  const lacking = [!s.turnEnd.observed ? '중단 축' : null, !v.observed ? '검증 축' : null].filter(Boolean);
  lines.push(
    `v2 완주(세 축)    ` +
      (c.observed
        ? `완주 ${c.done}/${c.judged} — 세 축 모두 판정된 턴 ${c.judged} 기준 (게이트 무발동 ∧ 정상 종료 ∧ 검증 그린(대체))` +
          (c.judged === 0 ? ' · 아직 세 축이 한 턴에 같이 잡힌 적이 없습니다' : '')
        : missing(`${lacking.join('·')} 미수집 — 세 축이 다 붙기 전에는 완주율을 내지 않습니다`)),
  );
  if (s.probesExcluded > 0) lines.push(`  (프로브 ${s.probesExcluded}건은 전 지표에서 제외)`);
  if (s.promotedPasses > 0)
    lines.push(`  (부가 — 승격 allow 매치 ${s.promotedPasses}건 · --promotions 로 상태 확인)`);
  if (s.driftAudits.count > 0) {
    const d = s.driftAudits.last;
    lines.push(`  (부가 — drift-watch 검사 ${s.driftAudits.count}회 · 최근 새 차이 ${d.fresh})`);
  }
  return lines.join('\n');
}

// ── 스키마 계약 자가 감사 (docs/13 §3 — F26 의 교훈) ────────────────────────────────
//
// "원문을 저장하지 않는다" 류의 계약은 코드가 아니라 **데이터를 뒤져야** 지켜지는지 알 수 있다.
// 로그는 반출 금지라 아무도 열어 보지 않고, 그래서 위반이 아무도 안 보는 곳에 쌓였다(F26: 첫 토큰
// 판별 누락으로 절대경로 199건). 이 검사는 리포트를 만들 때마다 로그 전체를 계약에 대고 훑는다 —
// 정기 감사의 주기를 새로 만들지 않고 이미 있는 리포트 주기에 얹는다.
//
// ⭐ 값은 내지 않는다 — 건수와 (이벤트.필드) 이름만. 위반 내역을 찍는 순간 그 출력이 반출 경로가 된다.
// ⭐ 위반과 관찰을 가른다. 위반 = 계약 문장에 어긋남. 관찰 = 계약 밖이지만 눈에 띄어야 하는 것
//    (계약 밖 필드, 사람이 쓴 note.text 의 경로 — 사람 서술은 §3 의 대상이 아니지만 같은 반출 위험).

const CONTRACT_EVENTS = ['fire', 'pass', 'after', 'audit', 'note', 'stop'];
// session·turn·call 은 환경이 준 식별자다(docs/13 §3 · docs/16) — 원문 흔적 검사(C9)의 대상이 아니다.
const CONTRACT_COMMON = ['ts', 'session', 'turn', 'call', 'event'];
const CONTRACT_IDS = ['session', 'turn', 'call'];
/** 이벤트별 필수·허용 필드 — docs/13 §3 스키마 + 결정 이력의 additive 필드. */
const CONTRACT_FIELDS = {
  fire: { req: ['gate', 'rule', 'decision', 'probe', 'cmdPrefix'], opt: ['outcome'] },
  after: { req: ['gate', 'rule', 'decision', 'probe', 'cmdPrefix'], opt: ['outcome'] },
  pass: { req: ['gate', 'cmdPrefix'], opt: ['rule', 'promoted'] },
  audit: { req: ['gate'], opt: [] }, // 수치 필드는 골격마다 다르다 — "수치" 라는 형태만 계약이다
  note: { req: ['label'], opt: ['text', 'value', 'rule'] },
  // stop 은 턴 종료의 사실 하나뿐이다 — turn 이 없으면 짝지을 수 없으므로 식별자인데도 필수다 (docs/16 §5 기준 3).
  stop: { req: ['gate', 'turn'], opt: [] },
};
const ABS_PATH = /(^|[\s"'=;])([A-Za-z]:[\\/]|\/[A-Za-z]|~\/)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const REGEX_META = /[\\^$()[\]|*+?]/;

function osUser() {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

/**
 * 로그 이벤트를 스키마 계약에 대고 검사한다. 순수 함수(사용자명은 인자로 받는다) — 이 함수를 테스트한다.
 * @param {object[]} events readLog 가 돌려준 이벤트(깨진 JSON 은 이미 빠져 있다 — broken 은 호출부가 따로 표기)
 * @param {{ user?: string }} [opts] 원문 흔적 검사에 쓸 OS 사용자명(빈 값이면 그 검사만 생략)
 * @returns {{ checked: number, folded: number, violations: Record<string, {count:number, where:string[]}>, observations: Record<string, {count:number, where:string[]}> }}
 */
export function auditContract(events, opts = {}) {
  const user = opts.user ?? '';
  const violations = {};
  const observations = {};
  const bump = (bucket, code, where) => {
    const b = (bucket[code] ||= { count: 0, where: [] });
    b.count++;
    if (where && !b.where.includes(where)) b.where.push(where);
  };
  const violate = (code, where) => bump(violations, code, where);
  const observe = (code, where) => bump(observations, code, where);

  let folded = 0;
  let prevTs = null;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!e.ts || Number.isNaN(t)) violate('ts 결손·비ISO');
    else {
      if (prevTs !== null && t < prevTs) observe('ts 역행(append 순서와 다름)');
      prevTs = t;
    }
    for (const id of CONTRACT_IDS)
      if (id in e && (typeof e[id] !== 'string' || !e[id])) violate(`${id} 빈 값`);

    if (!CONTRACT_EVENTS.includes(e.event)) {
      violate('event 어휘 밖', String(e.event));
      continue;
    }
    const spec = CONTRACT_FIELDS[e.event];
    for (const k of spec.req) if (!(k in e)) violate('필수 필드 결손', `${e.event}.${k}`);
    if (e.event === 'audit') {
      for (const k of Object.keys(e))
        if (!CONTRACT_COMMON.includes(k) && k !== 'gate' && typeof e[k] !== 'number')
          violate('audit 비수치 필드', `audit.${k}`);
    } else {
      const allowed = new Set([...CONTRACT_COMMON, ...spec.req, ...spec.opt]);
      for (const k of Object.keys(e)) if (!allowed.has(k)) observe('계약 밖 필드', `${e.event}.${k}`);
    }

    // 접두사 — 정규화의 고정점이어야 한다(정규화한 것을 다시 정규화해도 같다). 아니면 원문이 남은 것이다.
    if ('cmdPrefix' in e) {
      const p = e.cmdPrefix;
      if (typeof p !== 'string' || normalizeCmdPrefix(p) !== p) violate('cmdPrefix 비정규(원문 잔존)', e.event);
      if (p === UNPARSED_PREFIX) folded++;
    }
    // 타입·어휘 검사는 필드가 있을 때만 — 결손은 위에서 한 번만 센다.
    if (e.event === 'fire' || e.event === 'after') {
      if ('probe' in e && typeof e.probe !== 'boolean') violate('probe 비불리언', e.event);
      if ('decision' in e && !['deny', 'ask'].includes(e.decision)) violate('decision 어휘 밖', e.event);
    }
    if (e.event === 'stop') {
      if ('probe' in e || 'decision' in e || 'cmdPrefix' in e) violate('stop 에 판정·명령 필드');
    }
    if (e.event === 'pass') {
      if ('probe' in e || 'decision' in e) violate('pass 에 판정 필드');
      if (('promoted' in e) !== ('rule' in e) || ('promoted' in e && e.promoted !== true))
        violate('pass 의 promoted↔rule 불일치');
    }
    if (e.event === 'note') {
      if (!KNOWN_LABELS.includes(e.label)) violate('note.label 어휘 밖', String(e.label));
      if ('value' in e && typeof e.value !== 'number') violate('note.value 비수치');
    }
    if (typeof e.rule === 'string' && REGEX_META.test(e.rule)) observe('rule 이 패턴 원문(id 미부여)', e.event);

    // 원문 흔적 — 문자열 필드 전부. 식별자 필드(session·turn·call)는 제외, note.text 는 사람 서술이라 관찰로.
    for (const [k, v] of Object.entries(e)) {
      if (CONTRACT_IDS.includes(k) || typeof v !== 'string') continue;
      const marks = [];
      if (ABS_PATH.test(v)) marks.push('절대경로');
      if (UUID.test(v)) marks.push('UUID');
      if (user && v.includes(user)) marks.push('OS 사용자명');
      for (const m of marks) {
        if (e.event === 'note' && k === 'text') observe(`note.text 에 ${m}`);
        else violate(`원문 흔적(${m})`, `${e.event}.${k}`);
      }
    }
  }
  return { checked: events.length, folded, violations, observations };
}

const sumCounts = (bucket) => Object.values(bucket).reduce((n, b) => n + b.count, 0);

/** 리포트 말미의 요약 한 줄. 순수 함수. */
export function renderContractLine(a) {
  const v = sumCounts(a.violations);
  const o = sumCounts(a.observations);
  return v > 0
    ? `  ⚠️ 스키마 계약 위반 ${v}건 / ${a.checked} 검사 — --contract 로 내역 (값은 찍지 않습니다)`
    : `  (계약 — 스키마 위반 0 / ${a.checked} 검사` +
        (a.folded > 0 ? ` · (unparsed) 접힘 ${a.folded}` : '') +
        (o > 0 ? ` · 관찰 ${o}` : '') +
        ')';
}

/** --contract 내역. 순수 함수 — 문자열 배열. 값은 없고 건수·(이벤트.필드)만. */
export function renderContract(a) {
  const lines = [];
  const section = (title, bucket) => {
    const codes = Object.keys(bucket).sort();
    lines.push(`${title} ${sumCounts(bucket)}`);
    for (const c of codes) {
      const b = bucket[c];
      lines.push(`  ${c}: ${b.count}${b.where.length ? ` — ${b.where.sort().join(', ')}` : ''}`);
    }
  };
  section('위반', a.violations);
  section('관찰', a.observations);
  if (a.folded > 0) lines.push(`  (unparsed) 접힘 ${a.folded} — 판별 불가 접두사가 접힌 수, 위반 아님(짝짓기 열쇠에서 제외됨)`);
  return lines;
}

/**
 * v2 승격 후보 리포트 (docs/15 §4·§8 기준 1). 순수 함수 — 문자열 배열만 돌려준다.
 * ⭐ 후보 0 은 "후보 없음(부족한 축 명시)" 으로 표기한다 — 침묵은 판정이 아니다.
 */
export function promotionReport(config, events, records) {
  const g = (config && config.dangerGuard) || {};
  const slots = (config && config.promotion) || {};
  const lines = [];

  // 대상 = ask 규칙만. deny 는 데이터가 아무리 쌓여도 승격 불가 (docs/15 §3).
  const askIds = (g.ask || []).map((r) => r.id || String(r.pattern));
  if (g.shared && g.shared.targetPattern && g.shared.writePattern) askIds.push('shared');

  if (askIds.length === 0) {
    lines.push('후보 없음 — 설정에 ask 규칙이 없습니다 (deny 는 승격 대상이 아닙니다 — docs/15 §3)');
  }

  const ready = slotsReady(slots);
  for (const id of askIds) {
    const state = promotionStateFor(id, records, events, currentPatternOf(g, id));
    if (state.active) {
      const r = state.record;
      lines.push(`✔ ${id} — 승격 allow 중 (${String(r.ts).slice(0, 10)} · ${r.approvedBy})`);
      continue;
    }
    if (state.record) {
      lines.push(`✖ ${id} — 승격 실효: ${state.reason} (재승격은 스트릭 0 부터 — docs/15 §6)`);
      // 실효 뒤에도 후보 재판정은 아래에서 계속한다.
    }
    if (!ready) continue;
    const c = candidateFor(id, events, slots);
    if (c.qualified) {
      lines.push(
        `★ ${id} — 승격 후보: 스트릭 ${c.streak} · ${c.days}일 분산 · 지연 ${Math.min(...c.latencySeconds)}~${Math.max(...c.latencySeconds)}초` +
          (c.failures > 0 ? ` · 창 안 실패 ${c.failures}(스트릭 이전)` : '') +
          `\n    → 적용: --promote ${JSON.stringify(id)} --approved-by <이름> (승인 주체 1회 확인 — docs/15 §2)`,
      );
    } else {
      lines.push(
        `— ${id} — 후보 아님 (ask ${c.asks}건): ${c.lacking.join(' / ')}` +
          (c.lastFailureTs ? ` · 마지막 실패 ${String(c.lastFailureTs).slice(0, 10)}` : ''),
      );
    }
  }

  if (!ready && askIds.length > 0) {
    lines.push(
      '슬롯 미설정 — promotion.n(연속 무거부)·immediateSeconds(즉답 임계)·spreadDays(분산) 를 채우기 전에는',
      '  후보 판정을 하지 않습니다. 구조는 골격이 갖고 타이트함은 프로젝트가 잰다 (docs/15 §4 판별 질문).',
    );
  }
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const root = projectRoot();

  // ── 스키마 계약 자가 감사 — 내역 (docs/13 §3·§6) ─────────────────────────────
  if (argv.includes('--contract')) {
    const { events, broken } = readLog(root);
    const a = auditContract(events, { user: osUser() });
    const v = sumCounts(a.violations);
    process.stdout.write(
      `[metrics] 스키마 계약 검사 — 이벤트 ${a.checked}${broken > 0 ? ` · 깨진 줄 ${broken}(JSON 아님 — 계약 위반)` : ''} — ${logPath(root)}\n` +
        renderContract(a)
          .map((l) => `  ${l}`)
          .join('\n') +
        '\n' +
        (v > 0 || broken > 0
          ? `  → 위반은 골격 결함이거나 로그 손상입니다. 규범(docs/13 §3)이 아니라 코드를 의심하세요 — F26 의 선례.\n`
          : ''),
    );
    process.exit(v > 0 || broken > 0 ? 1 : 0);
  }

  // ── v2 승격 명령들 (docs/15) ──────────────────────────────────────────────
  if (argv.includes('--promotions')) {
    const loaded = await loadConfig(root);
    if (!loaded.ok) {
      process.stderr.write(`[metrics] 설정을 읽지 못했습니다 (${loaded.reason}) — ${loaded.path}\n`);
      process.exit(2);
    }
    const { events, broken } = readLog(root);
    const { records, broken: brokenRecords } = readPromotions(root);
    const lines = promotionReport(loaded.config, events, records);
    process.stdout.write(
      `[metrics] v2 승격 상태 — 레코드 ${records.length}${brokenRecords > 0 ? ` · 깨진 줄 ${brokenRecords}(무시=승격 없음)` : ''}` +
        `${broken > 0 ? ` · 로그 깨진 줄 ${broken}(제외)` : ''}\n` +
        lines.map((l) => `  ${l}`).join('\n') +
        '\n',
    );
    process.exit(0);
  }

  const promoteFlag = argv.indexOf('--promote');
  if (promoteFlag >= 0) {
    const ruleId = argv[promoteFlag + 1];
    const abFlag = argv.indexOf('--approved-by');
    const approvedBy = abFlag >= 0 ? argv[abFlag + 1] : undefined;
    if (!ruleId || ruleId.startsWith('--')) {
      process.stderr.write(`[metrics] --promote 에는 규칙 id 가 필요합니다\n`);
      process.exit(2);
    }
    if (!approvedBy || approvedBy.startsWith('--')) {
      process.stderr.write(
        `[metrics] --approved-by <이름> 이 필요합니다 — 승인 주체의 1회 확인이 적용의 실체입니다 (docs/15 §2)\n`,
      );
      process.exit(2);
    }
    const loaded = await loadConfig(root);
    if (!loaded.ok) {
      process.stderr.write(`[metrics] 설정을 읽지 못했습니다 (${loaded.reason}) — ${loaded.path}\n`);
      process.exit(2);
    }
    const g = loaded.config.dangerGuard || {};
    const askIds = (g.ask || []).map((r) => r.id || String(r.pattern));
    if (g.shared && g.shared.targetPattern && g.shared.writePattern) askIds.push('shared');
    if (!askIds.includes(ruleId)) {
      process.stderr.write(
        `[metrics] ${ruleId} 는 ask 규칙이 아닙니다 — deny 는 데이터가 아무리 쌓여도 승격 불가입니다 (docs/15 §3).\n` +
          `  deny 를 옮기려면 승격이 아니라 규칙 재분류(사람의 정책 결정)입니다.\n`,
      );
      process.exit(2);
    }
    const slots = loaded.config.promotion;
    if (!slotsReady(slots)) {
      process.stderr.write(
        `[metrics] promotion 슬롯(n·immediateSeconds·spreadDays)이 채워지지 않았습니다 — 판정 기준 없이 승격할 수 없습니다.\n`,
      );
      process.exit(2);
    }
    const { events } = readLog(root);
    const c = candidateFor(ruleId, events, slots);
    if (!c.qualified) {
      // ⭐ 후보가 아닌 것은 승인 주체라도 이 경로로는 승격 못 한다 — 기준 우회를 구조로 막는다.
      process.stderr.write(
        `[metrics] ${ruleId} 는 승격 후보가 아닙니다: ${c.lacking.join(' / ')}\n` +
          `  기준을 낮춰 후보를 만드는 것은 승격이 아니라 기준 붕괴입니다 (docs/15 §4).\n`,
      );
      process.exit(2);
    }
    const record = {
      ts: new Date().toISOString(),
      rule: ruleId,
      approvedBy,
      pattern: currentPatternOf(g, ruleId),
      // 근거 스냅샷 — "왜 승격했더라" 를 로그 재집계 없이 답한다 (docs/15 §5).
      evidence: {
        streak: c.streak,
        days: c.days,
        latencySeconds: c.latencySeconds,
        asks: c.asks,
      },
      // 기본 강등 조건 3종 — 추가는 가능해도 이 3종을 빼지는 못한다 (docs/15 §6).
      demotion: {
        onNoteLabels: ['false-positive', 'false-green', 'incident'],
        manual: true,
        onPatternChange: true,
      },
    };
    if (!appendPromotion(record, root)) process.exit(2);
    logEvent({ event: 'note', label: 'promoted', rule: ruleId, text: `by ${approvedBy}` }, root);
    process.stdout.write(
      `[metrics] 승격 적용 — ${ruleId} → allow (레코드 기록·승인 ${approvedBy})\n` +
        `  강등 조건: 사고·오탐·거짓그린 note(--note <label> --rule ${JSON.stringify(ruleId)}) 1건 · 수동 --demote · 규칙 정의 변경 → 즉시 ask 복귀\n`,
    );
    process.exit(0);
  }

  const demoteFlag = argv.indexOf('--demote');
  if (demoteFlag >= 0) {
    const ruleId = argv[demoteFlag + 1];
    const textFlag = argv.indexOf('--text');
    const text = textFlag >= 0 ? argv[textFlag + 1] : undefined;
    if (!ruleId || ruleId.startsWith('--')) {
      process.stderr.write(`[metrics] --demote 에는 규칙 id 가 필요합니다\n`);
      process.exit(2);
    }
    if (!text || text.startsWith('--')) {
      process.stderr.write(`[metrics] --text "사유" 가 필요합니다 — 사유 없는 강등은 다음 재승격 판단을 망칩니다 (docs/15 §6 ⓑ)\n`);
      process.exit(2);
    }
    const ok = logEvent({ event: 'note', label: 'demoted', rule: ruleId, text }, root);
    process.stdout.write(
      ok
        ? `[metrics] 수동 강등 기록 — ${ruleId} 는 즉시 ask 로 복귀합니다 (재승격은 스트릭 0 부터)\n`
        : `[metrics] 기록 실패\n`,
    );
    process.exit(ok ? 0 : 2);
  }

  const noteFlag = argv.indexOf('--note');
  if (noteFlag >= 0) {
    const label = argv[noteFlag + 1];
    if (!label || label.startsWith('--')) {
      process.stderr.write(`[metrics] --note 에는 라벨이 필요합니다 (${KNOWN_LABELS.join(' · ')})\n`);
      process.exit(2);
    }
    if (!KNOWN_LABELS.includes(label)) {
      // 기록은 한다 — 어휘 확장일 수 있다. 다만 오타면 집계에서 조용히 빠지므로 보이게 알린다.
      process.stderr.write(`[metrics] 알려진 라벨이 아닙니다: ${label} — 오타라면 집계에 안 잡힙니다.\n`);
    }
    const valueFlag = argv.indexOf('--value');
    const textFlag = argv.indexOf('--text');
    const ruleFlag = argv.indexOf('--rule');
    const value = valueFlag >= 0 ? Number(argv[valueFlag + 1]) : undefined;
    const text = textFlag >= 0 ? argv[textFlag + 1] : undefined;
    const rule = ruleFlag >= 0 ? argv[ruleFlag + 1] : undefined;
    const ok = logEvent(
      {
        event: 'note',
        label,
        ...(Number.isFinite(value) ? { value } : {}),
        ...(text ? { text } : {}),
        ...(rule && !rule.startsWith('--') ? { rule } : {}),
      },
      root,
    );
    const demotes = rule && DEMOTION_NOTE_LABELS.includes(label);
    process.stdout.write(
      ok
        ? `[metrics] note 기록됨 — ${label}${demotes ? ` (규칙 ${rule} 의 승격이 있었다면 즉시 실효)` : ''}\n`
        : `[metrics] 기록 실패\n`,
    );
    process.exit(ok ? 0 : 2);
  }

  const { events, broken } = readLog(root);
  if (events.length === 0) {
    process.stdout.write(
      `[metrics] 이벤트 없음 — ${logPath(root)}\n` +
        `  '지표 전부 0' 이 아니라 '아직 아무것도 기록되지 않음' 입니다.\n` +
        `  게이트가 훅으로 연결돼 있고 실제 도구 호출이 지나갔는지 확인하세요 (bootstrap §3).\n`,
    );
    process.exit(0);
  }
  let window = null;
  try {
    window = parseWindow(argv);
  } catch (err) {
    process.stderr.write(`[metrics] 기간 창 오류 — ${err.message}\n  창 없이 누적을 내지 않습니다 (기준선을 잘못 잡는 쪽이 더 나쁘다).\n`);
    process.exit(2);
  }
  const s = summarize(events, { window });
  // 리포트마다 계약 검사를 얹는다 — 반출 금지 데이터는 아무도 안 열어 보므로, 보는 주기를 따로 만들지 않고
  // 이미 있는 주기에 붙인다 (docs/13 §3 · F26).
  const a = auditContract(events, { user: osUser() });
  process.stdout.write(
    `[metrics] 이벤트 ${events.length}${broken > 0 ? ` · 깨진 줄 ${broken}(제외)` : ''} — ${logPath(root)}\n` +
      render(s) +
      '\n' +
      renderContractLine(a) +
      '\n',
  );
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('metrics.mjs')) {
  main().catch((e) => {
    process.stderr.write(`[metrics] 리포트를 만들지 못했습니다: ${e.message}\n`);
    process.exit(2);
  });
}
