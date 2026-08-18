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

/**
 * 명령 접두사 정규화 — **첫 토큰 + 첫 서브커맨드.** 순수 함수.
 *
 * 두 번째 토큰은 서브커맨드처럼 생겼을 때만 취한다(영문 시작, 영숫자·점·하이픈·언더스코어).
 * 경로·플래그·리다이렉션·인용부호가 접두사에 섞이면 "원문을 저장하지 않는다" 가 무너진다 —
 * 판별이 서지 않는 토큰은 버리는 쪽이 안전하다.
 */
export function normalizeCmdPrefix(command) {
  const tokens = String(command || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return '';
  const head = tokens[0];
  const sub = tokens[1];
  if (sub && /^[A-Za-z][\w.-]*$/.test(sub)) return `${head} ${sub}`;
  return head;
}

/**
 * 이벤트 한 줄을 append 한다. `ts` 는 여기서 찍는다 — 호출부가 시각을 다루지 않게.
 * 세션 식별자는 환경이 주면 싣고, 없으면 필드 자체를 생략한다(빈 값과 없음을 구분).
 * @param {object} event `docs/13-v1-eval-design.md` §2 의 5종 중 하나
 * @returns {boolean} 기록 성공 여부 — 실패해도 던지지 않는다(fail-open)
 */
export function logEvent(event, root = projectRoot()) {
  try {
    mkdirSync(path.join(root, LOG_DIR), { recursive: true });
    const session = process.env.CLAUDE_SESSION_ID;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...(session ? { session } : {}),
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
