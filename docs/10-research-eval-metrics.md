# 리서치 1 — 에이전트 자율성의 eval 을 무엇으로 재는가

> **성격: 서술 문서.** `08-roadmap.md` 딥리서치 질문 1 의 조사 기록 (2026-08-14).
> 결론이 v1 설계에 반영되면 그 결정은 별도 규범 문서로 승격한다 — 이 문서 자체는 근거 자료다.

## 1. 질문 재진술

v1 = 계측(eval) 층. "작업 완주율, 사람 개입 횟수·지점, 게이트 발동/오탐 비율" 을 재기로
정의만 해 두었다. 업계는 무엇을 어떻게 재고 있고, 그중 **1인 개발자가 자기 하네스 위에서
반복 측정 가능한 최소 집합**은 무엇인가. 특히 — 무엇이 로그만으로 자동 수집되고,
무엇이 사람 판정을 요구하나.

---

## 2. 발견

### 2.1 벤치마크가 재는 것 — 채점 하네스의 구조

| 벤치마크 | 헤드라인 지표 | 성공 판정 방식 | 사람이 개입하는 지점 |
| - | - | - | - |
| **SWE-bench Verified** (OpenAI, 2024) | resolved rate (500문제 중 해결 비율) | 저장소를 수정 전 상태로 복원 → 에이전트 패치 적용 → 실제 테스트 스위트 실행. **FAIL_TO_PASS**(수정 전 실패→후 통과) 전부 통과 **AND PASS_TO_PASS**(기존 통과 유지) 전부 유지 | 벤치마크 **제작 시점에만** — 사람 개발자들이 원본 샘플을 심사해 명세가 불명확하거나 테스트가 과도한 문제를 걸러 500개를 검증. 채점은 전자동 |
| **SWE-bench Pro** (Scale AI, 2025) | Pass@1 | 동일한 fail-to-pass 테스트 방식. 공개 731 + 비공개 858 + 상용 코드베이스 276 인스턴스로 오염(contamination) 저항 — 라이선스 장벽 + 비공개 저장소 | 문제 제작·비공개셋 관리. 발표 시점 최고 성적이 Pass@1 25% 미만 — 멀티파일·장시간 과제로 난도를 올림 |
| **Terminal-Bench 2.x** (Stanford/Laude, 2025~) | task resolution success rate | Docker 컨테이너 안에서 에이전트가 작업 → **테스트 스크립트가 최종 컨테이너 상태를 검증**. 태스크당 5회 시행해 분수 성공률 | 태스크 제작(사람이 쓴 해답 + 검증 스위트 동봉). 채점은 전자동. 대규모 병렬 실행은 Harbor 프레임워크 |
| **τ-bench** (Sierra, 2024) | pass@k 와 **pass^k** | LLM 이 시뮬레이션한 사용자와의 대화 + 도구 호출 후, **DB 최종 상태**를 정답 상태와 비교 | 도메인·정책 문서 제작. 채점 자동 |
| **METR HCAST/RE-Bench** | 50% time horizon (§2.2) | "자동 평가 가능한 명확한 성공 기준" 이 있는 태스크만 사용 | ① 사람 전문가가 각 태스크를 직접 수행해 **인간 기준 시간** 산출 ② reward hack 의심 플래그가 뜬 런만 사람이 감사 |
| **HAL** (Princeton, 2025) | accuracy × **cost** Pareto | 기존 벤치마크 11종을 통일 하네스로 재실행, 로그 분석 자동화 | 하네스 유지보수. 9모델×9벤치마크 21,730 롤아웃에 약 $40,000 — **eval 자체의 비용**이 병목임을 실증 |

세 가지 공통 패턴이 뚜렷하다.

1. **성공 판정은 사람이 아니라 "실행 가능한 검증기"가 한다.** 테스트 스위트(SWE-bench),
   컨테이너 상태 검사(Terminal-Bench), DB 상태 비교(τ-bench). 사람의 역할은 채점이 아니라
   **태스크 품질 관리**(명세 검증, 검증기 제작)와 **부정행위 감사**(reward hack)로 이동했다.
2. **신뢰성은 반복 시행으로 잰다.** 1회 성공(pass@1)과 k회 전부 성공(pass^k)은 다른 지표다.
   τ-bench: pass^k = pᵏ 로 지수 감쇠 — 평균 성공률 60% 이상인 에이전트도 pass^8 은 25% 미만.
   **자율 운용의 전제는 평균이 아니라 최악 케이스 신뢰성**이라는 것이 이 지표의 요지고,
   Terminal-Bench 의 5회 시행, Anthropic 모델 카드의 pass^k 채택으로 업계 표준이 됐다.
