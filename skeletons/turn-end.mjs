#!/usr/bin/env node
/**
 * v2 계측 — 턴 종료 훅 (`docs/16-v2-completion-metric.md` §5 기준 3 · `docs/13` §2 `stop`).
 *
 * 에이전트 도구의 **Stop 훅**에 건다. 턴(프롬프트 1회)이 사람의 중단 없이 끝났을 때 환경이 Stop 을
 * 부르므로, 그 페이로드의 `prompt_id`(= 로그 `turn`)·`session_id`(= `session`)를 `stop` 이벤트 한 줄로
 * 남긴다. 이것이 v2 "개입 없이 완주" 의 **ㄴ 축(사람 중단 없음)** 의 유일한 관찰 수단이다.
 *
 * ⭐ 게이트가 아니다 — **fail-open.** 무엇도 막지 않고 stdout 에 아무것도 쓰지 않는다(Stop 훅의 stdout
 *    JSON 은 종료를 막는 프로토콜이라, 여기서 무언가 쓰면 계측이 개입이 된다). 기록 실패는 stderr 로만.
 * ⭐ 판정은 여기서 하지 않는다. "Stop 없음 = 중단" 은 리포트(`metrics.mjs`)가 같은 세션의 뒤 턴 유무로
 *    가른다 — 세션의 마지막 턴은 중단이 아니라 **미판정(관찰 경계)** 이다. 이 파일은 있었던 사실만 적는다.
 *
 * ⚠️ 한계 — ①사람이 끊었는지는 "Stop 이 오지 않았다" 로만 본다(4갈래 구분 불가 — docs/13 §2 한계 그대로).
 *    ②훅이 안 걸린 기간은 Stop 이 하나도 없어 전부 중단처럼 보인다 — 리포트가 첫 `stop` 이전 턴을
 *    "관찰 이전" 으로 **제외**한다(0 으로 둔갑 금지). 훅이 걸렸다가 조용히 죽어도 같은 모양이 되므로,
 *    중단이 갑자기 100% 가 되면 규범이 아니라 연결을 의심한다. ③서브에이전트 턴(SubagentStop)은 대상 밖.
 *
 * 검증 축(ㄷ) 대체 경로: `harness.config.mjs` 의 `testFirst.auditOnStop: true` 이면 stop 과 함께 골격 2 선실측
 * (`audit`, 같은 session·turn)을 남긴다. 리포트는 그 턴의 "테스트 없음" 이 직전 audit 보다 **늘지 않았으면**
 * 그린으로 본다 — 테스트 실행의 그린이 아니다(종료코드는 페이로드에 없다 — docs/16 §5.1). 이름을 속이지 않는다.
 *
 * 사용:
 *   (훅) stdin 으로 Stop 페이로드 JSON 을 받는다 — Stop 에 건다 (matcher 없음)
 *   node skeletons/turn-end.mjs --status     # 활성 확인 — 로그에 stop 이벤트가 몇 건·언제까지 있는가
 *
 * 종료코드: 0 항상(훅 경로) · --status 는 stop 이벤트가 있으면 0, 없으면 1(미연결 또는 연결 이전)
 */

import { readStdin, loadConfig, projectRoot } from './lib/config.mjs';
import { logEvent, readLog, logPath, extractContext } from './lib/log.mjs';
import { runAudit } from './test-first.mjs';

export const GATE = 'turn-end';

/**
 * 턴 종료 시 골격 2 선실측을 같이 남길 것인가 — `testFirst.auditOnStop` 하나만 본다. 순수 함수.
 *
 * `enabled`(게이트) 와 **일부러 분리**했다. 프로젝트가 같은 경계표로 자기 훅을 이미 걸어 둔 설치처에서 골격 2 를
 * 켜면 이중 게이트가 되고, 훅 없이 enabled 만 켜면 `--status` 가 "활성" 이라 답하는 거짓 활성이 된다(실측:
 * 한 설치처). 검증 축이 필요한 건 게이트가 아니라 **시계열**이므로 스위치를 따로 둔다 (docs/16 §5 기준 4).
 */
