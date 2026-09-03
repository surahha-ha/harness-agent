#!/usr/bin/env node
/**
 * 골격 2 — 경계표 기반 test-first 가드 (설정 주도).
 *
 * 경계표는 이 파일에 없다. 전부 `harness.config.mjs` 의 `testFirst` 에서 온다.
 * 경계표의 SSOT 는 프로젝트 문서이고, 설정은 그 기계화이며, 이 파일은 **판정 구조**만 갖는다 —
 * deny/ask 2단계 · 테스트 파일 자기면제 · 기존 파일 유예(grandfather) · 탈출구 · 활성 확인.
 *
 * ⭐ 도입 절차의 절반은 `--audit` 이다. 켜기 전에 "경계 안인데 테스트가 없는" 파일 수를 먼저 센다.
 *    숫자를 모르고 켜면 첫날 전부 막히고, 첫날 전부 막힌 가드는 그날 꺼진다.
 *
 * ⚠️ 한계 — 테스트의 **존재**만 본다. 그 테스트가 의미 있는지, 실제로 그 로직을 덮는지는 보지 않는다.
 *    존재 판정을 커버리지 보증으로 읽으면 안 된다. 경로 매칭은 디렉토리 단위 근사라
 *    같은 디렉토리 안의 편차(계산 로직 vs 얇은 래퍼)를 구분하지 못한다 — 애매한 영역은 ask 로 둔다.
 *
 * 사용:
 *   node skeletons/test-first.mjs --audit          # 켜기 전 선실측 (enabled:false 여도 돈다)
 *   testFirst.auditOnStop: true                    # 턴 종료마다 같은 선실측을 turn-end.mjs 가 남긴다 —
 *                                                  #   v2 검증 축의 대체 경로 (docs/16 §5 기준 4). 게이트와 무관한 스위치
 *   node skeletons/test-first.mjs --status         # 활성 확인
 *   node skeletons/test-first.mjs --file <경로>    # 단건 판정
 *   (훅) stdin 으로 도구 입력 JSON — 파일 편집 도구(Write|Edit 매처)에 건다
 *
 * 종료코드: 0 판정 완료(통과 포함) · 2 가드 오류
 */

import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig, compile, emitDecision, readStdin, CONFIG_NAME, projectRoot } from './lib/config.mjs';
import { logEvent } from './lib/log.mjs';

