/**
 * v1 로그 층의 테스트.
 *
 * 핵심 계약 둘을 본다 — **원문 명령이 로그에 들어가지 않는다**(접두사 정규화),
 * **기록 실패가 판정을 막지 않는다**(fail-open). 지표는 이 층을 신뢰하고 쌓이므로
 * 이 계약이 깨지면 위로 쌓인 전부가 무효다.
 *
 * 실행: node --test skeletons/log.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeCmdPrefix, logEvent, readLog, logPath } from './lib/log.mjs';

test('접두사 = 첫 토큰 + 첫 서브커맨드', () => {
  assert.equal(normalizeCmdPrefix('git push origin main'), 'git push');
  assert.equal(normalizeCmdPrefix('docker volume rm data'), 'docker volume');
});

test('⭐ 두 번째 토큰이 플래그·경로·리다이렉션이면 버린다 — 원문 유입 차단', () => {
  assert.equal(normalizeCmdPrefix('rm -rf /var/data'), 'rm');
  assert.equal(normalizeCmdPrefix('cat ./secret/path.txt'), 'cat');
  assert.equal(normalizeCmdPrefix('echo >file.txt'), 'echo');
  assert.equal(normalizeCmdPrefix("psql 'INSERT INTO t'"), 'psql');
});

test('빈 명령은 빈 접두사 — 던지지 않는다', () => {
  assert.equal(normalizeCmdPrefix(''), '');
  assert.equal(normalizeCmdPrefix('   '), '');
  assert.equal(normalizeCmdPrefix(null), '');
});

test('기록 → 읽기 왕복. ts 는 기록 시점에 찍힌다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  assert.equal(logEvent({ event: 'pass', gate: 'danger-guard', cmdPrefix: 'git status' }, root), true);
  assert.equal(
    logEvent({ event: 'fire', gate: 'danger-guard', rule: 'r1', decision: 'deny', probe: false, cmdPrefix: 'wipe-all' }, root),
    true,
  );
  const { events, broken } = readLog(root);
  assert.equal(events.length, 2);
  assert.equal(broken, 0);
  assert.equal(events[0].event, 'pass');
  assert.ok(events[0].ts, 'ts 가 자동으로 찍혀야 한다');
  assert.equal(events[1].rule, 'r1');
});

test('로그 파일이 없으면 빈 결과 — 오류가 아니다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  assert.deepEqual(readLog(root), { events: [], broken: 0 });
});

test('⭐ 깨진 줄은 건너뛰되 개수를 센다 — 못 읽은 줄을 모르는 집계는 집계가 아니다', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  logEvent({ event: 'pass', gate: 'g', cmdPrefix: 'ls' }, root);
  // 손상 시뮬레이션 — 로그 끝에 잘린 줄이 붙는다 (프로세스 중단 등).
  const p = logPath(root);
  const raw = readFileSync(p, 'utf8');
  appendFileSync(p, '{"event":"fire","broken', 'utf8');
  const r = readLog(root);
  assert.equal(r.events.length, 1);
  assert.equal(r.broken, 1);
  assert.ok(raw.length > 0);
});

test('⭐ 기록 실패는 false 를 돌려주고 던지지 않는다 — 로그는 게이트가 아니다', () => {
  // 파일을 루트처럼 넘겨 mkdir 를 실패시킨다.
  const root = mkdtempSync(path.join(tmpdir(), 'harness-log-'));
  const asFile = path.join(root, 'not-a-dir');
  writeFileSync(asFile, 'x', 'utf8');
  assert.equal(logEvent({ event: 'pass', gate: 'g', cmdPrefix: 'ls' }, asFile), false);
});
