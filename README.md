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
node .harness/danger-guard.mjs --status   # ← 처음엔 "비활성" 이 나와야 정상
# harness.config.mjs 의 다섯 칸만 채운다 (bootstrap §2)
node .harness/danger-guard.mjs --status   # "활성 — deny N · ask M"
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

골격을 채우는 중. 각 골격은 **슬롯 · 절차 · 익명화된 실패 시나리오** 3종을 모두 갖출 때 완성으로 본다.