/** 경로 표기를 '/' 로 통일한다 — 경계표 패턴이 OS 마다 갈리면 규칙이 조용히 안 걸린다. */
function norm(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 파일이 경계표의 어디에 속하나. 순수 함수.
 * @returns {'exempt'|{decision:'deny'|'ask', what:string}|null} null = 경계 밖
 */
export function classify(relPath, tf) {
  const p = norm(relPath);
  for (const ex of tf.exempt || []) {
    const c = compile(ex);
    if (c.error) {
      process.stderr.write(`[test-first] ${c.error}\n`);
      continue;
    }
    if (c.re.test(p)) return 'exempt';
  }
  // deny 가 ask 보다 먼저다 — 더 강한 판정이 이긴다 (골격 1 과 같은 구조).
  for (const decision of ['deny', 'ask']) {
    for (const scope of (tf.scopes || []).filter((s) => s && s.decision === decision)) {
      const c = compile(scope.pattern);
      if (c.error) {
        process.stderr.write(`[test-first] ${c.error}\n`);
        continue;
      }
      if (c.re.test(p)) return { decision, what: scope.what || String(scope.pattern) };
    }
  }
  return null;
}

/**
 * 대상 파일에 대응하는 테스트를 찾는다. 순수 함수 — 파일시스템은 io 로 주입한다.
 * @param {{listDir:(dir:string)=>string[]|null}} io listDir 은 없으면 null (디렉토리 부재는 오류가 아니다)
 * @returns {{found:string|null}|{error:string}}
 */
export function findTest(relPath, tf, io) {
  const p = norm(relPath);
  const parts = p.split('/');
  const file = parts.pop();
  const dir = parts.join('/');
  const base = file.replace(/\.[^.]+$/, '');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lookup = tf.testLookup || {};
  const src = (lookup.pattern || '^{base}[\\w.\\-]*\\.(test|spec)\\.[cm]?[jt]sx?$').replace(
    '{base}',
    escaped,
  );
  const c = compile(src);
  if (c.error) return { error: `testLookup.pattern 이 깨졌습니다 — ${c.error}` };
  for (const d of lookup.dirs || ['.']) {
    const dirPath = d === '.' ? dir : dir ? `${dir}/${d}` : d;
    const names = io.listDir(dirPath);
    if (!names) continue;
    const hit = names.find((n) => c.re.test(n));
    if (hit) return { found: dirPath ? `${dirPath}/${hit}` : hit };
  }
  return { found: null };
}

/**
 * 훅 한 건을 판정한다. 순수 함수 — 이 함수 자체를 테스트한다.
 * @param {{fileExists:(rel:string)=>boolean, listDir:(dir:string)=>string[]|null}} io
 * @returns {{decision:'deny'|'ask', why:string, recover:string}|null}
 */
export function evaluate(relPath, config, io) {
  const tf = (config && config.testFirst) || {};
  if (tf.enabled !== true) return null;
  if (!relPath || !norm(relPath).trim()) return null;

  const cls = classify(relPath, tf);
  if (!cls || cls === 'exempt') return null;

  // ⭐ 유예 — 이미 있던 파일은 통과시키고 신규 파일만 판정한다.
  //    첫날 전부 막히면 가드는 그날 꺼진다. 단계적 도입(측정→유예→적용→승격)의 "유예·적용" 단계다.
  if (tf.grandfather !== false && io.fileExists(relPath)) return null;

  const t = findTest(relPath, tf, io);
  if (t.error) {
    // 탐색 규칙이 깨지면 판정할 수 없다. 조용히 넘기지 않되, 규칙 결함으로 작업 전체를 막지도 않는다.
    process.stderr.write(`[test-first] ${t.error} — 판정하지 못했습니다.\n`);
    return null;
  }
  if (t.found) return null;

  const lookup = tf.testLookup || {};
  return {
    decision: cls.decision,
    why: `테스트 선행 영역입니다 (${cls.what}) — 대응 테스트를 찾지 못했습니다.`,
    recover:
      `Red 를 먼저 쓰세요 — ${(lookup.dirs || ['.']).join('·')} 에 테스트 파일을 만들어 실패를 확인한 뒤 이 파일을 작성합니다. ` +
      `이 파일이 왜 대상인지 의문이면 ${CONFIG_NAME} 의 testFirst.scopes(경계표)를 보고, 표가 틀렸으면 표를 고치세요.`,
  };
}

/**
 * 선실측 — 경계 안인데 테스트가 없는 파일을 센다.
 * ⭐ enabled·grandfather 를 무시한다. 켜기 전에 세는 것이 목적이고, 기존 위반을 세는 것이 유예의 근거다.
 */
export function audit(files, config, io) {
  const tf = (config && config.testFirst) || {};
  const r = { total: files.length, inScope: 0, missing: [] };
  for (const f of files) {
    const cls = classify(f, tf);
    if (!cls || cls === 'exempt') continue;
    r.inScope++;
    const t = findTest(f, tf, io);
    if (!t.error && !t.found) r.missing.push({ path: norm(f), decision: cls.decision, what: cls.what });
  }
  return r;
}

/**
 * 활성 상태 — 다섯 가지를 구분한다(골격 1 의 4상태 + 탈출구).
 * ⭐ escaped 를 따로 두는 이유: 탈출구 환경변수는 대량 리팩터링 중 켜 두고 잊는 물건이다.
 *    "활성이라 믿는데 환경변수로 꺼져 있음" 은 거짓 활성과 같은 부류라 반드시 보이게 한다.
 */
export function statusOf(config, env = {}) {
  const tf = (config && config.testFirst) || {};
  const scopes = (tf.scopes || []).filter(Boolean);
  const counts = {
    deny: scopes.filter((s) => s.decision === 'deny').length,
    ask: scopes.filter((s) => s.decision === 'ask').length,
  };
  const grandfather = tf.grandfather !== false;
  if (tf.enabled !== true) return { state: 'off', ...counts, grandfather };
  if (tf.offEnv && env[tf.offEnv]) return { state: 'escaped', ...counts, grandfather, offEnv: tf.offEnv };
  if (counts.deny + counts.ask === 0) return { state: 'empty', ...counts, grandfather };
  return { state: 'active', ...counts, grandfather };
}

/**
 * 훅 입력에서 대상 파일 경로를 꺼낸다.
 * 명령 가드와 달리 원문 폴백이 없다 — 임의 텍스트에서 "경로" 를 추정하면 오판정만 는다.
 * 경로가 없으면 null 을 돌려주고, 호출부는 판정 없이 통과시킨다.
 */
export function extractFilePath(raw) {
  try {
    const parsed = JSON.parse(raw);
    const fp = parsed?.tool_input?.file_path;
    if (typeof fp === 'string' && fp.trim()) return fp;
  } catch {
    /* 경로 아님 */
  }
  return null;
}

/**
 * 선실측 한 번 — 추적 파일 전체를 세어 수치만 돌려준다(기록은 호출부 몫). `--audit` 과 턴 종료 훅(`turn-end.mjs`,
 * `testFirst.auditOnStop`)이 같이 쓴다 — 두 경로의 수치가 같은 함수에서 나와야 시계열이 하나로 이어진다.
 * @returns {{total:number, inScope:number, missing:number, deny:number, ask:number, list:object[]}}
 */
export function runAudit(root, config) {
  const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const a = audit(files, config, realIo(root));
  const byDecision = { deny: 0, ask: 0 };
  for (const m of a.missing) byDecision[m.decision]++;
  return { total: a.total, inScope: a.inScope, missing: a.missing.length, ...byDecision, list: a.missing };
}

function realIo(root) {
  return {
    fileExists: (rel) => existsSync(path.join(root, rel)),
    listDir: (rel) => {
      try {
        return readdirSync(path.join(root, rel));
      } catch {
        return null;
      }
    },
  };
}

function toRel(fp, root) {
  const abs = path.isAbsolute(fp) ? fp : path.join(root, fp);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return null; // 프로젝트 밖 — 경계표의 관할이 아니다
  return norm(rel);
}

function reasonFor(hit) {
  const head = hit.decision === 'deny' ? '차단됨' : '확인 필요';
  return `${head} — ${hit.why}\n→ ${hit.recover}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const root = projectRoot();
  const loaded = await loadConfig();

  if (argv.includes('--status')) {
    if (!loaded.ok) {
      process.stdout.write(
        `[test-first] 비활성 — ${CONFIG_NAME} 를 읽지 못했습니다 (${loaded.reason})\n  경로: ${loaded.path}\n`,
      );
      process.exit(2);
    }
    const s = statusOf(loaded.config, process.env);
    const detail = `deny ${s.deny} · ask ${s.ask} · 유예 ${s.grandfather ? '켬' : '끔'}`;
    const line = {
      off: `[test-first] 꺼짐 — enabled:false 입니다 (${detail})\n  켜기 전에 --audit 으로 먼저 세세요 — 숫자를 모르고 켜면 첫날 전부 막힙니다.\n`,
      escaped: `[test-first] 꺼짐(탈출구) — 환경변수 ${s.offEnv} 가 설정돼 있습니다 (${detail})\n  대량 리팩터링이 끝났다면 해제하세요 — 켜 두고 잊으면 거짓 활성과 같습니다.\n`,
      empty: `[test-first] 설정됨 · 경계 없음 — 아무것도 판정하지 않습니다\n  경계표(testFirst.scopes)를 채우세요. 판별 질문: "정답을 입력·출력 표로 먼저 쓸 수 있나?" 애매하면 ask.\n`,
      active: `[test-first] 활성 — ${detail}\n`,
    }[s.state];
    process.stdout.write(line + `  설정: ${loaded.path}\n`);
    process.exit(s.state === 'active' ? 0 : 1);
  }

  if (!loaded.ok) {
    process.stderr.write(
      `[test-first] 가드가 동작하지 않았습니다 — ${CONFIG_NAME} (${loaded.reason}).\n` +
        `  '위반 없음' 이 아니라 '검사하지 않음' 입니다. --status 로 확인하세요.\n`,
    );
    process.exit(2);
  }

  if (argv.includes('--audit')) {
    let a;
    try {
      a = runAudit(root, loaded.config);
    } catch (e) {
      process.stderr.write(
        `[test-first] 선실측 실패 — git ls-files 를 실행하지 못했습니다 (${e.message.split('\n')[0]}).\n` +
          `  저장소 루트에서 실행하세요. 대상 목록 없이는 셀 수 없습니다.\n`,
      );
      process.exit(2);
    }
    // 계측 — 선실측 수치를 시계열로 남긴다. 지표 1(완주율)의 원천이다 (docs/13 §4).
    logEvent({
      event: 'audit',
      gate: 'test-first',
      total: a.total,
      inScope: a.inScope,
      missing: a.missing,
      deny: a.deny,
      ask: a.ask,
    });
    process.stdout.write(
      `[test-first] 선실측 — 전체 ${a.total} · 경계 안 ${a.inScope} · 테스트 없음 ${a.missing}` +
        ` (deny ${a.deny} · ask ${a.ask})\n`,
    );
    const SHOW = 20;
    for (const m of a.list.slice(0, SHOW)) {
      process.stdout.write(`  ${m.decision}  ${m.path}  ← ${m.what}\n`);
    }
    if (a.list.length > SHOW) process.stdout.write(`  … 외 ${a.list.length - SHOW}건\n`);
    process.stdout.write(
      a.missing > 0
        ? `  → 이 숫자를 보고 도입 단계(측정→유예→적용→승격)를 정하세요. 0이 아니면 grandfather:true 로 시작하는 것을 권합니다.\n`
        : `  → 기존 위반이 없습니다. enabled:true 로 켜도 첫날 막힐 것이 없습니다.\n`,
    );
    process.exit(0);
  }

  const tf = loaded.config.testFirst || {};
  if (tf.enabled === true && tf.offEnv && process.env[tf.offEnv]) {
    // 탈출구로 꺼진 상태 — 조용히 통과시키면 "위반 없음" 과 구별되지 않는다.
    process.stderr.write(`[test-first] 탈출구 ${tf.offEnv} 로 꺼져 있습니다 — 판정하지 않습니다.\n`);
    process.exit(0);
  }

  const fileFlag = argv.indexOf('--file');
  const fp = fileFlag >= 0 ? (argv[fileFlag + 1] ?? '') : extractFilePath(readStdin());
  if (!fp) process.exit(0);
  const rel = toRel(fp, root);
  if (!rel) process.exit(0);

  const hit = evaluate(rel, loaded.config, realIo(root));
  if (!hit) process.exit(0);

  emitDecision(hit.decision, reasonFor(hit));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('test-first.mjs')) {
  main().catch((e) => {
    process.stderr.write(`[test-first] 가드가 동작하지 않았습니다: ${e.message}\n`);
    process.exit(2);
  });
}
