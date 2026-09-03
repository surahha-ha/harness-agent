/**
 * v1 계측 — 로그 층 (`docs/13-v1-eval-design.md` §3).
 *
 * 골격이 판정하는 순간 이벤트 한 줄을 `.harness/log.jsonl` 에 append 한다.
 * ⭐ 로그는 게이트가 아니다 — **fail-open.** 기록에 실패해도 판정을 막지 않는다.
 *    단 조용히 삼키지 않고 stderr 로 남긴다 — 기록 실패를 숨기면 "이벤트 없음" 과
 *    "기록 안 됨" 이 똑같이 보인다 (골격 공통 규약 4 와 같은 뿌리).
 *
 * ⚠️ **원문 명령을 저장하지 않는다.** 승격의 단위 = 명령 접두사 × 저장소이므로 로그 단위도
 *    그것이고, 원문에는 대상 프로젝트 고유값이 들어간다. 로그 파일 자체도 반출 금지라
 *    부트스트랩이 `.gitignore` 등록을 포함한다 — 이 이중 방어의 안쪽이 이 정규화다.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';

export const LOG_DIR = '.harness';
export const LOG_NAME = 'log.jsonl';

export function logPath(root = projectRoot()) {
  return path.join(root, LOG_DIR, LOG_NAME);
}

/** 판별이 서지 않는 첫 토큰을 접는 자리 표시자 — 짝짓기에서 제외된다(아래 `isPairablePrefix`). */
export const UNPARSED_PREFIX = '(unparsed)';

/** 명령 이름으로 인정하는 첫 토큰: 실행파일 이름, 또는 한 마디짜리 상대경로 실행. */
const HEAD_COMMAND = /^[A-Za-z_][\w.-]*$/;
const HEAD_RELATIVE = /^\.{1,2}\/[\w.-]+$/;

/**
 * 명령 접두사 정규화 — **첫 토큰 + 첫 서브커맨드.** 순수 함수.
 *
 * 두 토큰 모두 판별한다. 두 번째 토큰은 서브커맨드처럼 생겼을 때만 취하고,
 * **첫 토큰도 명령 이름처럼 생겼을 때만 취한다** — 경로·변수 대입·인용부호가 접두사에 섞이면
 * "원문을 저장하지 않는다"(docs/13 §3)가 무너진다. 판별이 서지 않으면 버리는 쪽이 안전하다.
 *
 * ⚠️ **첫 토큰 판별이 없던 시절의 로그에는 절대경로가 실려 있다**(F26, 2026-08-31 실측).
 * `VAR="/절대/경로/..."; cmd` 처럼 공백 없는 변수 대입은 통째로 한 토큰이라 그대로 저장됐다.
 * 판별 불가는 원문을 자르지 않고 `UNPARSED_PREFIX` 로 **접는다** — 잘라 남기면 남은 조각이
 * 여전히 원문의 일부이기 때문이다.
 */
export function normalizeCmdPrefix(command) {
  const tokens = String(command || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return '';
  const head = tokens[0];
  if (!HEAD_COMMAND.test(head) && !HEAD_RELATIVE.test(head)) return UNPARSED_PREFIX;
  const sub = tokens[1];
  if (sub && /^[A-Za-z][\w.-]*$/.test(sub)) return `${head} ${sub}`;
  return head;
}

/**
 * 이 접두사를 ask→after 짝짓기의 열쇠로 써도 되는가.
 *
 * `(unparsed)` 는 서로 다른 명령이 뭉쳐 있는 자리라 열쇠가 될 수 없다 — 뭉친 것을 같다고 보면
 * 남의 `after` 를 승인으로 셀 수 있다. 짝을 못 찾으면 "승인 아님" 으로 남고, 그것은
 * **승격을 늦추는 방향**이다(docs/15 ⑥ — 근사는 느슨해지는 쪽으로 오차 내지 않는다).
 */
export function isPairablePrefix(prefix) {
  return Boolean(prefix) && prefix !== UNPARSED_PREFIX;
}

/**
 * 훅 입력(stdin JSON)에서 **식별자 셋**을 꺼낸다 — 세션·턴·도구 호출. 순수 함수.
 *
 * 환경은 이 셋을 훅 페이로드로 준다(`session_id` · `prompt_id` · `tool_use_id`). 환경변수가 아니다 —
 * 환경변수만 보던 시절의 로그는 세션 필드가 **0건**이었다(실측: 한 설치처 3641건 전부). 그래서
 * 작업 단위가 없어 v2 의 "개입 없이 완주한 작업 비율" 을 셀 수 없었다(`docs/16`).
 *
 * - `turn` = 프롬프트 한 번(사람이 위임한 단위) — v2 완주율의 **분모 단위**.
 * - `call` = 도구 호출 하나 — `fire(ask)` ↔ `after` 를 접두사 근사가 아니라 **정확히** 짝짓는 열쇠.
 * 없는 것은 생략한다(빈 값과 없음을 구분). 파싱 실패면 빈 객체 — 식별자가 없다고 판정을 막지 않는다.
 * @param {string} raw 훅 stdin 원문
 * @returns {{session?: string, turn?: string, call?: string}}
 */
export function extractContext(raw) {
  try {
    const p = JSON.parse(raw);
    const pick = (v) => (typeof v === 'string' && v ? v : undefined);
    const ctx = { session: pick(p?.session_id), turn: pick(p?.prompt_id), call: pick(p?.tool_use_id) };
    return Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined));
  } catch {
    return {};
  }
}

/**
 * 이벤트 한 줄을 append 한다. `ts` 는 여기서 찍는다 — 호출부가 시각을 다루지 않게.
 * 세션 식별자는 이벤트에 실려 오면(훅 페이로드 — `extractContext`) 그것을, 아니면 환경변수를 쓰고,
 * 둘 다 없으면 필드 자체를 생략한다(빈 값과 없음을 구분).
 * @param {object} event `docs/13-v1-eval-design.md` §2 의 6종 중 하나
 * @returns {boolean} 기록 성공 여부 — 실패해도 던지지 않는다(fail-open)
 */
export function logEvent(event, root = projectRoot()) {
  try {
    mkdirSync(path.join(root, LOG_DIR), { recursive: true });
    const session = process.env.CLAUDE_SESSION_ID;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...(session && !event.session ? { session } : {}),
      ...event,
    });
    appendFileSync(logPath(root), line + '\n', 'utf8');
    return true;
  } catch (e) {
    process.stderr.write(`[harness-log] 기록 실패 — ${e.message} (판정에는 영향 없음)\n`);
    return false;
  }
}

/**
 * 로그 전체를 읽는다. 깨진 줄은 건너뛰되 **개수를 센다** — 몇 줄을 못 읽었는지 모르는
 * 집계는 집계가 아니다.
 * @returns {{events: object[], broken: number}}
 */
export function readLog(root = projectRoot()) {
  let raw;
  try {
    raw = readFileSync(logPath(root), 'utf8');
  } catch {
    return { events: [], broken: 0 };
  }
  const events = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      broken++;
    }
  }
  return { events, broken };
}
