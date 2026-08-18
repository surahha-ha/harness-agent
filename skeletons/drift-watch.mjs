#!/usr/bin/env node
/**
 * 골격 4 — 드리프트 감시 (설정 주도).
 *
 * 같은 내용으로 두기로 한 것들이 조용히 어긋나는 것을 잡는다.
 * 미러 목록은 이 파일에 없다 — 전부 `harness.config.mjs` 의 `drift.mirrors` 에서 온다.
 * ⭐ 목록을 스크립트에 하드코딩하면 자산이 늘어도 목록이 안 늘고, 나중에 추가된 종류는
 *    한 번도 비교되지 않는다(실측된 실패 시나리오). 목록은 설정이라는 자산으로 승격돼 있다.
 *
 * 판정 구조:
 *   - **양방향** — 한쪽에만 있는 파일을 어느 방향이든 잡는다. 배포본이 낡은 경우만 보면
 *     원본이 낡은 역방향을 영원히 놓친다.
 *   - **내용 동일(content) 과 존재만 동일(existence) 을 구분** — 실행 위치에 따라 표기가
 *     달라지는 자산은 내용 비교가 오탐이다.
 *   - **승인된 차이는 조용히 둔다** — 의도된 비대칭을 매번 경고하면 사람은 곧 전체를 무시한다.
 *     경고 피로는 감시 도구의 주된 사인이다. 목록에 없는 차이만 알린다.
 *   - 상대가 아예 없으면 **조용히 no-op** — 감시 도구가 배치 전제를 강요하면 안 된다.
 *   - 개행 차이는 드리프트가 아니다 — 정규화 후 비교한다.
 *
 * 성격: 조언 게이트(fail-open 아님 주의 — 설정을 못 읽으면 "검사하지 않음" 을 보이게 알린다).
 *
 * ⚠️ 한계 — "같아야 한다" 고 선언된 쌍만 본다. 선언되지 않은 위치에 놓인 자산은 아무도 감시하지
 *    않는다. 감시 범위와 자산 배치가 어긋나면 침묵이 곧 거짓 그린이다 — 자산을 새 위치에 둘 때
 *    미러 목록에 함께 적는 것까지가 배치다.
 *
 * 사용:
 *   node skeletons/drift-watch.mjs           # 전체 미러 검사
 *   node skeletons/drift-watch.mjs --status  # 활성 확인 (미러·승인된 차이 수)
 *
 * 종료코드: 0 새 차이 없음 · 1 새 차이 있음(또는 비활성 상태) · 2 도구 오류
 */

import { statSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, CONFIG_NAME, projectRoot } from './lib/config.mjs';
import { logEvent } from './lib/log.mjs';

/** 개행 정규화 — CRLF/CR 차이는 드리프트가 아니다. */
export function normalizeEol(s) {
  return String(s).replace(/\r\n?/g, '\n');
}

function normPath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 미러 쌍 하나를 검사한다. 순수 함수 — 파일시스템은 io 로 주입한다.
 * @param {{a:string,b:string,compare?:'content'|'existence'}} mirror
 * @param {{kind:(p:string)=>'file'|'dir'|null, read:(p:string)=>string,
 *          mtime:(p:string)=>string|null, listFiles:(dir:string)=>string[]}} io
 * @returns {{state:'absent'|'checked', findings:Array<{kind:string,path:string,a:string,b:string,
 *            aMtime:string|null,bMtime:string|null}>}}
 */
export function checkMirror(mirror, io) {
  const { a, b } = mirror;
  const compare = mirror.compare || 'content';
  const ka = io.kind(a);
  const kb = io.kind(b);

  // 상대가 없으면 조용히 no-op — 짝 저장소가 아직 안 깔린 프로젝트에 경고를 퍼붓지 않는다.
  if (!ka || !kb) return { state: 'absent', findings: [] };

  const finding = (kind, rel, ap, bp) => ({
    kind,
    path: normPath(rel),
    a: normPath(ap),
    b: normPath(bp),
    aMtime: io.mtime(ap),
    bMtime: io.mtime(bp),
  });

  if (ka === 'file' && kb === 'file') {
    if (compare === 'content' && normalizeEol(io.read(a)) !== normalizeEol(io.read(b))) {
      return { state: 'checked', findings: [finding('content', normPath(a), a, b)] };
    }
    return { state: 'checked', findings: [] };
  }

  if (ka === 'dir' && kb === 'dir') {
    const la = new Set(io.listFiles(a).map(normPath));
    const lb = new Set(io.listFiles(b).map(normPath));
    const findings = [];
    // ⭐ 양방향 — 합집합을 돌아야 "다른 위치에만 추가된 자산이 감시망에 영원히 안 들어오는" 실패를 막는다.
    for (const rel of [...new Set([...la, ...lb])].sort()) {
      const ap = `${a}/${rel}`;
      const bp = `${b}/${rel}`;
      if (la.has(rel) && !lb.has(rel)) findings.push(finding('only-a', rel, ap, bp));
      else if (!la.has(rel) && lb.has(rel)) findings.push(finding('only-b', rel, ap, bp));
      else if (compare === 'content' && normalizeEol(io.read(ap)) !== normalizeEol(io.read(bp))) {
        findings.push(finding('content', rel, ap, bp));
      }
    }
    return { state: 'checked', findings };
  }

  // 한쪽은 파일, 한쪽은 디렉토리 — 종류 자체가 어긋났다.
  return { state: 'checked', findings: [finding('type', normPath(a), a, b)] };
}

