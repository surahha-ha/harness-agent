/**
 * 하네스 설정 로더.
 *
 * 설정은 `harness.config.mjs` 하나뿐이고, 없으면 골격들은 **동작하지 않는다.**
 * ⭐ 다만 "없어서 안 함" 과 "검사했는데 위반 없음" 은 반드시 구분해 알린다(골격 공통 규약 4).
 *    조용히 통과시키면 하네스가 안 깔린 상태와 통과가 똑같이 보인다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const CONFIG_NAME = 'harness.config.mjs';

/** 프로젝트 루트 — 훅 실행 컨텍스트가 주는 값을 우선한다. */
export function projectRoot() {
  return (process.env.HARNESS_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(
    /[\\/]+$/,
    '',
  );
}

/**
 * 설정을 읽는다.
 * @returns {Promise<{ok: true, config: object, path: string} | {ok: false, reason: string, path: string}>}
 */
export async function loadConfig(root = projectRoot()) {
  const p = path.join(root, CONFIG_NAME);
  if (!existsSync(p)) {
    return { ok: false, reason: 'missing', path: p };
  }
  try {
    const mod = await import(pathToFileURL(p).href);
    const config = mod.default;
    if (!config || typeof config !== 'object') {
      return { ok: false, reason: 'default export 가 객체가 아닙니다', path: p };
    }
    return { ok: true, config, path: p };
  } catch (e) {
    return { ok: false, reason: e.message, path: p };
  }
}

/**
 * 패턴을 정규식으로. 설정 파일이 잘못돼도 가드 전체가 죽지 않게 개별로 감싼다.
 *
 * ⭐ **정규식 리터럴을 권장한다.** 설정이 `.mjs` 인 이유가 이것이다 —
 *    문자열로 쓰면 이스케이프를 두 번 해야 하고, 한 번 빠뜨려도 **오류 없이 조용히 다른 뜻**이 된다.
 *    (`'\bfoo\b'` 는 JS 에서 `\b` 가 백스페이스 문자라 단어 경계가 아니다. 규칙이 영원히 안 걸린다.)
 *    그래서 문자열에 제어문자가 섞이면 통과시키지 않고 오류로 돌린다.
 *
 * @param {RegExp|string} pattern
 * @returns {{re: RegExp}|{error: string}}
 */
export function compile(pattern, flags = '') {
  if (pattern instanceof RegExp) return { re: pattern };
  if (typeof pattern !== 'string') {
    return { error: `패턴은 정규식 리터럴이나 문자열이어야 합니다 (받은 값: ${typeof pattern})` };
  }
  if ([...pattern].some((ch) => ch.charCodeAt(0) < 32)) {
    return {
      error:
        `패턴에 제어문자가 있습니다 — 이스케이프가 소실된 것 같습니다: ${JSON.stringify(pattern)}. ` +
        `문자열 대신 정규식 리터럴(/.../)로 쓰세요.`,
    };
  }
  try {
    return { re: new RegExp(pattern, flags) };
  } catch (e) {
    return { error: `잘못된 패턴 ${JSON.stringify(pattern)} — ${e.message}` };
  }
}

/** 훅 프로토콜 출력. 판정이 없으면 아무것도 쓰지 않는다. */
export function emitDecision(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
}

/** stdin 전체를 읽는다. 훅은 JSON 을 준다. */
export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
