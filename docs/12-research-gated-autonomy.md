# 리서치 — 게이트 기반 자율성 (v1 딥리서치 질문 3)

> **성격: 서술 문서.** 2026-08 시점의 외부 제품·규제·논문 조사 기록이다. 제품 기능은 빠르게 바뀌므로
> 이 문서의 제품 서술은 시점 박제로 읽는다. 판단 근거는 각 절의 출처 URL.
> 질문의 출처: `08-roadmap.md` 딥리서치 목록 3번.

## 1. 질문 재진술

**사람 개입 지점을 점진 축소하는 구조를 실제 제품이 어떻게 구현하나.**

- 코딩 에이전트 제품의 권한/게이트 실물 — 무엇을 기본 차단하고, 승인을 어떤 단위로 기억·일반화하나.
- 반복 승인 데이터에서 자동 승격(ask → allow)으로 가는 구조가 실재하는가.
- 인접 도메인(자율주행·CI/CD·권한 시스템)에서 사람 개입 데이터로 자동화 범위를 넓히는 공통 형태.
- 이 저장소의 v1 계측(개입 로그 스키마)·v2 승격 기준에 이식할 것.

## 2. 제품별 게이트 구조 비교

| | Claude Code | OpenAI Codex | Cursor | Devin (CLI) | GitHub Copilot coding agent |
| - | - | - | - | - | - |
| **게이트 축** | 규칙(deny→ask→allow) × 모드 6종 × 훅 × 샌드박스 | approval policy × sandbox 2축 조합 | Run Mode 3종 + allowlist + 샌드박스 + classifier | 모드 5종 × 규칙(deny→ask→allow) | 실행 환경 자체가 게이트(격리 + 브랜치 제한 + 방화벽) |
| **기본 차단** | 읽기 외 전부 프롬프트(`default` 모드). 읽기 전용 명령 내장 목록은 무프롬프트 | `workspace-write`+`on-request`: 워크스페이스 밖 쓰기·네트워크·파괴적 동작은 승인. 네트워크 기본 off | 기본 `Auto-run in sandbox`: 샌드박스 가능 명령은 실행, 불가면 allowlist 또는 승인 | Normal: 읽기만 자동, 쓰기·셸은 승인 | `copilot/` 접두 브랜치에만 push 가능, PR은 사람 리뷰 필수, Actions 워크플로는 사람이 "Approve and run" 해야 실행, 아웃바운드는 방화벽 |
| **판정 어휘** | `deny` / `ask` / `allow`, deny→ask→allow 순 첫 매치. 구체성은 순서를 못 바꾼다 | `untrusted` / `on-request` / `on-failure` / `never` | allowlist / sandbox / classifier / ask 순 | `deny` / `ask` / `allow` (동일 순서) | 허용 목록에 없으면 차단(방화벽), 승인 없으면 미실행(워크플로) |
| **승인 기억 단위** | Bash: **명령 접두사 × 저장소, 영구**(`settings.local.json`). 파일 편집: **세션까지만** | **세션까지만.** 영구 allowlist 자동 생성 없음 | **세션까지만.** allowlist 는 사람이 `permissions.json` 에 작성 | 승인 시점에 선택: 1회 / 세션 / 프로젝트(공유) / 프로젝트(로컬) / 전역 | 기억 없음. 허용은 관리자가 도메인/URL 단위로 수동 설정 |
| **규칙 단위** | `Bash(npm test *)` 접두 패턴, `Read/Edit(glob)`, `WebFetch(domain:)`, MCP 서버·도구명 | 정책은 전역(폴더 신뢰 여부로 기본값 분기) | 자연어 지시(`allow_instructions` / `block_instructions`) | `Exec(prefix)` / `Read(glob)` / `Write(glob)` / `Fetch(pattern)` | 도메인(서브도메인 포함) 또는 URL |
| **완전 자율 모드** | `auto`(classifier 감시) / `bypassPermissions`(격리 환경 전제) | `--ask-for-approval never` + `danger-full-access` | `Run Everything` | Bypass / Autonomous(샌드박스가 대신 강제) | 없음 — 항상 격리 환경 + 사후 사람 리뷰 |
| **조직 강제** | managed settings 의 deny 는 어떤 스코프도 못 뒤집음 | 프로필로 배포 | 팀 설정 우선 | 조직 규칙은 Bypass 모드도 못 뒤집음 | org → repo 계층 설정 |