3. **정확도는 비용과 함께 본다.** HAL 의 발견 — 가장 비싼 모델이 Pareto frontier 에 있는 경우는
   드물고, 정확도 향상이 토큰 효율 향상을 동반하지 않는 경우가 많다.

### 2.2 "자율성" 자체를 재는 시도

**① METR — 50%-task-completion time horizon.** 자율성을 "성공률" 이 아니라
**"혼자 완주할 수 있는 작업의 길이(인간 소요 시간 기준)"** 로 잰다. 방법:
사람 전문가(경력 5년+)가 각 태스크를 수행한 시간의 기하평균으로 태스크 난도를 정의 →
모델별로 (인간 소요 시간 → 성공 확률) 로지스틱 곡선을 적합 → 성공률 50% 가 되는
인간-시간이 그 모델의 horizon. 2019년 이후 **약 7개월마다 2배** 증가했고, 2026년 현재
프런티어 모델은 시간~십수 시간대다. 80% horizon(신뢰 기준 상향)은 50% 보다 훨씬 짧다 —
같은 데이터에서 신뢰 요구치만 올려도 자율 범위가 크게 줄어든다는 점이 pass^k 와 같은 교훈.

**② Anthropic — 실사용 로그 기반 자율성 측정** (research: Measuring AI agent autonomy
in practice, 2026). 이 리서치 질문에 가장 직접적인 답이다. 지표를 **자동 수집**과
**LLM 판정**으로 나눠 보고한다.

| 지표 | 정의 | 수집 방식 |
| - | - | - |
| turn duration | 에이전트가 일을 시작해 멈출 때까지(완료·질문·중단) 경과 시간 | 자동. 99.9분위가 3개월 새 25분→45분 |
| auto-approve rate | 전체 승인 자동화 모드 세션 비율 | 자동. 신규 사용자 ~20% → 750세션+ 경험자 40%+ — **신뢰는 사용량에 따라 점진 축적** |
| interrupt rate | 턴당 사람이 끊은 비율 | 자동. 신규 ~5% → 경험자 ~9% — 자동 승인이 늘수록 **개입은 오히려 는다** (더 긴 일을 맡기므로) |
| agent-initiated stops | 에이전트가 스스로 멈추고 물은 횟수 | 자동. 복잡한 작업에선 사람 중단의 2배+. 1위 사유(35%)는 접근법 선택지 제시 |
| risk / autonomy score (1–10) | 도구 호출별 위험도·독립성 | **LLM 판정** (Claude 가 맥락 보고 채점) — 오검출 인정, 상한값으로만 해석 |
| safeguard / human-involvement | 안전장치·사람 관여 존재 여부 | **LLM 판정.** 호출의 80% 에 안전장치, 비가역 조작은 0.8% |

**③ Autonomy levels 프레임워크 — 자율주행 L0~L5 의 SW 에이전트 버전은 "있다, 여러 개,
표준은 없다."** 대표는 Feng·McDonald·Zhang (Knight Institute, 2025) 의 5단계 —
사용자 역할로 정의한다: L1 Operator → L2 Collaborator → L3 Consultant → L4 Approver →
L5 Observer(로그 감시와 비상 정지만). 핵심 주장 둘: **자율성은 능력이 아니라 설계 결정**이다
(능력 높은 에이전트도 매 행동 승인을 요구하게 설계할 수 있다), 그리고 레벨은 질적 구분이라
**측정 가능한 대리 지표는 결국 개입 지표**(누가 계획하고, 누가 승인하고, 언제 사람이 필요한가)다.
SAE J3016 을 명시적으로 본뜬 L0~L5 도 데이터 에이전트 서베이(arXiv 2510.23587),
Cloud Security Alliance 등에서 반복 제안되지만 업계 단일 표준은 아직 없다.
이 프로젝트 로드맵의 v0→v3 단계 구분은 이 계열과 정확히 같은 축(사람 역할의 축소)에 있다.

### 2.3 제품(운영) 쪽 지표 — 벤더가 실제로 보고하는 것