/**
 * 승인된 차이를 걸러낸다. 순수 함수.
 * 승인 항목의 path 는 발견의 상대 경로(path) 또는 절대 표기(a/b) 어느 쪽과도 맞출 수 있다.
 */
export function filterApproved(findings, approved = []) {
  const ok = new Set(approved.filter((d) => d && d.path).map((d) => normPath(d.path)));
  const fresh = [];
  const suppressed = [];
  for (const f of findings) {
    (ok.has(f.path) || ok.has(f.a) || ok.has(f.b) ? suppressed : fresh).push(f);
  }
  return { fresh, suppressed };
}

/**
 * 활성 상태 — 셋을 구분한다. 미러 0개는 active 가 아니라 empty 다(거짓 활성 금지).
 * @returns {{state:'empty'|'active', mirrors:number, approved:number}}
 */
export function statusOf(config) {
  const d = (config && config.drift) || {};
  const mirrors = (d.mirrors || []).filter((m) => m && m.a && m.b).length;
  const approved = (d.approvedDifferences || []).length;
  if (mirrors === 0) return { state: 'empty', mirrors, approved };
  return { state: 'active', mirrors, approved };
}

const KIND_LABEL = {
  content: '내용이 다릅니다',
  'only-a': '앞쪽에만 있습니다 — 뒤쪽에 없음',
  'only-b': '뒤쪽에만 있습니다 — 앞쪽에 없음',
  type: '한쪽은 파일, 한쪽은 디렉토리입니다',
};

function realIo(root) {
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, p));
  const walk = (dir, prefix = '') => {
    const out = [];
    for (const e of readdirSync(abs(dir), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...walk(`${dir}/${e.name}`, rel));
      else out.push(rel);
    }
    return out;
  };
  return {
    kind: (p) => {
      try {
        return statSync(abs(p)).isDirectory() ? 'dir' : 'file';
      } catch {
        return null;
      }
    },
    read: (p) => readFileSync(abs(p), 'utf8'),
    mtime: (p) => {
      try {
        return statSync(abs(p)).mtime.toISOString().slice(0, 16).replace('T', ' ');
      } catch {
        return null;
      }
    },
    listFiles: (dir) => walk(dir),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const loaded = await loadConfig();

  if (!loaded.ok) {
    process.stderr.write(
      `[drift-watch] 감시가 동작하지 않았습니다 — ${CONFIG_NAME} (${loaded.reason}).\n` +
        `  '드리프트 없음' 이 아니라 '검사하지 않음' 입니다.\n  경로: ${loaded.path}\n`,
    );
    process.exit(2);
  }

  const s = statusOf(loaded.config);

  if (argv.includes('--status')) {
    const line = {
      empty:
        `[drift-watch] 설정됨 · 미러 없음 — 아무것도 감시하지 않습니다\n` +
        `  짝이 생겼다면 drift.mirrors 에 선언하세요. 선언되지 않은 자산은 아무도 감시하지 않습니다.\n`,
      active: `[drift-watch] 활성 — 미러 ${s.mirrors} · 승인된 차이 ${s.approved}\n`,
    }[s.state];
    process.stdout.write(line + `  설정: ${loaded.path}\n`);
    process.exit(s.state === 'active' ? 0 : 1);
  }

  if (s.state === 'empty') {
    process.stdout.write(`[drift-watch] 미러 없음 — 검사할 쌍이 선언되지 않았습니다 (--status 참조)\n`);
    process.exit(1);
  }

  const io = realIo(projectRoot());
  const d = loaded.config.drift || {};
  let fresh = [];
  let suppressed = 0;
  let absent = 0;
  for (const mirror of (d.mirrors || []).filter((m) => m && m.a && m.b)) {
    const r = checkMirror(mirror, io);
    if (r.state === 'absent') {
      absent++;
      continue;
    }
    const f = filterApproved(r.findings, d.approvedDifferences);
    fresh = fresh.concat(f.fresh);
    suppressed += f.suppressed.length;
  }

  for (const f of fresh) {
    process.stdout.write(
      `≠ ${f.path} — ${KIND_LABEL[f.kind] || f.kind}\n` +
        `    ${f.a}  (수정 ${f.aMtime ?? '없음'})\n` +
        `    ${f.b}  (수정 ${f.bMtime ?? '없음'})\n`,
    );
  }
  if (fresh.length > 0) {
    process.stdout.write(
      `→ 최종 수정이 늦은 쪽이 정본인지 커밋 이력으로 확인하고, 낡은 쪽을 갱신하세요.\n` +
        `  의도된 차이라면 drift.approvedDifferences 에 사유와 함께 기록하세요 — 그 뒤로는 조용히 둡니다.\n`,
    );
  }
  process.stdout.write(
    `[drift-watch] 미러 ${s.mirrors} — 새 차이 ${fresh.length} · 승인된 차이 ${suppressed}(조용) · 상대 없음 ${absent}(no-op)\n`,
  );
  // 계측 — 검사 결과를 시계열로 남긴다 (docs/13 §2 audit).
  logEvent({
    event: 'audit',
    gate: 'drift-watch',
    mirrors: s.mirrors,
    fresh: fresh.length,
    suppressed,
    absent,
  });
  process.exit(fresh.length > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('drift-watch.mjs')) {
  main().catch((e) => {
    process.stderr.write(`[drift-watch] 감시가 동작하지 않았습니다: ${e.message}\n`);
    process.exit(2);
  });
}
