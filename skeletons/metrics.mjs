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
 *   node skeletons/metrics.mjs                                  # 지표 5종 리포트
 *   node skeletons/metrics.mjs --note <label> [--value N] [--text "..."]   # 사람 라벨 기록
 *     label: false-positive(오탐 확정) · false-green(거짓 그린 감사) · bootstrap-minutes(부트스트랩 소요)
 *
 * 종료코드: 0 리포트/기록 완료 · 2 도구 오류
 */

import { logEvent, readLog, logPath } from './lib/log.mjs';
import { projectRoot } from './lib/config.mjs';

/** 사람 라벨의 알려진 어휘 — 지표 집계가 문자열 일치에 걸리므로 오타를 보이게 한다. */
export const KNOWN_LABELS = ['false-positive', 'false-green', 'bootstrap-minutes'];

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
export function summarize(events) {
  const sorted = [...events].sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  const fires = sorted.filter((e) => e.event === 'fire' && !e.probe);
  const probes = sorted.filter((e) => (e.event === 'fire' || e.event === 'after') && e.probe);
  const passes = sorted.filter((e) => e.event === 'pass');
  const afters = sorted.filter((e) => e.event === 'after' && !e.probe);
  const notes = sorted.filter((e) => e.event === 'note');
  const tfAudits = sorted.filter((e) => e.event === 'audit' && e.gate === 'test-first');
  const driftAudits = sorted.filter((e) => e.event === 'audit' && e.gate === 'drift-watch');

  // 지표 2 — ask 발동마다, 그 뒤 같은 접두사의 after 하나를 짝짓는다(한 번 쓴 after 는 재사용 금지).
  const consumed = new Set();
  let approved = 0;
  const asks = fires.filter((e) => e.decision === 'ask');
  for (const ask of asks) {
    const hit = afters.findIndex(
      (a, i) =>
        !consumed.has(i) && a.cmdPrefix === ask.cmdPrefix && String(a.ts) >= String(ask.ts),
    );
    if (hit >= 0) {
      consumed.add(hit);
      approved++;
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
  const bootstrapMinutes = notes
    .filter((n) => n.label === 'bootstrap-minutes' && Number.isFinite(n.value))
    .map((n) => n.value);

  return {
    completion: {
      audits: tfAudits.length,
      first: tfAudits[0] ?? null,
      last: tfAudits[tfAudits.length - 1] ?? null,
    },
    intervention: { asks: asks.length, approved, unresolved: asks.length - approved },
    gap: { fires: fires.length, medianMinutes: median(gaps) },
    gate: {
      fires: fires.length,
      denies: fires.filter((e) => e.decision === 'deny').length,
      asks: asks.length,
      falsePositives,
      denominator: passes.length + fires.length,
    },
    cost: { bootstrapMinutes, pass: passes.length, fire: fires.length },
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

  lines.push(
    `1 완주율        ` +
      (s.completion.audits >= 2
        ? `test-first audit ${s.completion.audits}회 — 테스트 없음 ${s.completion.first.missing} → ${s.completion.last.missing}` +
          (s.completion.last.missing === 0 ? ' (닫힘)' : '')
        : missing(`test-first audit 이벤트가 ${s.completion.audits}개 — 시계열엔 2개 이상이 필요합니다`)),
  );
  lines.push(
    `2 개입 분해      ` +
      (s.intervention.asks > 0
        ? `ask 발동 ${s.intervention.asks} · 승인(근사) ${s.intervention.approved} · 거부/이탈(구분 불가) ${s.intervention.unresolved}`
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
          ` · 분모(검사 총량) ${s.gate.denominator}`
        : missing('게이트를 지난 명령이 아직 없습니다 — 훅 연결을 확인하세요(설정≠연결)')),
  );
  lines.push(
    `5 비용/작업      ` +
      (s.cost.bootstrapMinutes.length > 0
        ? `부트스트랩 ${s.cost.bootstrapMinutes.join('·')}분 (${s.cost.bootstrapMinutes.length}점) · 검사 pass ${s.cost.pass} · 발동 ${s.cost.fire}`
        : missing('bootstrap-minutes 라벨이 없습니다 — --note bootstrap-minutes --value N 으로 기록하세요')),
  );
  if (s.probesExcluded > 0) lines.push(`  (프로브 ${s.probesExcluded}건은 전 지표에서 제외)`);
  if (s.driftAudits.count > 0) {
    const d = s.driftAudits.last;
    lines.push(`  (부가 — drift-watch 검사 ${s.driftAudits.count}회 · 최근 새 차이 ${d.fresh})`);
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const root = projectRoot();

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
    const value = valueFlag >= 0 ? Number(argv[valueFlag + 1]) : undefined;
    const text = textFlag >= 0 ? argv[textFlag + 1] : undefined;
    const ok = logEvent(
      {
        event: 'note',
        label,
        ...(Number.isFinite(value) ? { value } : {}),
        ...(text ? { text } : {}),
      },
      root,
    );
    process.stdout.write(ok ? `[metrics] note 기록됨 — ${label}\n` : `[metrics] 기록 실패\n`);
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
  const s = summarize(events);
  process.stdout.write(
    `[metrics] 이벤트 ${events.length}${broken > 0 ? ` · 깨진 줄 ${broken}(제외)` : ''} — ${logPath(root)}\n` +
      render(s) +
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