export function auditOnStop(config) {
  return Boolean(config && config.testFirst && config.testFirst.auditOnStop === true);
}

/**
 * 턴 종료 audit 이벤트 — `--audit` 과 같은 수치에 stop 과 같은 식별자를 싣는다. 순수 함수.
 * `turn` 이 있어야 리포트가 턴에 붙일 수 있다(없으면 시계열에는 남지만 턴 판정에서는 미수집).
 */
export function auditEventFrom(stopEvent, numbers) {
  return {
    ...(stopEvent.session ? { session: stopEvent.session } : {}),
    ...(stopEvent.turn ? { turn: stopEvent.turn } : {}),
    event: 'audit',
    gate: 'test-first',
    total: numbers.total,
    inScope: numbers.inScope,
    missing: numbers.missing,
    deny: numbers.deny,
    ask: numbers.ask,
  };
}

/**
 * Stop 페이로드 원문에서 `stop` 이벤트를 만든다. 순수 함수 — 이 함수를 테스트한다.
 * 페이로드를 못 읽으면 null(기록할 사실이 없다). `prompt_id` 가 없어도 이벤트는 만든다 — `turn` 이
 * 빠진 `stop` 은 스키마 계약 검사에서 **위반**으로 드러나야 하기 때문이다(조용히 버리면 "훅이 안 돌았다"
 * 와 "환경이 열쇠를 안 줬다" 가 똑같이 보인다 — 골격 공통 규약 4).
 * @param {string} raw
 * @returns {{event:'stop', gate:string, session?:string, turn?:string}|null}
 */
export function stopEventFrom(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { session, turn } = extractContext(raw);
  return {
    ...(session ? { session } : {}),
    ...(turn ? { turn } : {}),
    event: 'stop',
    gate: GATE,
  };
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--status')) {
    const { events, broken } = readLog();
    const stops = events.filter((e) => e.event === 'stop');
    const last = stops[stops.length - 1];
    process.stdout.write(
      stops.length > 0
        ? `[turn-end] 활성 — stop 이벤트 ${stops.length}건 · 최근 ${String(last.ts).slice(0, 19)}Z` +
            `${broken > 0 ? ` · 깨진 줄 ${broken}` : ''}  로그: ${logPath()}\n`
        : `[turn-end] stop 이벤트 없음 — 훅이 연결되지 않았거나 연결 뒤 턴이 끝난 적이 없습니다.\n` +
            `  '중단 0' 이 아니라 '관찰 없음' 입니다. Stop 훅에 이 파일을 걸고 대화형 세션에서 턴을 하나 끝내 보세요.  로그: ${logPath()}\n`,
    );
    process.exit(stops.length > 0 ? 0 : 1);
  }

  const raw = readStdin();
  const ev = stopEventFrom(raw);
  if (!ev) {
    // 사실이 없으면 적지 않는다. 다만 조용히는 아니다 — 페이로드 형식이 바뀌면 여기서 보인다.
    process.stderr.write(`[turn-end] Stop 페이로드를 읽지 못했습니다 — 기록 없음 (종료를 막지는 않습니다)\n`);
    process.exit(0);
  }
  logEvent(ev);

  // 검증 축 대체 경로 — 턴 종료 시점의 골격 2 선실측을 같은 식별자로 남긴다 (docs/16 §5 기준 4).
  // 설정이 없거나 스위치가 꺼져 있으면 아무것도 하지 않는다(미수집 — 리포트가 그렇게 표기한다). 실패는 stderr 만.
  try {
    const root = projectRoot();
    const loaded = await loadConfig(root);
    if (loaded.ok && auditOnStop(loaded.config)) logEvent(auditEventFrom(ev, runAudit(root, loaded.config)));
  } catch (e) {
    process.stderr.write(`[turn-end] 턴 종료 선실측 실패 — ${e.message.split('\n')[0]} (stop 은 기록됐고 종료를 막지는 않습니다)\n`);
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('turn-end.mjs')) {
  main().catch((e) => {
    process.stderr.write(`[turn-end] 훅이 동작하지 않았습니다: ${e.message} (종료를 막지는 않습니다)\n`);
    process.exit(0);
  });
}