관찰 3가지.

1. **읽기/쓰기 분리는 전 제품 공통.** 읽기·조회는 어디서도 게이트 대상이 아니다(골격 1 절차 2와 동일).
2. **"승인 기억"의 스펙트럼이 넓다** — 기억 없음(Copilot) → 세션(Codex·Cursor) → 승인 시점에 스코프 선택(Devin)
   → 1회 승인 즉시 영구 규칙화(Claude Code Bash). Claude Code 는 복합 명령 승인 시 **하위 명령별로 규칙을 분해 저장**
   (최대 5개)해서, 한 번의 승인을 가장 넓게 일반화하는 쪽이다.
3. **게이트를 명령 패턴이 아니라 환경으로 거는 쪽이 늘고 있다.** Codex 샌드박스(OS 수준), Cursor 샌드박스,
   Devin Autonomous(샌드박스가 강제하니 셸은 무프롬프트), Copilot(격리 + 브랜치 + 방화벽).
   패턴 매칭의 한계는 실증돼 있다 — Cursor denylist 는 4가지 우회가 보고됐고(Backslash Security),
   allowlist 모드에서 셸 빌트인이 무승인 실행되는 CVE-2026-22708 이 있었다.
   골격 1 이 "보안 경계가 아니라 실수 방지 장치" 라고 적은 한계와 정확히 같은 결론이다.

## 3. 개입 데이터 → 자동 승격, 실재하는가

**판정: "반복 승인을 학습해 allowlist 를 자동 확장"하는 무인 구조는 조사한 어느 제품에도 없다.**
실재하는 것은 세 가지 인접 구조다.

| 구조 | 실물 | 자동화 정도 |
| - | - | - |
| **1회 승인 → 즉시 영구 규칙** | Claude Code "Yes, don't ask again" — N회 관찰 없이 첫 승인에서 저장소×명령접두사 단위로 영구화 | 승격 자체는 자동이나, 트리거는 매번 사람의 명시 선택 |
| **이력 스캔 → allowlist 제안** | Claude Code `/fewer-permission-prompts` 스킬 — 최근 50세션 트랜스크립트에서 Bash·MCP 호출을 추출, 명령+첫 서브커맨드로 묶고 읽기 전용만 걸러 프로젝트 설정에 넣을 allowlist 를 제안 | **제안까지 자동, 적용은 사람.** 조사 범위에서 "승인 데이터→승격" 에 가장 가까운 실물 |
| **ask 를 classifier 로 대체** | Claude Code `auto` 모드(별도 모델이 요청 이탈·미신뢰 인프라·prompt injection 3축 심사), Cursor `Auto-review`, Devin `Smart` | 승인 이력을 학습하는 대신, **판정 자체를 모델에 위임**해 ask 를 건너뜀 |

주목할 것은 업계의 방향이다. 승인 로그를 통계 내서 규칙을 승격하는 길(우리 v2 가상안)이 아니라,
**실시간 판정 모델로 ask 를 통째로 대체하는 길**로 갔다. Claude Code 는 2026-08-14부로 `auto` 모드가
신규 세션 기본값이 됐다. 이유는 공식 문서가 직접 적는다 — 습관적 승인(habitual human approval)보다
classifier 가 위험을 덜 놓친다는 것. **ask 의 축적이 신뢰를 만드는 게 아니라, ask 가 많으면 사람이
안 읽는다**는 전제다. 경고 피로로 감시가 죽는다는 골격 4 §7과 같은 관찰이다.

**역방향(강등)은 데이터 기반 자동이 실재한다.** Claude Code auto 모드는 classifier 가
**3회 연속 또는 누적 20회** 차단하면 auto 를 중단하고 프롬프트 모드로 복귀한다(임계값 비설정 가능,
허용 1회가 연속 카운터를 리셋). 승격은 사람 손에 남기고 강등만 자동화한 비대칭 —
아래 인접 도메인의 공통 형태와 일치한다.

