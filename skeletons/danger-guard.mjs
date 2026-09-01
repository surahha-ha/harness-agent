#!/usr/bin/env node
/**
 * 골격 1 — 위험 명령 가드 (설정 주도).
 *
 * 규칙은 이 파일에 없다. 전부 `harness.config.mjs` 의 `dangerGuard` 에서 온다.
 * 이 파일은 **판정 구조**(deny/ask 2단계 · 공유 자원 교집합 · 복구 경로 · 활성 확인)만 갖는다.
 *
 * 성격: 차단 게이트라 **fail-closed**. 설정을 못 읽으면 통과시키지 않고 알린다.
 *       조용히 통과시키면 "가드 없음" 과 "위반 없음" 이 똑같이 보인다.
 *
 * ⚠️ 한계 — 패턴 판정은 변수 치환·개행·별칭으로 우회된다.
 *    **보안 경계가 아니라 실수 방지 장치**다. 악의를 막는 용도로 소개하면 안 된다.
 *    스크립트 파일 안에 든 명령도 보지 못한다(판정 단위가 명령 문자열이라).
 *
 * 사용:
 *   (훅) stdin 으로 도구 입력 JSON 을 받는다 — PreToolUse 에 건다
 *   node skeletons/danger-guard.mjs --post           # PostToolUse 훅 — ask 후 실제 실행을 `after` 로 기록
 *   node skeletons/danger-guard.mjs --cmd "<명령>"   # 단건 판정 (점검용 — 계측 로그에 안 남는다)
 *   node skeletons/danger-guard.mjs --status         # 활성 확인 (설정·규칙 수)
 *
 * 계측: 훅 경로의 판정은 `.harness/log.jsonl` 에 fire/pass 로 남는다 (docs/13 §2·§3).
 * 승격: `.harness/promotions.jsonl` 의 유효 레코드가 있는 ask 규칙은 allow 로 통과하되
 *       pass(rule·promoted) 로 계속 기록된다. 강등 조건 충족 시 자동으로 ask 복귀 (docs/15 §5·§6).
 *
 * 종료코드: 0 판정 완료(통과 포함) · 2 가드 오류
 */

import { loadConfig, compile, emitDecision, readStdin, CONFIG_NAME } from './lib/config.mjs';
import { logEvent, normalizeCmdPrefix, readLog, extractContext } from './lib/log.mjs';
import { readPromotions, promotionStateFor, currentPatternOf } from './lib/promotions.mjs';

/** 기본 복구 문구 — 규칙에 `recover` 가 없을 때. 없는 것보다는 낫지만 규칙마다 적는 편이 훨씬 낫다. */
const DEFAULT_RECOVER = {
  deny: '다른 방법으로 목적을 이룰 수 있는지 먼저 보고, 정말 필요하면 승인 주체에게 요청하거나 규칙을 고치세요.',
  ask: '그대로 진행해도 되는 상황인지 확인하고, 남길 것이 있으면 먼저 보존하세요.',
};

/**
 * 명령 하나를 판정한다. 순수 함수 — 이 함수 자체를 테스트한다.
 * `rule` 은 로그의 규칙 식별자다(id 가 없으면 패턴 문자열) — `docs/13-v1-eval-design.md` §5.
 * @param {string} command
 * @param {object} config 하네스 설정 전체
 * @returns {{decision:'deny'|'ask', why:string, recover:string, rule:string, probe:boolean}|null}
 */
export function evaluate(command, config) {
  const g = (config && config.dangerGuard) || {};
  if (g.enabled === false) return null;
  if (!command || !command.trim()) return null;

  // ⭐ 프로브 — 아무것도 막지 않는 검증 전용 표식 (F13). 실규칙보다 먼저 본다:
  //    프로브 명령은 무해하도록 설계되므로 실규칙에 걸릴 일이 없어야 하고,
  //    걸린다면 그 프로브는 기준 위반이다(무해하지 않다는 뜻).
  if (g.probe && typeof g.probe.token === 'string' && g.probe.token && command.includes(g.probe.token)) {
    return {
      decision: 'deny',
      probe: true,
      rule: 'probe',
      why: g.probe.why || '검증 전용 프로브 규칙입니다 — 이 차단이 곧 발동 검증 성공입니다.',
      recover: g.probe.recover || '아무것도 막지 않았습니다. 이 서명이 떴다면 가드가 살아 있습니다.',
    };
  }

  // deny 가 ask 보다 먼저다 — 더 강한 판정이 이긴다.
  for (const decision of ['deny', 'ask']) {
    for (const rule of g[decision] || []) {
      const c = compile(rule.pattern);
      if (c.error) {
        // 규칙 하나가 깨졌다고 나머지를 버리지 않는다. 다만 조용히 넘기지도 않는다.
        process.stderr.write(`[danger-guard] ${c.error}\n`);
        continue;
      }
      if (c.re.test(command)) {
        return {
          decision,
          probe: false,
          rule: rule.id || String(rule.pattern),
          why: rule.why || '설정에 사유가 적혀 있지 않습니다.',
          recover: rule.recover || DEFAULT_RECOVER[decision],
        };
      }
    }
  }

  // 공유 자원 — "공유 대상" 과 "쓰기 구문" 의 **교집합**일 때만 잡는다.
  // 둘 중 하나만으로 판정하면 조회까지 막히거나(과잉) 쓰기를 놓친다(과소).
  const s = g.shared || {};
  if (s.targetPattern && s.writePattern) {
    const t = compile(s.targetPattern, 'i');
    const w = compile(s.writePattern, 'i');
    if (!t.error && !w.error && t.re.test(command) && w.re.test(command)) {
      return {
        decision: 'ask',
        probe: false,
        rule: 'shared',
        why: s.why || '공유 환경에 쓰기를 실행합니다.',
        recover: s.recover || DEFAULT_RECOVER.ask,
      };
    }
  }

  return null;
}

