#!/usr/bin/env node
/**
 * 고유 정보 유입 차단 게이트.
 *
 * 번역 규율(docs/00-translation-discipline.md) §5 의 집행부.
 * 프로젝트 고유 좌표(인프라 주소·조직 신원)가 이 저장소에 들어오는 것을 커밋 전에 막는다.
 *
 * 판정은 두 갈래다.
 *   구조적 패턴 — 목록 없이도 잡힌다. IP 리터럴 · 메일 주소 · 내부망 형태의 호스트.
 *   금칙어 목록 — 조직명·식별자 접두어처럼 형태만으로는 못 잡는 것. `.forbidden-terms.local` 에서 읽는다.
 *
 * ⚠️ 금칙어 목록 파일 자체는 커밋하지 않는다 — 그 목록이 곧 유출물이기 때문이다(§5-5).
 *    목록이 없어도 구조적 패턴은 그대로 동작하므로, 없는 것이 게이트 비활성을 뜻하지 않는다.
 *
 * 성격: 차단 게이트라 fail-closed 다. 스캔에 실패하면 통과시키지 않고 종료코드 2 로 알린다.
 *       조용히 통과시키면 게이트가 죽은 걸 아무도 모른다.
 *
 * 사용:
 *   node tools/scan-forbidden.mjs            # 스테이징된 파일만 (커밋 훅용)
 *   node tools/scan-forbidden.mjs --all      # 추적 중인 파일 전체
 *   node tools/scan-forbidden.mjs <경로...>   # 지정 파일
 *
 * 종료코드: 0 통과 · 1 검출 · 2 게이트 오류
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ── 합성 값 허용 목록 ────────────────────────────────────────────────────────
// 픽스처는 합성 값만 쓴다(§5-3). 여기 있는 것들은 "쓰라고 정해둔 값" 이라 검출 대상이 아니다.
const ALLOWED_IP_PREFIX = [
  '192.0.2.', // RFC 5737 TEST-NET-1
  '198.51.100.', // RFC 5737 TEST-NET-2
  '203.0.113.', // RFC 5737 TEST-NET-3
];
const ALLOWED_IP_EXACT = ['127.0.0.1', '0.0.0.0', '255.255.255.255'];
// example.* 는 문서용 예약 도메인(RFC 2606), noreply 는 설계상 신원을 드러내지 않는 주소다.
const ALLOWED_MAIL_DOMAIN = /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i;

// 내부망임이 형태로 드러나는 호스트 — 단일 라벨(intranet/) 또는 사설 TLD.
const INTERNAL_TLD = /\.(local|internal|corp|lan|intra)$/i;

// 한 줄 면제 표식. 남용되면 게이트가 무의미해지므로 `git grep` 으로 전수 감사할 수 있게 문자열 하나로 고정한다.
export const WAIVER = 'scan-forbidden:allow';

const RE = {
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  mail: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  url: /\bhttps?:\/\/([^\s/'"`)\]}>]+)/gi,
};

/** 옥텟이 전부 0~255 인지 — 네 자리 버전 문자열도 걸리지만, 차단 게이트라 통과보다 검출이 낫다. */
function isIpv4(s) {
  return s.split('.').every((o) => o.length <= 3 && Number(o) <= 255);
}

/**
 * 텍스트 한 덩이를 판정한다. 파일 입출력과 분리해 둔 이유는 이 함수 자체를 테스트하기 위함이다.
 * @param {string} text
 * @param {string[]} terms 금칙어(대소문자 무시, 부분 일치)
 * @returns {{line:number, kind:string, value:string}[]}
 */
export function scanText(text, terms = []) {
  const hits = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    // 면제 표식 — 게이트 자신의 테스트 픽스처나 규율 문서의 "이런 건 걸린다" 예시처럼
    // 그 값이 있어야만 성립하는 줄에만 쓴다. grep 한 번으로 전수 감사되도록 한 줄 단위로만 허용한다.
    if (line.includes(WAIVER)) return;

    const at = (kind, value) => hits.push({ line: i + 1, kind, value });

    for (const m of line.matchAll(RE.ipv4)) {
      const v = m[0];
      if (!isIpv4(v)) continue;
      if (ALLOWED_IP_EXACT.includes(v)) continue;
      if (ALLOWED_IP_PREFIX.some((p) => v.startsWith(p))) continue;
      at('IP 리터럴', v);
    }

    for (const m of line.matchAll(RE.mail)) {
      if (ALLOWED_MAIL_DOMAIN.test(m[0])) continue;
      at('메일 주소', m[0]);
    }

    for (const m of line.matchAll(RE.url)) {
      // authority 에서 경로·userinfo·포트를 차례로 걷어낸 뒤 호스트만 본다.
      const authority = m[1].split('/')[0];
      const afterUser = authority.includes('@')
        ? authority.slice(authority.lastIndexOf('@') + 1)
        : authority;
      const host = afterUser.split(':')[0];
      if (!host) continue;
      if (host === 'localhost' || host === '127.0.0.1') continue;
      if (!host.includes('.') || INTERNAL_TLD.test(host)) at('내부망 호스트', m[1]);
    }

    for (const t of terms) {
      if (!t) continue;
      const hay = line.toLowerCase();
      const needle = t.toLowerCase();
      let from = 0;
      for (;;) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        at('금칙어', line.slice(idx, idx + t.length));
        from = idx + needle.length;
      }
    }
  });

  return hits;
}

/** 금칙어 목록 읽기. 없으면 빈 배열 — 구조적 패턴은 목록과 무관하게 동작한다. */
export function loadTerms(path = '.forbidden-terms.local') {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function targetFiles(argv) {
  const explicit = argv.filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit;
  const args = argv.includes('--all')
    ? ['ls-files']
    : ['diff', '--cached', '--name-only', '--diff-filter=ACM'];
  return execFileSync('git', args, { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function main() {
  let files;
  let terms;
  try {
    files = targetFiles(process.argv.slice(2));
    terms = loadTerms();
  } catch (e) {
    // 조용히 통과시키면 게이트가 죽은 걸 아무도 모른다.
    process.stderr.write(`[scan-forbidden] 게이트가 동작하지 않았습니다: ${e.message}\n`);
    process.exit(2);
  }

  const found = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue; // 바이너리·삭제된 경로는 대상이 아니다
    }
    if (text.includes(String.fromCharCode(0))) continue; // NUL 이 있으면 바이너리로 본다
    for (const h of scanText(text, terms)) found.push({ file: f, ...h });
  }

  if (!found.length) {
    process.stdout.write(`[scan-forbidden] 통과 — ${files.length}개 파일, 검출 0건\n`);
    process.exit(0);
  }

  process.stderr.write(`[scan-forbidden] 차단 — 고유 정보로 보이는 값 ${found.length}건\n\n`);
  for (const h of found) {
    process.stderr.write(`  ${h.file}:${h.line}  [${h.kind}]  ${h.value}\n`);
  }
  process.stderr.write(
    '\n번역 규율 §3 대로 좌표를 빼고 메커니즘만 남기세요. ' +
      '픽스처가 필요하면 합성 값(192.0.2.x · example.com)을 씁니다.\n',
  );
  process.exit(1);
}

// 테스트에서 import 할 때는 실행하지 않는다.
if (process.argv[1] && process.argv[1].endsWith('scan-forbidden.mjs')) main();