부가 발견: Claude Code 는 auto 모드 진입 시 `Bash(*)` 같은 **광역 allow 규칙을 오히려 떨어뜨린다**
(협소 규칙만 유지, 이탈 시 복원). 자율 모드가 곧 규칙 완화가 아니라, 판정 주체 교체임을 보여준다.

## 4. 인접 도메인 선례

### 자율주행 — CA DMV disengagement report

13 CCR §227.50: 자율주행 시험 허가를 받는 순간부터 **개입(disengagement) 데이터 보존 의무**가 생기고,
매년 1월 1일까지 보고한다. 스키마가 규제로 고정돼 있다 —

- disengagement 의 정의: 기술 결함 감지로 자율 모드가 해제됐거나, 안전을 위해 시험 운전자가 즉시 수동 전환한 사건
- 건별 기록: 개입 주체(AV 시스템이 넘겼나 / 운전자가 뺏었나), 시점, 위치 유형(interstate/freeway/highway/rural/street/parking), 상황·원인 서술
- 총 자율 주행 마일 — 분모. **miles per disengagement 가 사실상의 자율성 지표**가 된다
- 경보 → 수동 전환까지의 시간

한계도 실증돼 있다: "무엇을 보고할 개입으로 치는가" 를 제조사가 각자 정의해 **수치 간 비교가 오염**됐다.
지표가 허가·평판에 걸리자 정의를 좁히는 게이밍이 생겼다. 로그 스키마에서 **판정 기준 자체를 스키마에
고정하지 않으면 지표가 게이밍된다**는 선례다.

### CI/CD — progressive delivery (Argo Rollouts)

배포 승격을 사람 승인에서 **선언된 지표 게이트**로 옮긴 실물.

- `AnalysisTemplate` 에 `successCondition` / `failureCondition` 을 선언, 카나리 진행 중 `AnalysisRun` 이 측정
- `failureLimit` **기본 0** — 허용 실패 횟수를 명시적으로 올리지 않으면 한 번의 실패로 전체 분석이 실패
- `consecutiveSuccessLimit`(v1.8) — **연속 성공 N회**를 통과 조건으로 요구 가능. "N회 연속 무실패" 승격 기준의 실물이 여기 있다
- 실패 → **자동 abort·롤백**(카나리 가중치 0으로 복귀). 승격은 단계 선언대로, 강등은 즉시 자동
- **Inconclusive → pause, 사람 개입 요구.** 자동 판정이 서지 않는 것은 자동으로 처리하지 않는다

### 권한 시스템 — just-in-time elevation (Microsoft Entra PIM)

"항상 허용" 승격의 반대 방향 설계. 상시 권한(standing access)을 없애고 **eligible / active** 를 가른다 —
자격은 미리 부여하되, 실제 권한은 요청 시에만 사유·MFA·(민감 역할은) 승인자를 거쳐 **시간 제한부로 활성화**,
만료 시 자동 회수, 전 과정 감사 로그. "이 명령을 영원히 allow" 대신 "이 세션·이 시간만 allow + 전량 기록" 이
운영 보안의 정답으로 자리잡았다는 뜻이다. Claude Code 파일 편집 승인이 세션까지만 사는 것과 같은 형태.

### 공통 형태

1. **개입·실패 이벤트를 스키마 있는 로그로 강제한다.** 로그가 먼저, 자동화 판단이 나중 (§227.50).
2. **승격 기준은 선언적 지표다** — 연속 성공 N, 실패 한도 0. 사람의 인상이 아니다 (Argo).
3. **강등은 자동·즉시, 승격은 보수적.** 실패 1회에 롤백하고, 승격은 게이트를 다 통과해야 한다 (Argo, Claude auto 모드 3/20 임계).
4. **판정 불능(inconclusive)은 사람에게.** 애매함을 자동으로 밀지 않는다 (Argo pause, 골격 2 "애매하면 ask" 와 동일).
5. **넓게-영구 허용보다 좁게-한시 허용 + 전량 기록** (PIM).