/**
 * 활성 상태 판정 — 네 가지를 구분한다. 순수 함수라 테스트할 수 있다.
 *
 * ⭐ `empty` 를 `active` 와 구분하는 것이 핵심이다. 설정이 있다는 이유로 "활성" 이라 보고하면
 *    아무것도 막지 않는데 보호받는다고 믿게 된다 — **미설치보다 나쁘다.**
 *    미설치는 의심이라도 하지만, 거짓 활성은 안심시킨다.
 *
 * ⭐ 프로브는 실규칙 수와 **분리해 센다** (F13 승격 — `docs/13-v1-eval-design.md` §5).
 *    프로브가 규칙 수를 채워 `active` 로 보이면 거짓 활성의 재발이다 —
 *    실규칙 0 + 프로브 1 은 `empty` 다 (발동 검증은 되지만 아무것도 안 막는다).
 *
 * @returns {{state:'off'|'empty'|'active', deny:number, ask:number, shared:boolean, probe:boolean}}
 */
export function statusOf(config) {
  const g = (config && config.dangerGuard) || {};
  const deny = (g.deny || []).length;
  const ask = (g.ask || []).length;
  const shared = !!(g.shared && g.shared.targetPattern && g.shared.writePattern);
  const probe = !!(g.probe && typeof g.probe.token === 'string' && g.probe.token);
  if (g.enabled === false) return { state: 'off', deny, ask, shared, probe };
  if (deny + ask === 0 && !shared) return { state: 'empty', deny, ask, shared, probe };
  return { state: 'active', deny, ask, shared, probe };
}

/** 훅 입력에서 명령 문자열을 꺼낸다. 파싱 실패 시 원문 전체를 훑는다(fail-closed 쪽). */
export function extractCommand(raw) {
  try {
    const parsed = JSON.parse(raw);
    const cmd = parsed?.tool_input?.command;
    if (typeof cmd === 'string') return cmd;
  } catch {
    /* 원문으로 폴백 */
  }
  return raw;
}