| 주체 | 공개 보고 지표 | 출처 성격 |
| - | - | - |
| **Anthropic** (Claude Code) | §2.2-② 의 로그 지표 전부 + auto mode 운영 데이터: 이전 기본값 대비 **중단 간 작업 시간 9배**, 도입 고객사의 세션 트랜스크립트 중 auto mode **거부(denial) 포함 비율 ~10%**. 위험 행동 검출에서 분류기가 수동 승인 클릭보다 더 많이 잡았고 제3자 레드팀 검증 | 공식 블로그·리서치 (1차) |
| **OpenAI** (Codex) | 자체 운영 지표 대신 **벤치마크 조합**으로 보고: SWE-bench Pro, Terminal-Bench, OSWorld, GDPval (시스템 카드). 코드 리뷰 능력은 예외적으로 **사람 전문가 평가** — 실제 오픈소스 커밋에 단 리뷰 코멘트의 정확성·중요도를 엔지니어가 채점 | 시스템 카드 (1차) |
| **Google** (Jules) | 사용량(베타 중 수만 태스크·14만+ 코드 개선)만 공식 발표. 완주율·개입률 류 자율성 지표는 미공개 | 공식 블로그 (1차) — 2차 리뷰들이 인용하는 "첫 시도 성공률 64%" 는 출처 미확인이라 채택하지 않음 |
| **학술 실측** (3사 외부) | GitHub 공개 PR 실측 (Watanabe et al. 2025): Claude Code 생성 PR 567건 중 **83.8% 가 결국 머지**, 머지된 것 중 **무수정 통합 54.9%** — 나머지 45.1% 는 사람 수정 필요. 리팩토링·문서·테스트에서 강하고 버그 수정·프로젝트 고유 규약에서 사람 보완 필요 | arXiv (1차 연구) |

종합하면 실무 지표의 축은 넷이다: **수락률**(acceptance/merge rate),
**무수정 통과율**(merge-without-modification — "롤백률" 의 역상), **개입 밀도**(중단 간 시간,
턴당 interrupt), **안전장치 판정 품질**(auto-approve 분류기의 검출률·denial 비율 = 게이트 오탐/미탐).

### 2.4 지표 분류표 — 무엇을 재고, 누가 판정하나

| 재는 것 | 대표 지표 | 판정 주체 | 자동화 가능성 |
| - | - | - | - |
| **능력** (할 수 있나) | resolved rate, pass@1, time horizon | 실행 검증기 (테스트·상태 검사) | ◎ 검증기만 있으면 전자동 |
| **신뢰성** (매번 되나) | pass^k, 5회 시행 분수 성공률, 80% horizon | 실행 검증기 × 반복 시행 | ◎ 전자동 (비용 k배) |
| **자율성** (혼자 하나) | interrupt rate, agent-initiated stops, turn duration, auto-approve rate | 세션 로그 | ◎ 전자동 |
| **품질** (받아줄 만한가) | 수락률, 무수정 통과율 | 사람 (머지·수정이라는 행동) | ○ 행동 로그로 준자동 — 별도 채점 불필요 |
| **게이트 품질** (안전장치가 옳았나) | 발동 수, denial 비율, 검출률/오탐률 | 발동은 로그, **옳았는지는 판정 필요** | △ 발동·우회는 자동, 오탐 라벨은 사람 또는 LLM 판정(상한값 취급) |
| **비용** | $/태스크, 토큰/태스크, 시행당 시간 | 로그 | ◎ 전자동 |
| **부정행위** (거짓 그린) | reward hack 감사 | **사람** (METR 도 플래그 런만 사람이 봄) | ✕ 표본 감사만 현실적 |

---

## 3. v1 설계에의 시사점 — 최소 지표 집합 제안

이 프로젝트가 v1 을 정의한 세 항목(완주율 · 개입 횟수·지점 · 게이트 발동/오탐)은
업계 지형과 정확히 대응한다 — 이름만 pass^k · intervention metrics · gate precision 이다.
1인 하네스에 이식할 때의 결정 사항:

### 원칙 셋 (업계에서 그대로 가져올 것)

1. **검증기 없는 태스크는 재지 않는다.** 모든 벤치마크가 "자동 평가 가능한 성공 기준" 을
   태스크 성립 조건으로 둔다. 이 하네스에서 그 검증기는 이미 있다 —
   **골격 2(test-first)가 만든 테스트가 곧 완주 판정기**다. eval 층을 새로 만드는 게 아니라
   기존 게이트의 판정 결과를 기록하는 층이다.
2. **평균이 아니라 최악을 본다.** 완주율은 pass@1 이 아니라 pass^k 방향으로 —
   1인 환경에서 k 는 작게(같은 유형 작업의 시계열 연속 성공이 사실상의 pass^k).
