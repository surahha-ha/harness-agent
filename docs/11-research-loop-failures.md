# 리서치 — 자율 루프 실패 사례 (딥리서치 질문 2)

> **성격: 서술 문서(리서치 기록, 시점 박제).** 2026-08-14 조사.
> `08-roadmap.md` 의 딥리서치 질문 2 — "초기 자율 루프 세대가 왜 실패했고, 후속 세대가 무엇을 바꿨나" — 에 답한다.
> 모든 주장에 출처를 달았다. 2차 요약이 아니라 원 저장소·논문·개발자 본인 회고를 우선했다.

## 질문 재진술

v3(자율 루프)로 가기 전에, 같은 것을 먼저 시도한 세대들의 실패를 안다.

1. 1세대(2023: AutoGPT·BabyAGI 류)는 **어떻게** 실패했나 — 무한 루프, 목표 표류, 환각 태스크, 비용, 그라운딩 부재
2. 2세대(SWE-agent·OpenHands·Devin)는 **무엇을 구조적으로** 바꿨고, 각 변경이 어떤 1세대 실패를 겨냥했나
3. 현행 세대(Claude Code·Codex·Jules·Devin 2.x)는 자율을 어디까지 허용하고 사람을 어디에 남기나
4. 실패 원인의 분류와 구조적 해법의 짝표 → 이 하네스의 v1~v3 에 무엇이 있고 무엇이 비었나

## 1. 1세대 (2023) — "루프를 돌리면 자율이 된다"의 실패

AutoGPT(2023-03 공개)와 BabyAGI 의 공통 구조: **목표 → LLM 이 태스크 목록 생성 → 실행 → 결과를 다시
LLM 에 넣어 다음 태스크 생성**. 루프의 종료·판정·예산을 모두 LLM 자신에게 맡겼다. 실패는 그 지점들에서 났다.