function reasonFor(hit) {
  const head = hit.decision === 'deny' ? '차단됨' : '확인 필요';
  return `${head} — ${hit.why}\n→ ${hit.recover}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const loaded = await loadConfig();

  if (argv.includes('--status')) {
    if (!loaded.ok) {
      process.stdout.write(
        `[danger-guard] 비활성 — ${CONFIG_NAME} 를 읽지 못했습니다 (${loaded.reason})\n  경로: ${loaded.path}\n`,
      );
      process.exit(2);
    }
    const s = statusOf(loaded.config);
    // 위임 승격(v2)은 활성 확인에 보인다 — allow 로 도는 규칙이 몇인지 모르면 활성 확인이 아니다.
    const { records } = readPromotions();
    let promotedActive = 0;
    if (records.length > 0) {
      const { events } = readLog();
      const ruleIds = new Set(records.map((r) => r && r.rule).filter(Boolean));
      for (const id of ruleIds) {
        if (
          promotionStateFor(id, records, events, currentPatternOf(loaded.config.dangerGuard, id))
            .active
        )
          promotedActive++;
      }
    }
    const detail =
      `deny ${s.deny} · ask ${s.ask} · 공유자원 규칙 ${s.shared ? '설정됨' : '없음'}` +
      ` · 프로브 ${s.probe ? '설정됨' : '없음'}` +
      (records.length > 0 ? ` · 승격 allow ${promotedActive}/${records.length}레코드` : '');
    const line = {
      off: `[danger-guard] 꺼짐 — enabled:false 입니다 (${detail})\n`,
      empty:
        `[danger-guard] 설정됨 · 규칙 없음 — 아무것도 막지 않습니다\n` +
        `  부트스트랩 §2 의 판별 질문("실행 후 5분 안에 원상복구할 수단이 있나?")으로 2~3개만 채우세요.\n`,
      active: `[danger-guard] 활성 — ${detail}\n`,
    }[s.state];
    process.stdout.write(line + `  설정: ${loaded.path}\n`);
    process.exit(s.state === 'active' ? 0 : 1);
  }

  if (!loaded.ok) {
    // 설정이 없으면 판정할 수 없다. 통과시키되 **반드시 보이게** 남긴다.
    process.stderr.write(
      `[danger-guard] 가드가 동작하지 않았습니다 — ${CONFIG_NAME} (${loaded.reason}).\n` +
        `  '위반 없음' 이 아니라 '검사하지 않음' 입니다. --status 로 확인하세요.\n`,
    );
    process.exit(2);
  }

  // PostToolUse — ask 발동 뒤 같은 명령이 실제 실행됐다는 행동적 신호를 `after` 로 남긴다.
  // 사람 응답 4갈래를 직접 볼 수 없는 훅의 근사다 (docs/13 §2 — 근사임을 리포트도 표기한다).
  if (argv.includes('--post')) {
    const raw = readStdin();
    const command = extractCommand(raw);
    const hit = evaluate(command, loaded.config);
    if (hit) {
      logEvent({
        ...extractContext(raw), // 세션·턴·호출 식별자 — after 는 call 로 fire(ask) 와 정확히 짝지어진다 (docs/16)
        event: 'after',
        gate: 'danger-guard',
        rule: hit.rule,
        decision: hit.decision,
        probe: hit.probe,
        cmdPrefix: normalizeCmdPrefix(command),
      });
    }
    process.exit(0);
  }

  const cmdFlag = argv.indexOf('--cmd');
  const fromHook = cmdFlag < 0;
  const raw = fromHook ? readStdin() : '';
  const command = cmdFlag >= 0 ? (argv[cmdFlag + 1] ?? '') : extractCommand(raw);
  const context = fromHook ? extractContext(raw) : {};
  const hit = evaluate(command, loaded.config);

  // v2 위임 승격 — ask 판정에 유효한 승격 레코드가 있으면 allow 로 처리한다 (docs/15 §5).
  // 강등 조건 충족은 여기서 감지돼 레코드가 무시된다(ask 복귀) — 설정 편집 없는 자동·즉시 강등.
  // 레코드·로그를 못 읽으면 승격 없음 = ask 유지 (보수 방향 — docs/15 §7).
  let promoted = false;
  if (hit && hit.decision === 'ask' && !hit.probe) {
    const { records } = readPromotions();
    if (records.length > 0) {
      const { events } = readLog();
      promoted = promotionStateFor(
        hit.rule,
        records,
        events,
        currentPatternOf(loaded.config.dangerGuard, hit.rule),
      ).active;
    }
  }

  // 계측은 훅 경로만 남긴다 — --cmd 는 점검용 단건 판정이라 지표(분모)를 오염시킨다.
  // ⭐ 승격된 매치도 기록을 끊지 않는다 — pass 에 rule·promoted 를 실어 분모와 강등 감시를 지킨다.
  if (fromHook && command.trim()) {
    logEvent(
      hit
        ? promoted
          ? {
              ...context,
              event: 'pass',
              gate: 'danger-guard',
              rule: hit.rule,
              promoted: true,
              cmdPrefix: normalizeCmdPrefix(command),
            }
          : {
              ...context,
              event: 'fire',
              gate: 'danger-guard',
              rule: hit.rule,
              decision: hit.decision,
              probe: hit.probe,
              cmdPrefix: normalizeCmdPrefix(command),
            }
        : { ...context, event: 'pass', gate: 'danger-guard', cmdPrefix: normalizeCmdPrefix(command) },
    );
  }

  if (!hit) process.exit(0);

  if (promoted) {
    // 점검 경로(--cmd)에서는 이유를 보이게 한다 — 왜 안 막혔는지 모르면 점검이 아니다.
    if (!fromHook)
      process.stderr.write(
        `[danger-guard] 위임 승격 allow — 규칙 ${hit.rule} 에 유효한 승격 레코드가 있습니다 (docs/15 §5)\n`,
      );
    process.exit(0);
  }

  emitDecision(hit.decision, reasonFor(hit));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('danger-guard.mjs')) {
  main().catch((e) => {
    process.stderr.write(`[danger-guard] 가드가 동작하지 않았습니다: ${e.message}\n`);
    process.exit(2);
  });
}
