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
 *   node skeletons/metrics.mjs --note <label> [--value N] [--text "..."] [--rule <id>]  # 사람 라벨 기록
 *     label: false-positive(오탐 확정) · false-green(거짓 그린 감사) · bootstrap-minutes(부트스트랩 소요)
 *            incident(사고) · promoted/demoted(승격·강등 사실 — 보통 아래 명령이 대신 남긴다)
 *     ⚠️ 오탐·사고 note 에 --rule 을 붙이면 그 규칙의 승격을 즉시 실효시킨다 (docs/15 §6 ⓐ).
 *   node skeletons/metrics.mjs --promotions                     # v2 승격 후보 리포트 + 레코드 상태
 *   node skeletons/metrics.mjs --promote <규칙id> --approved-by <이름>   # 후보 승격 적용(레코드 작성)
 *   node skeletons/metrics.mjs --demote <규칙id> --text "사유"           # 수동 강등 (docs/15 §6 ⓑ)
 *
 * 종료코드: 0 리포트/기록 완료 · 2 도구 오류
 */

import { logEvent, readLog, logPath } from './lib/log.mjs';
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
export function summarize(events) {
  const sorted = [...events].sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  const fires = sorted.filter((e) => e.event === 'fire' && !e.probe);
  const probes = sorted.filter((e) => (e.event === 'fire' || e.event === 'after') && e.probe);
  const passes = sorted.filter((e) => e.event === 'pass');
  const afters = sorted.filter((e) => e.event === 'after' && !e.probe);
  const notes = sorted.filter((e) => e.event === 'note');
  // ⭐ 경계표가 비어 있던 audit(inScope 0)은 완주율 시계열에서 뺀다 — "잰 것이 없어 미달 0"
  //    을 "다 닫혀서 미달 0" 으로 읽으면 완주율이 거짓 그린이 된다 (3회차 실적용에서 실측된 결함).
  const tfAudits = sorted.filter(
    (e) => e.event === 'audit' && e.gate === 'test-first' && e.inScope > 0,
  );
  const emptyAudits = sorted.filter(
    (e) => e.event === 'audit' && e.gate === 'test-first' && !(e.inScope > 0),
  ).length;
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
      emptyAudits,
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
  if (s.promotedPasses > 0)
    lines.push(`  (부가 — 승격 allow 매치 ${s.promotedPasses}건 · --promotions 로 상태 확인)`);
  if (s.driftAudits.count > 0) {
    const d = s.driftAudits.last;
    lines.push(`  (부가 — drift-watch 검사 ${s.driftAudits.count}회 · 최근 새 차이 ${d.fresh})`);
  }
  return lines.join('\n');
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