### 논문 선례 (참고)

- *Levels of Autonomy for AI Agents* (arXiv:2506.12469) — 사용자 역할 5단계(operator → collaborator →
  consultant → approver → observer)로 자율성을 등급화. 자율성 수준은 능력이 아니라 **의도적 설계 결정**이며,
  "autonomy certificates" 로 등급을 외부 검증하자는 제안. 단계 정의는 있으나 승격 판정 데이터는 다루지 않는다.
- *Governed AI-Assisted Engineering* (arXiv:2606.22484) — 규제 도메인용 3단(human-in-the-loop /
  human-over-the-loop / automated-with-monitoring) + 4입력 결정 함수(규제 영향·고객 근접성·**가역성**·데이터
  민감도)로 작업을 단에 배정. 가역성을 판별 축으로 쓰는 점이 골격 1 의 판별 질문("5분 안에 원상복구 수단이
  있나")과 같다. 역시 시간에 따른 자동 승격 기준은 제시하지 않는다.

논문 쪽도 결론은 같다 — **등급의 어휘는 있고, 등급 간 승격을 데이터로 판정하는 표준은 아직 없다.**

## 5. 이 저장소에의 시사점

### v1 — 개입 로그 스키마

가장 직접적인 이식 대상은 Claude Code 의 OpenTelemetry 이벤트 `claude_code.tool_decision` 이다.
게이트 판정을 이미 이 스키마로 방출한다:

- `decision`: `accept` / `reject`
- `source`: `config`(규칙·모드가 자동 판정) / `hook` / `user_permanent`("don't ask again") /
  `user_temporary`(1회 승인) / `user_reject` / `user_abort`(프롬프트를 답 없이 닫음)
- `tool_name` · `tool_use_id` (+ 옵션으로 도구 파라미터)

여기서 배울 핵심은 **사람의 응답을 4갈래로 가른 것**이다. "승인" 하나가 아니라
영구 승인 / 1회 승인 / 거부 / 이탈을 구분해야, 나중에 "습관적 승인" 과 "판단한 승인" 을 가를 수 있다.
§227.50 을 합쳐, v1 계측이 ask 발동마다 남길 최소 필드:

| 필드 | 값 | 근거 선례 |
| - | - | - |
| 시점·세션·작업 유형 | — | 공통 |
| 게이트·규칙 식별 | 어느 골격의 어느 규칙이 발동했나 | `tool_name`+규칙 대응 |
| **정규화된 명령 패턴** | 원문이 아니라 접두사 단위(승격의 단위가 이것이므로 로그 단위도 이것) | Claude Code 규칙 단위, `/fewer-permission-prompts` 의 "명령+첫 서브커맨드" 묶기 |
| 판정 | `deny` / `ask` (골격 공통 규약 §6의 2어휘 유지) | — |
| 판정 출처 | 규칙 자동 / 사람 | `source` |
| **사람 응답 4갈래** | 영구 승인 / 1회 승인 / 거부 / 이탈 | `tool_decision` |
| 거부 사유 | 거부 시 한 줄 (자유 서술) | §227.50 원인 서술 |
| **응답 지연** | ask 표시 → 응답까지의 시간. 즉답의 연속은 습관적 승인의 신호 | §227.50 경보→수동전환 시간 |
| 분모 | 같은 기간의 총 게이트 통과(무발동) 횟수 — 발동만 세면 비율이 없다 | §227.50 총 주행 마일 |

⚠️ §227.50 의 교훈: **"무엇을 개입으로 세는가" 를 스키마 문서에 고정**하고 바꿀 때 기록을 남긴다.
정의가 흔들리면 v2 승격 판정의 근거 데이터가 통째로 오염된다.

### v2 — 승격 기준

- **"N회 연속 무거부 → 자동 승격" 을 그대로 구현한 제품은 없다.** 있는 것은
  ①연속 성공 N·실패 한도 0을 **선언적 기준**으로 두는 게이트(Argo `consecutiveSuccessLimit`·`failureLimit`),
  ②이력 스캔 → **제안까지만 자동**(`/fewer-permission-prompts`), ③강등만 자동(auto 모드 3연속/누적20).
- 따라서 v2 승격의 형태는: **판정은 데이터로 자동(연속 무거부 N + 거부 0 + 이탈 0), 적용은 `{승인 주체}` 의
  1회 확인**으로 두는 것이 실재 선례와 정합한다. 골격 공통 규약 §5(승인 주체 슬롯)와도 맞는다.
- **강등 규칙을 승격 규칙과 함께 정의한다.** 승격된 allow 에서 거부·사고가 1건이라도 나오면 즉시 ask 복귀
  (Argo 의 abort, auto 모드 fallback). 승격만 있고 강등이 없으면 신뢰가 단조증가하는 가짜 지표가 된다.
- **승인 횟수만으로 승격하지 않는다.** 응답 지연이 짧은 즉답 연속은 "마찰 없음" 이 아니라 "안 읽음" 일 수 있다.
  auto 모드가 기본값이 된 근거 자체가 습관적 승인의 무가치였다. 지연·이탈(`user_abort`)을 같이 봐야
  마찰 없음이 **실측**된다 — 승격 원칙("마찰 없음이 실측된 영역만")의 '실측' 이 정확히 이 구분이다.
- **승격 단위는 규칙 단위와 일치시킨다.** 명령 접두사 × 저장소(Claude Code), 매처 × 스코프(Devin).
  세션 단위 승인을 아무리 쌓아도 규칙 단위로 정규화돼 있지 않으면 승격할 대상이 없다.
- 장기 방향의 참고: 업계는 ask 축적→규칙 승격보다 **classifier 대체**로 갔다. 이 저장소의 가드는
  보안 경계가 아닌 실수 방지 장치(골격 1 한계)이므로 규칙 승격 경로가 여전히 유효하지만,
  v3 자율 루프 설계 시 "ask 총량을 줄이는 제3의 길" 로 재검토할 것.

## 6. 출처

**코딩 에이전트 제품 (공식 문서)**
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code permission modes / auto 모드 (classifier, 3·20 임계, 기본값 전환): https://code.claude.com/docs/en/permission-modes
- Claude Code auto 모드 엔지니어링 해설: https://www.anthropic.com/engineering/claude-code-auto-mode
- Claude Code OTel `tool_decision` 이벤트: https://code.claude.com/docs/en/monitoring-usage
- `/fewer-permission-prompts` 발표(Boris Cherny): https://www.threads.com/@boris_cherny/post/DXM_ATCjwKj
- OpenAI Codex approvals & security: https://developers.openai.com/codex/agent-approvals-security
- OpenAI Codex sandboxing: https://developers.openai.com/codex/concepts/sandboxing
- Cursor Run Modes: https://cursor.com/docs/agent/security/run-modes
- Cursor denylist 우회 보도(Backslash Security 분석): https://www.theregister.com/2025/07/21/cursor_ai_safeguards_easily_bypassed/
- Devin CLI permissions: https://docs.devin.ai/cli/reference/permissions
- GitHub Copilot coding agent 방화벽: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall
- GitHub Copilot coding agent 워크플로 승인(선택적 해제): https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/

**인접 도메인 (원자료)**
- 13 CCR §227.50 (disengagement 보고 규정): https://www.law.cornell.edu/regulations/california/13-CCR-227.50
- CA DMV disengagement reports: https://www.dmv.ca.gov/portal/vehicle-industry-services/autonomous-vehicles/disengagement-reports/
- 지표 게이밍 지적(Fenwick): https://www.fenwick.com/insights/publications/autonomous-vehicle-reporting-data-is-driving-av-innovation-right-off-the-road
- Argo Rollouts Analysis: https://argo-rollouts.readthedocs.io/en/stable/features/analysis/
- Microsoft Entra PIM: https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-configure

**논문**
- Levels of Autonomy for AI Agents: https://arxiv.org/abs/2506.12469
- Governed AI-Assisted Engineering (GAIE): https://arxiv.org/abs/2606.22484
