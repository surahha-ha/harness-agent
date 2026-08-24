# harness-agent

프로젝트마다 다시 만들지 않는 **에이전트 작업 하네스**.
절차·게이트·역할 경계의 **빈 골격**과, 그 골격을 각 프로젝트의 지식으로 **채우는 절차**를 담는다.

## 세 가지 전제

1. **하네스는 완성된 지식이 아니라 "빈 골격 + 채우는 절차"다.**
   완성된 지식을 옮기려 하면 남의 프로젝트 설정을 강요하게 되고, 그걸 피하려 값을 지우면 일반론만 남는다.
2. **이식되는 것은 내용이 아니라 형식이다** — 절차의 순서, 게이트의 판정, 역할의 경계, 함정의 *유형*.
3. **프로젝트 고유값은 슬롯으로만 존재한다.** 경로·명령·임계값·식별자·호스트는 이 저장소에 들어오지 않는다.
   들어오는 건 그 값이 놓일 **자리의 이름**뿐이다.

## 구성

| 경로 | 내용 |
| - | - |
| `docs/00-translation-discipline.md` | 무엇을 골격으로 올리고 무엇을 프로젝트에 남기나 — **이 저장소의 헌법** |
| `docs/01-skeletons.md` | 골격 7종 (각각 슬롯 · 절차 · 실패 시나리오) |
| `docs/02-persona-panel.md` | 골격을 반문하는 다섯 렌즈 |
| `docs/03-panel-review-v0.md` | 그 반문의 결과와 확정된 정책 |
| `docs/04-bootstrap.md` | **새 프로젝트에 까는 절차 — 첫 30분** |
| `harness.config.example.mjs` | **모든 슬롯이 모이는 한 곳.** 판별 질문이 슬롯 옆 주석에 있다 |
| `skeletons/` | 설정을 읽어 도는 골격 구현 |
| `tools/` · `.githooks/` | 고유 정보 유입 차단 게이트 |

## 쓰기 — 새 프로젝트에 깔기

`docs/04-bootstrap.md` 를 따른다. 요지는 이렇다.

```bash
cp -r skeletons/ {프로젝트}/.harness/
cp harness.config.example.mjs {프로젝트}/harness.config.mjs

cd {프로젝트}
node .harness/danger-guard.mjs --status   # ← "설정됨 · 규칙 없음" 이 나와야 정상 (설정을 복사했으므로)
# harness.config.mjs 의 다섯 칸만 채운다 (bootstrap §2)
node .harness/danger-guard.mjs --status   # "활성 — deny N · ask M"

# 나머지 실행 골격은 켜기 전에 잰다 (bootstrap §4 순서)
node .harness/test-first.mjs --audit      # 경계 안인데 테스트 없는 파일 수를 먼저 센다
node .harness/drift-watch.mjs             # 짝 선언(drift.mirrors) 후 — 미러 어긋남 검사

# v1 계측 — 게이트 판정이 .harness/log.jsonl 에 쌓인다 (커밋 금지 — .gitignore 등록)
node .harness/metrics.mjs                 # 지표 5종 리포트 (미수집은 미수집으로 표기)
node .harness/metrics.mjs --note bootstrap-minutes --value 7   # 사람 라벨 기록
node .harness/metrics.mjs --note fp-reviewed --rule <규칙id>   # 발동 전수 판정 뒤 경계표 (라벨 0 ≠ 오탐 없음)

# v2 위임 승격 — 습관적 승인만 남은 ask 를 데이터로 allow 로 (docs/15 · promotion 슬롯 채운 뒤)
node .harness/metrics.mjs --promotions    # 4축 후보 판정 + 승격 레코드 상태
node .harness/metrics.mjs --promote <규칙id> --approved-by <이름>   # 후보만 적용 가능
node .harness/metrics.mjs --demote <규칙id> --text "사유"           # 수동 강등 (즉시 ask 복귀)
```

⚠️ **"비활성" 을 한 번 보고 간다.** 미설치와 통과는 겉보기가 같아서, 그 차이를 아는 것이 골격의 핵심이다.

## 개발 — 이 저장소에서

```bash
git config core.hooksPath .githooks                              # 유입 차단 게이트 활성화
node tools/scan-forbidden.mjs --all                              # 저장소 전체 스캔
node --test skeletons/*.test.mjs tools/*.test.mjs                # 테스트
```

프로젝트 고유 금칙어(조직명·호스트·식별자 접두어)는 **`.forbidden-terms.local` 에 두고 커밋하지 않는다** —
그 목록 자체가 유출 대상이기 때문이다. `.forbidden-terms.example` 을 복사해 쓴다.

## 상태

**v0 도달** — 완료 기준 다섯이 전부 그린이다(`docs/07-v0-done.md`).

골격 7종 명세 완료(각각 **슬롯 · 절차 · 익명화된 실패 시나리오** 3종 보유).
실행 골격 3종(1 위험 명령 가드 · 2 test-first · 4 드리프트 감시)은 코드로 구현돼 있고,
**셋 다 실제 프로젝트에서 돌았다** — 가드는 실세션 발동까지, 나머지 둘은 선실측과 드리프트 검출까지.
실적용 2회(단일 저장소 1 · 짝 저장소 1), 부트스트랩 실측 **7분**.

아직 안 잰 것은 `docs/07-v0-done.md` §판정 에 적혀 있다 — 특히 **코드 계약 커플링**은 어느 골격도 아직 보지 않는다.

**v1(계측) 완주** — 완료 기준 다섯이 전부 그린이다(`docs/13-v1-eval-design.md` §7·판정).
설계는 딥리서치 3건(`docs/10~12`)이 입력. 3회차 적용(`docs/14-field-report-03.md`)으로 기준
2·3·4·5 가 닫혔고, 그 설치처의 실사용 이틀째에 기준 1(실규칙 발동 — deny 2·pass 218·audit 3,
프로브 제외)이 닫혔다. 단 지표 5종 중 완주율·개입 분해는 아직 "미수집" — 완주는 로그 층이
실제로 돈다는 판정이지 지표가 전부 채워졌다는 뜻이 아니다.

**v2(위임 확대) 진입 — 승격 기준 설계·기제 구현 완료** — `docs/15-v2-promotion-design.md`(규범 문서).
위임 승격(ask→allow)은 판정 자동·적용은 사람 1회·강등만 전자동의 비대칭 구조로, 4축 판정식
(연속 무거부·실패 한도 0·습관적 승인 배제·분산)의 구조만 고정하고 임계값은 프로젝트 슬롯이다.
기제(후보 리포트·승격 레코드·강등 자동 실효)는 구현·실증됐다(§8 기준 1·2·3·5 그린) —
남은 것 = 기준 4, 실제 프로젝트의 절차 1건 완주(ask 실데이터 축적 대기).

진행 상태의 SSOT 는 `docs/07-v0-done.md`(v0)·`docs/13-v1-eval-design.md` §7(v1), 방향은 `docs/08-roadmap.md`.
