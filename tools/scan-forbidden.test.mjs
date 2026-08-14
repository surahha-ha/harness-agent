/**
 * 게이트 자체의 테스트.
 *
 * 가드를 신뢰하려면 가드를 검증해야 한다. 그런데 검출 케이스를 쓰려면 "검출되어야 할 값" 을
 * 픽스처에 적어야 하고, 그러면 게이트 자신이 이 파일을 막는다 — 그래서 면제 표식(WAIVER)이 있다.
 * 픽스처 값은 전부 합성이다(사설 대역·예약 대역·example.com).
 *
 * 실행: node --test tools/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, WAIVER } from './scan-forbidden.mjs';

/** 면제 표식이 붙은 줄은 스캔되지 않으므로, 픽스처는 표식 없이 만들어 함수에 직접 넘긴다. */
const kinds = (text, terms) => scanText(text, terms).map((h) => h.kind);

test('사설 대역 IP 는 인프라 좌표로 잡는다', () => {
  const fixture = 'const host = "10.0.0.5";'; // scan-forbidden:allow
  assert.deepEqual(kinds(fixture), ['IP 리터럴']);
});

test('RFC 5737 예약 대역과 루프백은 통과시킨다', () => {
  assert.deepEqual(kinds('192.0.2.10 / 198.51.100.7 / 203.0.113.1 / 127.0.0.1'), []);
});

test('버전처럼 보여도 옥텟 4개면 잡는다 — 차단 게이트라 통과보다 검출이 낫다', () => {
  assert.deepEqual(kinds('build 8.5.1.2'), ['IP 리터럴']); // scan-forbidden:allow
});

test('메일 주소는 잡고 example 도메인은 통과시킨다', () => {
  const fixture = 'author: someone@acme-corp.co.kr'; // scan-forbidden:allow
  assert.deepEqual(kinds(fixture), ['메일 주소']);
  assert.deepEqual(kinds('author: dev@example.com'), []);
});

test('단일 라벨 호스트와 사설 TLD 는 내부망으로 본다', () => {
  assert.deepEqual(kinds('http://wiki/page'), ['내부망 호스트']); // scan-forbidden:allow
  assert.deepEqual(kinds('https://build.internal/job/1'), ['내부망 호스트']); // scan-forbidden:allow
});

test('공개 호스트와 로컬호스트는 통과시킨다', () => {
  assert.deepEqual(kinds('https://github.com/o/r 그리고 http://localhost:5173'), []);
});

test('금칙어는 대소문자를 무시하고 부분 일치로 잡는다', () => {
  assert.deepEqual(kinds('접두어 TBL_ORDER_M 참조', ['tbl_order']), ['금칙어']);
});

test('금칙어 목록이 비어도 구조적 패턴은 동작한다 — 목록 부재가 게이트 비활성이 아니다', () => {
  const fixture = 'db at 172.16.3.9'; // scan-forbidden:allow
  assert.deepEqual(kinds(fixture, []), ['IP 리터럴']);
});

test('면제 표식이 있는 줄은 통째로 건너뛴다', () => {
  const line = 'const ip = "10.1.2.3"; // ' + WAIVER; // scan-forbidden:allow
  assert.deepEqual(scanText(line), []);
});

test('한 줄에 여러 건이 있으면 각각 보고한다', () => {
  const fixture = '10.1.1.1 과 ops@acme-corp.co.kr'; // scan-forbidden:allow
  assert.deepEqual(kinds(fixture).sort(), ['IP 리터럴', '메일 주소']);
});

test('검출 위치는 1-기준 줄번호로 보고한다', () => {
  const fixture = ['첫 줄', '둘째 줄', 'ip 10.9.9.9'].join('\n'); // scan-forbidden:allow
  assert.equal(scanText(fixture)[0].line, 3);
});