3. **자율성은 능력이 아니라 설계 결정이며, 측정 대리물은 개입 지표다** (Feng et al.).
   로드맵의 "개입 없음이 실측된 영역만 무인 승격" 원칙과 동일 — 업계가 독립적으로 같은 결론.

### 최소 지표 집합 (수집 방식별)

| # | 지표 | 업계 대응물 | 수집 |
| - | - | - | - |
| 1 | **작업 완주율** — 검증 게이트(테스트 그린) 통과로 종료한 작업 비율 | resolved rate | 자동 — 골격 2 판정 결과 로깅 |
| 2 | **개입 3분해** — ⓐ사람이 끊음(interrupt) ⓑ에이전트가 물음(agent-stop) ⓒ권한 프롬프트 승인/거부 | Anthropic 로그 지표 | 자동 — 훅(PreToolUse/Stop 류)이 이미 지나는 길목 |
| 3 | **개입 간 시간** (turn duration) | METR horizon 의 로컬 버전 | 자동 — 타임스탬프만 |
| 4 | **게이트 발동 수 + 발동 후 행동** — deny 후 사용자가 규칙을 우회·완화했는가(오탐의 행동적 신호) vs 다른 경로로 진행했는가(정탐 신호) | denial rate, 분류기 검출률 | 발동·후속 행동은 자동. **오탐 확정 라벨만 사람** — 발동 건수가 적으니(v0 실측상 세션당 0~수 건) 전수 라벨링 가능 |
| 5 | **비용/작업** — 소요 시간, (가능하면) 토큰 | HAL cost-Pareto | 자동 |

**사람 판정이 남는 곳은 둘뿐이다**: ④의 오탐 확정 라벨, 그리고 **거짓 그린 감사**
(게이트는 통과했지만 실제로는 미완 — reward hack 의 로컬판. METR 처럼 의심 플래그 런만
표본 감사). 나머지는 전부 훅 로그로 자동이다. Anthropic 이 보여준 LLM 판정(risk/autonomy
score)은 v1 에서는 넣지 않는다 — 그들 스스로 "상한값으로만 해석" 하는 지표를
1인 규모에서 돌릴 이유가 없고, 표본이 작아 사람 전수 라벨이 더 싸다.

### v0 이 이미 만든 첫 데이터 포인트

`07-v0-done.md` 가 예약해 둔 대로 — 부트스트랩 시간(30분 기준 대비 실측 7분)은 지표 5,
프로브 발동 기록은 지표 4, 필드 리포트의 발견 건수는 지표 2ⓑ의 원형이다.
v1 은 이것들을 필드 리포트의 산문에서 **구조화된 로그**로 옮기는 작업이다.

---

## 4. 출처

**벤치마크·채점 하네스**
- SWE-bench Verified 소개 (OpenAI): https://openai.com/index/introducing-swe-bench-verified/
- SWE-bench Pro 논문 (Scale AI): https://arxiv.org/abs/2509.16941 · 리더보드: https://labs.scale.com/leaderboard/swe_bench_pro_private
- Terminal-Bench 공식: https://www.tbench.ai/ (Harbor: harborframework.com)
- τ-bench 논문 (pass^k 정의): https://arxiv.org/abs/2406.12045 · Sierra 해설: https://sierra.ai/blog/benchmarking-ai-agents
- HAL (Princeton SAgE): https://github.com/princeton-pli/hal-harness · https://citp.princeton.edu/news/2025/sage-team-princeton-releases-holistic-agent-leaderboard

**자율성 측정**
- METR time horizon 논문: https://arxiv.org/abs/2503.14499 · 상시 갱신 페이지: https://metr.org/time-horizons/
- Anthropic, Measuring AI agent autonomy in practice: https://www.anthropic.com/research/measuring-agent-autonomy
- Feng, McDonald & Zhang, Levels of Autonomy for AI Agents (Knight Institute, 2025): https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1
- 데이터 에이전트 L0–L5 서베이: https://arxiv.org/abs/2510.23587

**제품·운영 지표**
- Anthropic, Running auto mode in production: https://claude.com/blog/auto-mode-in-production
- OpenAI GPT-5.3-Codex 시스템 카드: https://cdn.openai.com/pdf/23eca107-a9b1-4d2c-b156-7deb4fbc697c/GPT-5-3-Codex-System-Card-02.pdf
- Google Jules 정식 출시: https://blog.google/technology/google-labs/jules-now-available/
- Watanabe et al., 에이전트 생성 PR 실증 연구: https://arxiv.org/abs/2509.14745
