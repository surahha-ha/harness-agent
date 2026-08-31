/**
 * v2 위임 승격 — 승격 레코드 층 (`docs/15-v2-promotion-design.md` §5·§6).
 *
 * 승격(ask→allow)의 실체는 설정 편집이 아니라 **레코드 1건**이고, 가드가 판정 시 해석한다.
 * 강등 조건 충족이 감지되면 레코드를 무시하고 ask 로 판정한다 — 강등에 설정 편집이
 * 필요 없다 = 자동·즉시가 코드 경로로 보장된다.
 *
 * ⭐ 판정 방향은 언제나 보수적이다: 레코드를 못 읽거나 판별이 서지 않으면 **승격 없음**(ask 유지).
 *    승격은 편의이고 ask 는 원래 판정이다 — 실패가 판정을 느슨하게 만들면 안 된다.
 *
 * ⚠️ `promotions.jsonl` 은 `log.jsonl` 과 동일하게 **반출 금지**다 (규칙 사유·프로젝트
 *    고유값 포함) — 부트스트랩 ① 의 `.gitignore` 단계에 함께 등록한다.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { LOG_DIR, isPairablePrefix } from './log.mjs';

export const PROMOTIONS_NAME = 'promotions.jsonl';

/** 이 라벨의 note 가 해당 규칙을 가리키면(rule 필드 일치) 승격이 즉시 실효된다 — docs/15 §6 ⓐⓑ. */
export const DEMOTION_NOTE_LABELS = ['false-positive', 'false-green', 'incident', 'demoted'];

export function promotionsPath(root = projectRoot()) {
  return path.join(root, LOG_DIR, PROMOTIONS_NAME);
}

/** 레코드 전체를 읽는다. 깨진 줄은 세되 건너뛴다 — 못 읽으면 승격 없음(보수 방향). */
export function readPromotions(root = projectRoot()) {
  let raw;
  try {
    raw = readFileSync(promotionsPath(root), 'utf8');
  } catch {
    return { records: [], broken: 0 };
  }
  const records = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      broken++;
    }
  }
  return { records, broken };
}

/**
 * 레코드 한 건을 append 한다. 로그와 달리 **fail-open 이 아니다** — 승격 적용이 곧
 * 이 기록이므로, 기록 실패 = 적용 실패다.
 * @returns {boolean}
 */