| 실패 양상 | 실증 | 출처 |
| - | - | - |
| **무한 루프** | 동일 검색을 반복(#1994), "thinking" 루프에서 못 빠져나옴(#2726), 깨진 URL 을 끝없이 재시도(#3444). 검색→저장→검증→"더 조사 필요"→재검색의 순환 | AutoGPT GitHub issues, 사례 정리는 [vectara case study](https://github.com/vectara/awesome-agent-failures/blob/main/docs/case-studies/autogpt-planning-failures.md) |
| **과잉 계획·목표 표류** | 단순 질의에도 "불필요한 '전략적' 단계로 가득한 계획"을 만들어 최장 경로를 탔다. 원인 진단: 모델이 아니라 **goal 프롬프트 자체** | [Taivo Pungas 회고 (2023-05)](https://www.taivo.ai/__why-autogpt-fails-and-how-to-fix-it/) |
| **환각 태스크** | 자기가 가진 적 없는 능력(예: 설문 수행)을 전제로 태스크를 생성. 처방: 가용 도구를 명시적으로 제한 | 같은 글 |
| **그라운딩·기억 부재** | 자기가 이미 한 일을 몰라 같은 서브태스크를 재시도 — 루프의 주요 원인. 실행 결과가 판정에 연결되지 않음 | [Wikipedia: AutoGPT](https://en.wikipedia.org/wiki/AutoGPT), 위 이슈들 |
| **비용 인식 부재** | 초기 이슈 #6 이 "Auto-GPT 가 자기 실행 비용을 알게 하라"였다. 재시도 루프 = API 호출 폭주 | [AutoGPT issue #6](https://github.com/Significant-Gravitas/AutoGPT/issues/6) |

**실증 평가가 뒤늦게 도착했다.** 공개 당시 벤치마크가 없었고, 처음으로 Auto-GPT 류를 실제 의사결정
태스크로 잰 [Yang et al. 2023 (arXiv:2306.02224)](https://arxiv.org/abs/2306.02224) 은 순수 자율 실행의
한계를 확인하면서, **외부 의견(Additional Opinions — 지도학습 모델의 신호)을 루프에 주입**하는 것만으로
성능이 오른다는 것을 보였다 — "루프 바깥의 신호가 필요하다"는 첫 정량 증거다.

**만든 쪽의 자기 판정 둘이 이 세대의 결론이다.**

- AutoGPT 팀 스스로 [AgentMonitor 논문 (arXiv:2311.10538)](https://arxiv.org/abs/2311.10538)을 냈다 —
  에이전트의 사고·행동을 **문맥 인지 감시자가 감사하고 안전 경계를 넘으면 중단**시키는 프레임 없이는
  실환경 테스트조차 안전하지 않다는 인정이다.
- AutoGPT 는 2024 년 재작성에서 자율 루프 모델을 버리고 **그래프 기반 워크플로 플랫폼**으로 피벗했다 —
  사람이 블록으로 경계를 설계하고 AI 는 그 안에서 실행한다. 원조 코드베이스는
  "autonomous GPT-4 operation 을 시연한 실험 프로젝트"로 명시되어 보존만 된다
  ([AutoGPT Classic README](https://github.com/Significant-Gravitas/AutoGPT), [플랫폼 전환 정리](https://vibeagentmaking.com/blog/autogpt-got-100k-stars-and-then-what/)).
  BabyAGI 도 저자(Yohei Nakajima)가 처음부터 proof-of-concept 으로 규정했다
  ([babyagi repo](https://github.com/yoheinakajima/babyagi)).

> **요약**: 1세대의 실패는 모델 능력 부족이 아니라 **루프 설계**의 실패다 — 종료 조건·성공 판정·행동
> 공간·예산을 전부 판정 근거가 없는 자기 자신에게 맡겼다. 이후 세대의 변경 전부가 이 목록의 역상이다.

## 2. 2세대 (2024) — 태스크를 좁히고, 행동을 실행에 묶고, 판정을 밖에 둔다

### 구조 변경 3종과 겨냥한 1세대 실패

**① ACI — 행동 공간을 에이전트 전용으로 재설계.**
[SWE-agent (arXiv:2405.15793)](https://arxiv.org/abs/2405.15793) 는 "LM 에이전트는 고유한 필요를 가진
새로운 사용자 유형"이라는 전제로 Agent-Computer Interface 를 설계했다 — 간결한 검색·탐색 명령,
줄 윈도우 파일 뷰어, **린트가 내장돼 문법 깨진 편집을 반려하는 에디터**(guardrail), history collapsing
컨텍스트 관리. 겨냥: 환각 태스크(도구를 제한·명시), 그라운딩 부재(편집 즉시 기계 피드백),
컨텍스트 붕괴(이력 압축). SWE-bench pass@1 12.5%.

**② 실행 그라운딩 — 행동을 실행 가능한 코드로 통일.**
[CodeAct (arXiv:2402.01030)](https://arxiv.org/abs/2402.01030) 는 행동 공간을 Python 코드로 통일해
**모든 행동이 인터프리터 실행 결과라는 즉각 피드백을 받고, 새 관찰에 따라 이전 행동을 수정**하게 했다.
겨냥: 그라운딩 부재 — "했다고 생각"과 "실행돼서 결과가 나옴"의 분리를 없앴다.
[OpenHands (arXiv:2407.16741)](https://arxiv.org/abs/2407.16741) 가 이를 채택하고 **sandbox 실행 환경 +
event stream + 벤치마크 내장**으로 플랫폼화했다. 겨냥: 부작용(호스트 격리), 검증 부재(평가를 상시 장비로).

**③ 검증 게이트 — 성공 판정을 에이전트 밖의 테스트로.**
[SWE-bench](https://arxiv.org/abs/2310.06770) 는 태스크를 "GitHub 이슈 1건"으로 좁히고 완료를
**단위 테스트가 결정론적으로 판정**하게 했다. 겨냥: 목표 표류(목표가 이슈 1건으로 고정), 조기 완료
선언(자기 판정 무효), 무한 루프(에피소드 종료 조건과 스텝 상한이 하네스에 있음).
[Devin 의 기술 리포트](https://cognition.com/blog/swe-bench-technical-report)도 같은 판정 틀 위에서
unassisted 13.86% 를 보고했다.

### 그러나 2세대의 자율도 실전에서 깨졌다

Devin 1.0 실사용 평가([Answer.AI, 2025-01](https://www.answer.ai/posts/2025-01-08-devin.html)):
20개 실무 태스크 중 **성공 3 · 실패 14 · 불확정 3**, 어떤 태스크가 성공할지 패턴 예측 불가.
결정적으로 "**불가능한 경로를 막힌 줄 모르고 며칠씩 추구**"했다 — 1세대의 루프 실패가 벤치마크 밖
열린 태스크에서 규모만 키워 재현된 것이다. 벤치마크 게이트는 게이트가 있는 곳에서만 작동한다.

## 3. 현행 세대 (2025~) — 자율 구간을 게이트 사이로 한정한다

공통 패턴: **앞 게이트(계획 승인) — 격리된 자율 구간(샌드박스+실행 피드백) — 뒤 게이트(PR 리뷰)**.
자동 머지는 어느 제품도 하지 않는다.

| 제품 | 자율 허용 구간 | 사람이 남는 지점 | 출처 |
| - | - | - | - |
| **OpenAI Codex** | 네트워크 차단된 클라우드 샌드박스에서 테스트 통과까지 반복(RL 로 훈련됨). AGENTS.md 가 검증 명령을 지정 | PR 승인. 샌드박스 밖 부작용 원천 차단 | [Introducing Codex](https://openai.com/index/introducing-codex/) |
| **Google Jules** | 격리 클라우드 VM 에서 승인된 계획을 비동기 실행 | **실행 전 계획 검토·수정·승인**, PR 승인 (auto-merge 없음) | [Jules 워크플로 정리](https://machinelearningmastery.com/practical-agentic-coding-with-google-jules/) |
| **Devin 2.x** | 병렬 세션, 계획 확정 후 자율 작업 | Interactive Planning(작업 전 계획 정렬), confidence 보고, IDE 개입 | [Devin 2.0](https://cognition.com/blog/devin-2) |
| **Claude Code** | 권한 모드 스펙트럼(plan → default → acceptEdits → bypass)으로 자율 폭을 사용자가 선택. sandboxing 으로 승인 프롬프트 84% 감소. auto mode 는 **별도 분류기가 행동마다 사전 심사** | 되돌릴 수 없는 행동의 승인, checkpoint/rewind 로 사후 복구 | [permission modes](https://code.claude.com/docs/en/permission-modes) · [sandboxing](https://anthropic.com/engineering/claude-code-sandboxing) · [auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) |

### 장시간 실행의 실패 모드 — 게이트가 있어도 남는 것

[Anthropic 의 장시간 하네스 실험](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)이
여러 컨텍스트 윈도우에 걸친 무인 실행에서 확인한 실패와 완화책:

| 실패 모드 | 완화책 |
| - | - |
| one-shotting — 한 번에 다 하려다 반쯤 구현된 채 컨텍스트 소진 | 세션당 기능 1개, 머지 가능한 상태 유지를 명시 지시 |
| **조기 완료 선언** — 후속 세션이 "진행됐네, 끝났다" 판정 | 기능 목록을 **구조화된 JSON 아티팩트**로, `passes` 상태를 기계가 추적 |
| 세션 간 컨텍스트 손실 | compaction 만으로 부족 — **컨텍스트 리셋 + 구조화 인계**(progress 파일·git log) |
| 테스트 없이 완료 표시 | E2E(브라우저 자동화) 통과를 완료 조건으로 강제 |
| 불안정한 중간 상태 인계 | git checkpoint — 서술적 커밋으로 되돌림 지점 확보 |

자율 구간의 **길이** 자체가 측정 대상이다: [METR (arXiv:2503.14499)](https://arxiv.org/abs/2503.14499) 는
"50% 성공 time horizon"(사람 기준 소요 시간으로 잰 태스크 길이)으로 이를 정량화했다 — 자율 폭은
선언하는 것이 아니라 실측해서 정하는 값이라는 것으로, 이 프로젝트의 원칙(자율 = 측정된 신뢰의 함수)과
같은 결론이다.

## 4. 짝표 — 실패 원인 ↔ 구조적 해법

| 실패 원인 | 1세대 증상 | 구조적 해법 | 채택 사례 |
| - | - | - | - |
| **계획 오류** (과잉 계획·목표 표류) | 최장 경로 계획, 유사 태스크 재생성 | 태스크 단위 축소(이슈 1건=목표 고정) · **계획을 사람 승인 게이트 뒤에** | SWE-bench 태스크 정의, Jules·Devin 2.0 계획 승인 |
| **그라운딩 부재** | 환각 태스크, 능력 착각 | 행동=실행 가능한 코드(결과가 즉시 피드백) · 도구를 제한·명시한 ACI · 편집 시 린트 반려 | CodeAct, SWE-agent |
| **검증 부재** | 근거 없는 "완료" 자기 선언 | 판정을 에이전트 밖으로 — 결정론적 테스트 게이트 · 완료 상태의 기계 추적 · 테스트 통과를 보상으로 훈련 | SWE-bench, Anthropic feature-list `passes`, Codex RL |
| **컨텍스트 붕괴** | 한 일을 잊고 반복 → 루프 | 이력 압축(history collapsing) · 컨텍스트 리셋+구조화 인계 · 상태를 컨텍스트 밖 아티팩트(git·JSON)에 | SWE-agent, Anthropic 장시간 하네스 |
| **비용·무한 실행** | 종료 조건 없는 루프, 비용 무인식 | 스텝·에피소드 상한 · 외부 감시자의 중단 권한 · 실행 비용 계측 | 벤치마크 하네스 공통, AgentMonitor |
| **부작용(안전)** | 호스트에서 무제한 명령 | 샌드박스·네트워크 차단 · 종착점을 PR 로 고정(자동 머지 금지) · 행동별 권한 계층·사전 심사 | OpenHands, Codex, Jules, Claude Code |

세대를 관통하는 원리 하나: **루프가 스스로에게 주던 것(목표·판정·기억·예산·권한)을 하나씩
루프 밖의 구조로 빼낸 것**이 곧 세대 진화다.

## 5. 이 프로젝트 v1~v3 에의 시사점

### 이미 짝이 있는 것 — 골격이 겨냥과 일치한다

| 실패 원인 | 이 하네스의 대응 | 비고 |
| - | - | - |
| 부작용(안전) | 골격 1 (deny/ask 2어휘, 복구 경로, fail-closed) | 단 골격 1 스스로 밝히듯 **실수 방지 장치이지 보안 경계가 아니다** — 현행 세대의 샌드박스 계층에 해당하는 것이 없다. v3 의 무인 구간은 플랫폼 샌드박스(Codex·Jules 형) 위에서만 열어야 한다 |
| 검증 부재 | 골격 2 (test-first) · 골격 6 (수치 보고 `N/N`, 실패 분류, 건너뛴 단계 명시) · 골격 3 (작성자/판정자 분리) | v3 완료 기준 "사후 감사에서 거짓 그린 0" 과 같은 방향. 단 3·6 은 아직 절차 문서다 — **판정의 코드화가 v3 선행 조건** |
| 조기 완료 선언 | 골격 3 인계 체크리스트의 "미검증 범위" 필수 항목 · 골격 6 보고 형식 | Anthropic 의 feature-list JSON(`passes` 기계 추적)과 동형. 체크리스트→스키마 승격(이미 예약됨)이 그 경로다 |
| 계획 오류 | 골격 6 1단계(명세 확정 — 제품 결정이 걸리면 코드부터 만들지 않는다) + `{승인 주체}` 슬롯 | 현행 세대의 "앞 게이트(계획 승인)"에 대응. 앞·뒤 게이트 구조가 이미 있다 |
| 거짓 활성 | 골격 공통 규약 4 (활성 확인 — 미설치는 통과와 구별되지 않는다) | 조사한 어느 세대 문헌에도 명시된 적 없는 이 하네스 고유 항목. 무인 루프에서는 감시자 자신의 사망이 최대 위험이므로 v3 에서 가치가 커진다 |

### 비어 있는 것 — v1~v3 이 채워야 한다

1. **루프·예산 감시가 없다.** 1세대 최다 사망 원인(무한 루프·비용)에 대응하는 골격이 없다 —
   스텝 상한, 동일 행동 반복 감지, 비용 계측. v3 전에 골격이 하나 필요하고, 그 계측(스텝 수·반복률)은
   v1 metric 으로 먼저 잴 수 있다.
2. **세션 경계를 넘는 상태 아티팩트가 기계 검증되지 않는다.** 인계 체크리스트는 사람이 쓰는 문서다.
   Anthropic 실험의 결론은 "compaction 으로 부족, 구조화 아티팩트 + 리셋"이었다 — 인계의 스키마 승격이
   v2 항목으로 이미 예약돼 있으니, 그 스키마 설계 때 이 짝표의 "컨텍스트 붕괴" 행을 입력으로 쓴다.
3. **자율 구간의 길이를 정하는 실측이 없다.** METR 식 time-horizon 이든 개입률이든, "어느 길이의
   작업까지 무인으로 완주하는가"의 기준선이 v1 계측의 핵심 산출물이어야 v2 승격(ask→자동)의 근거가 된다.
   딥리서치 질문 1(eval 지표)과 여기서 합류한다.
4. **막힘 인식이 없다.** Devin 1.0 의 "불가능한 경로를 며칠씩 추구"는 게이트만으로 안 잡힌다 —
   진행 없음(동일 상태 반복·기준 미달 지속)을 스스로 보고하고 사람을 부르는 탈출 조건이 v3 설계에 필요하다.
   1번(루프 감시)과 같은 골격으로 묶일 수 있다.

## 출처

**1세대**
- Taivo Pungas, *Why AutoGPT fails and how to fix it* (2023-05) — <https://www.taivo.ai/__why-autogpt-fails-and-how-to-fix-it/>
- AutoGPT GitHub issues #6, #1994, #2726, #3444 — <https://github.com/Significant-Gravitas/AutoGPT/issues/6> 외 (사례 정리: <https://github.com/vectara/awesome-agent-failures/blob/main/docs/case-studies/autogpt-planning-failures.md>)
- Yang et al., *Auto-GPT for Online Decision Making* — <https://arxiv.org/abs/2306.02224>
- Naihin et al., *Testing Language Model Agents Safely in the Wild* (AutoGPT 팀) — <https://arxiv.org/abs/2311.10538>
- AutoGPT Classic README(실험 프로젝트 명시·지원 종료) — <https://github.com/Significant-Gravitas/AutoGPT> · 플랫폼 피벗 정리 — <https://vibeagentmaking.com/blog/autogpt-got-100k-stars-and-then-what/>
- BabyAGI — <https://github.com/yoheinakajima/babyagi>
- Wikipedia, *AutoGPT*(루프 보고 집계) — <https://en.wikipedia.org/wiki/AutoGPT>

**2세대**
- Yang et al., *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering* — <https://arxiv.org/abs/2405.15793>
- Wang et al., *Executable Code Actions Elicit Better LLM Agents* (CodeAct) — <https://arxiv.org/abs/2402.01030>
- Wang et al., *OpenHands: An Open Platform for AI Software Developers* — <https://arxiv.org/abs/2407.16741>
- Jimenez et al., *SWE-bench* — <https://arxiv.org/abs/2310.06770>
- Cognition, *SWE-bench technical report* — <https://cognition.com/blog/swe-bench-technical-report>
- Answer.AI, *Thoughts On A Month With Devin* (2025-01) — <https://www.answer.ai/posts/2025-01-08-devin.html>

**현행 세대**
- OpenAI, *Introducing Codex* — <https://openai.com/index/introducing-codex/>
- Google Jules 워크플로 — <https://machinelearningmastery.com/practical-agentic-coding-with-google-jules/>
- Cognition, *Devin 2.0* — <https://cognition.com/blog/devin-2>
- Anthropic, *Effective harnesses for long-running agents* — <https://anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- Anthropic, *How we built Claude Code auto mode* — <https://www.anthropic.com/engineering/claude-code-auto-mode>
- Anthropic, Claude Code sandboxing — <https://anthropic.com/engineering/claude-code-sandboxing> · permission modes — <https://code.claude.com/docs/en/permission-modes>
- Kwa et al. (METR), *Measuring AI Ability to Complete Long Software Tasks* — <https://arxiv.org/abs/2503.14499>