export function appendPromotion(record, root = projectRoot()) {
  try {
    mkdirSync(path.join(root, LOG_DIR), { recursive: true });
    appendFileSync(promotionsPath(root), JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (e) {
    process.stderr.write(`[promotions] 레코드 기록 실패 — ${e.message}\n`);
    return false;
  }
}

/**
 * 레코드 유효성 — 순수 함수. ⭐**강등 조건 필드가 비면 무효다** (docs/15 §5):
 * "강등 없는 승격 금지" 를 절차가 아니라 구조로 강제한다.
 * @returns {{valid: boolean, reason?: string}}
 */
export function recordValidity(record) {
  if (!record || typeof record !== 'object') return { valid: false, reason: '레코드가 객체가 아닙니다' };
  if (!record.rule) return { valid: false, reason: 'rule(규칙 id)이 없습니다' };
  if (!record.ts) return { valid: false, reason: 'ts(승격 시점)가 없습니다' };
  if (!record.approvedBy) return { valid: false, reason: 'approvedBy(승인 주체 확인)가 없습니다' };
  if (!record.evidence || typeof record.evidence !== 'object')
    return { valid: false, reason: 'evidence(근거 스냅샷)가 없습니다' };
  const d = record.demotion;
  const hasCondition =
    d &&
    typeof d === 'object' &&
    ((Array.isArray(d.onNoteLabels) && d.onNoteLabels.length > 0) ||
      d.manual === true ||
      d.onPatternChange === true);
  if (!hasCondition)
    return { valid: false, reason: '강등 조건이 비어 있습니다 — 강등 없는 승격은 무효입니다 (docs/15 §5)' };
  return { valid: true };
}

/** 설정에서 규칙 id 의 현행 패턴 표기를 얻는다 — 강등 조건 ⓒ(정의 변경 시 실효)의 비교 기준. */
export function currentPatternOf(dangerGuard, ruleId) {
  const g = dangerGuard || {};
  for (const decision of ['ask', 'deny']) {
    for (const rule of g[decision] || []) {
      if ((rule.id || String(rule.pattern)) === ruleId) return String(rule.pattern);
    }
  }
  const s = g.shared || {};
  if (ruleId === 'shared' && s.targetPattern && s.writePattern) {
    return `${String(s.targetPattern)} ∩ ${String(s.writePattern)}`;
  }
  return null;
}

/**
 * 규칙 하나의 승격 상태 — 순수 함수. 가드와 리포트가 같은 판정을 쓴다.
 *
 * 강등 3종(docs/15 §6, 빼기 불가):
 *  ⓐ 사고·오탐·거짓 그린 note (rule 일치, 승격 이후) → 즉시 실효
 *  ⓑ 수동 강등 note(label: demoted) → 즉시 실효
 *  ⓒ 규칙 정의(패턴) 변경 → 자동 실효 (바뀐 규칙은 다른 규칙이다)
 *
 * @param {string} ruleId
 * @param {object[]} records promotions.jsonl 의 레코드들
 * @param {object[]} events log.jsonl 의 이벤트들 (note 를 본다)
 * @param {string|null} currentPattern 설정의 현행 패턴 표기 (null = 규칙이 설정에 없음)
 * @returns {{active: boolean, record?: object, reason: string}}
 */
export function promotionStateFor(ruleId, records, events, currentPattern) {
  const mine = (records || []).filter((r) => r && r.rule === ruleId);
  if (mine.length === 0) return { active: false, reason: '승격 레코드 없음' };
  // 최신 레코드 하나만 본다 — 승격은 규칙당 상태 하나다.
  const record = mine.reduce((a, b) => (String(a.ts) >= String(b.ts) ? a : b));
  const v = recordValidity(record);
  if (!v.valid) return { active: false, record, reason: `레코드 무효 — ${v.reason}` };
  if (currentPattern === null)
    return { active: false, record, reason: '강등 ⓒ — 규칙이 설정에 없습니다 (제거 또는 id 변경)' };
  if (record.pattern !== undefined && String(record.pattern) !== String(currentPattern))
    return { active: false, record, reason: '강등 ⓒ — 규칙 정의가 승격 시점과 다릅니다' };
  const labels = new Set(
    Array.isArray(record.demotion?.onNoteLabels) ? record.demotion.onNoteLabels : [],
  );
  if (record.demotion?.manual === true) labels.add('demoted');
  const trigger = (events || []).find(
    (e) =>
      e.event === 'note' &&
      e.rule === ruleId &&
      labels.has(e.label) &&
      String(e.ts) > String(record.ts),
  );
  if (trigger)
    return {
      active: false,
      record,
      reason: `강등 ${trigger.label === 'demoted' ? 'ⓑ 수동' : `ⓐ ${trigger.label}`} — ${trigger.ts}`,
    };
  return { active: true, record, reason: '유효' };
}

/**
 * 승격 후보 판정 — 4축 (docs/15 §4). 순수 함수.
 *
 * 스트릭 = 창(마지막 강등 note 이후) 안에서, **끝에서부터 연속으로 승인된** fire(ask) 들.
 * after 부재(거부/이탈/훅 미발화 — 구분 불가)는 전부 실패로 세어 스트릭을 리셋한다 —
 * 구분 불가를 승격에 유리하게 해석하지 않는다 (docs/15 §7).
 *
 * @param {string} ruleId
 * @param {object[]} events log.jsonl 이벤트들
 * @param {{n:number, immediateSeconds:number, spreadDays:number}} slots 프로젝트가 채운 임계값
 * @returns {{qualified: boolean, lacking: string[], streak: number, days: number,
 *            latencySeconds: number[], failures: number, lastFailureTs: string|null,
 *            windowStart: string|null, asks: number}}
 */
export function candidateFor(ruleId, events, slots) {
  const sorted = [...(events || [])].sort((x, y) => String(x.ts).localeCompare(String(y.ts)));

  // 강등 후 재승격은 스트릭 0 부터 (docs/15 §6) — 창은 마지막 강등성 note 다음에서 열린다.
  const demotions = sorted.filter(
    (e) => e.event === 'note' && e.rule === ruleId && DEMOTION_NOTE_LABELS.includes(e.label),
  );
  const windowStart = demotions.length > 0 ? String(demotions[demotions.length - 1].ts) : null;

  const fires = sorted.filter(
    (e) =>
      e.event === 'fire' &&
      e.decision === 'ask' &&
      !e.probe &&
      e.rule === ruleId &&
      (windowStart === null || String(e.ts) > windowStart),
  );
  const afters = sorted.filter((e) => e.event === 'after' && !e.probe);

  // 승인 근사 짝짓기 — metrics.summarize 와 같은 규칙 (같은 접두사·이후·1회용).
  const consumed = new Set();
  const paired = fires.map((f) => {
    // 열쇠가 될 수 없는 접두사는 짝을 찾지 않는다 — 스트릭이 짧아지는 방향(승격 지연)이다.
    const hit = isPairablePrefix(f.cmdPrefix)
      ? afters.findIndex(
          (a, i) => !consumed.has(i) && a.cmdPrefix === f.cmdPrefix && String(a.ts) >= String(f.ts),
        )
      : -1;
    if (hit < 0) return { fire: f, approved: false, latencyMs: null };
    consumed.add(hit);
    return { fire: f, approved: true, latencyMs: Date.parse(afters[hit].ts) - Date.parse(f.ts) };
  });

  // 끝에서부터 연속 승인 = 스트릭. 실패 1건이 카운터를 0 으로 리셋하는 것과 동치다.
  const streakPairs = [];
  for (let i = paired.length - 1; i >= 0 && paired[i].approved; i--) streakPairs.unshift(paired[i]);
  const failures = paired.filter((p) => !p.approved);
  const latencySeconds = streakPairs
    .map((p) => (Number.isFinite(p.latencyMs) ? Math.round(p.latencyMs / 1000) : null))
    .filter((x) => x !== null);
  const days = new Set(streakPairs.map((p) => String(p.fire.ts).slice(0, 10)));

  const n = slots?.n;
  const t = slots?.immediateSeconds;
  const m = slots?.spreadDays;
  const lacking = [];
  if (!(streakPairs.length >= n)) lacking.push(`축1 연속 무거부 — 스트릭 ${streakPairs.length}/${n}`);
  // 축2(실패 한도 0)는 스트릭 정의에 내장 — 창 안 실패는 스트릭 밖으로만 남는다(아래 failures 로 보고).
  if (!(latencySeconds.length > 0 && latencySeconds.some((s) => s >= t)))
    lacking.push(
      streakPairs.length === 0
        ? `축3 습관적 승인 배제 — 잴 승인이 없습니다`
        : `축3 습관적 승인 배제 — 전부 ${t}초 미만 즉답 (안 읽음 신호)`,
    );
  if (!(days.size >= m)) lacking.push(`축4 분산 — ${days.size}/${m}일`);

  return {
    qualified: lacking.length === 0,
    lacking,
    streak: streakPairs.length,
    days: days.size,
    latencySeconds,
    failures: failures.length,
    lastFailureTs: failures.length > 0 ? failures[failures.length - 1].fire.ts : null,
    windowStart,
    asks: fires.length,
  };
}

/** 슬롯 3종이 전부 유한 양수인가 — 아니면 후보 판정 자체를 하지 않는다 (구조만 있고 타이트함 미정). */
export function slotsReady(promotion) {
  const p = promotion || {};
  return [p.n, p.immediateSeconds, p.spreadDays].every((v) => Number.isFinite(v) && v > 0);
}
