<div align="center">

# codex session continuity

**긴 Codex 작업을 차분하고 정확하게 이어 가세요.**

[English](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

![긴 Codex 작업을 차분하고 정확하게 이어 가세요.](images/hero.png)

</div>

로컬 기록을 보관하고 인계 노트를 작성한 뒤 같은 프로젝트에서 새 작업을 이어 가는 Windows 도구입니다. 새 작업은 노트를 먼저 읽고 필요할 때 근거를 조회합니다. 전체 대화를 새 프롬프트에 다시 넣는 기능은 아닙니다.

> [!IMPORTANT]
> OpenAI 공식 제품이 아닌 실험적 프리뷰입니다. 데스크톱의 로컬 인터페이스가 바뀌면 호환성 수정이 필요할 수 있습니다. 새 설치에서는 자동 이어가기가 일시 중지되어 있으므로 모델의 유효 컨텍스트와 임계값부터 확인하세요.

## 주요 기능

![주요 기능](images/overview.png)

| 기능 | 설명 |
| --- | --- |
| 작업 기록 보관 | 디스크에 저장된 대화와 도구 출력을 점진적으로 보관하고 검색 색인을 만듭니다. |
| 인계 내용 정리 | 원래 어시스턴트가 결정 사항, 진행 상황, 제한, 검증 및 다음 단계를 적습니다. |
| 기존 프로젝트 유지 | 프로젝트, 작업 폴더, 권한을 확인하고 checkout과 커밋하지 않은 파일을 유지합니다. |
| 첨부 자료 보존 | 지원되는 로컬·내장 첨부 파일과 출처를 저장합니다. 저장만으로 내용을 이해한 것은 아닙니다. |

## 세 단계 인계

![세 단계 인계](images/workflow.png)

1. 보관: 로컬 원문과 첨부 파일의 색인을 만듭니다.
2. 준비: 원래 어시스턴트가 HANDOFF.md와 고유 확인 토큰을 작성합니다.
3. 이어가기: 원래 턴이 끝나고 위치·권한 검증이 통과되면 새 작업 하나를 만듭니다.

## Windows 설치

로그인된 Codex Desktop, Node.js 24 이상, PowerShell 7 이상이 필요합니다. 정확한 작업 폴더를 앱의 프로젝트로 저장하고 별도의 관리 작업을 만든 뒤 UUID나 링크를 복사하세요. 관리 작업과 이어갈 작업은 달라야 합니다.

Releases에서 ZIP과 SHA256SUMS를 받아 SHA-256을 확인한 뒤 압축을 풉니다. PowerShell 7에서 압축을 푼 폴더를 열고 아래 자리표시자를 실제 관리 작업 UUID로 바꾸세요.

[Releases](https://github.com/maiijhcg/codex-session-continuity/releases)

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

기본 설치 폴더는 `%LOCALAPPDATA%\CodexSessionContinuity`입니다. 현재 사용자의 Windows 로그인 시 자동 시작을 기본 등록하여 재부팅 후 로그인하면 백그라운드에서 실행합니다. 관리자 권한은 필요 없으며 로그인 전 시스템 서비스가 아닙니다. 새 설치의 자동 이어가기는 일시 중지이고 이후에는 선택한 상태를 유지합니다.

`-NoStartup`은 로그인 자동 시작 등록을 생략하고 `-NoStart`는 즉시 실행을 생략합니다. `-InstallDir`, `-CodexHome`으로 경로를, `-SoftLimit`/`-HardLimit`으로 임계값을 지정합니다. `-WithIntegration`을 빼면 hook과 지침 설치를 나중으로 미룹니다. Hook은 Codex의 정상적인 신뢰 검토 절차를 거치며 자동 승인하지 않습니다.

## 수동 조작

![수동 조작](images/control.png)

| 키 | 기능 |
| --- | --- |
| **1** | 자동 이어가기 활성화 |
| **2** | 자동 기능 일시 중지; 원문 보관은 계속 |
| **3** | 프로세스·연결·요청 상태 새로 고침 |
| **4** | 이어갈 작업 하나를 명시적으로 선택; UUID나 전체 링크도 가능 |
| **5** | 메뉴 언어 선택 및 저장 |
| **0** | 설정을 바꾸지 않고 종료 |

먼저 3으로 프로세스, 최근 하트비트, 데스크톱 연결을 확인한 뒤 1 또는 4를 사용하세요. 실행 중인 작업을 우선하고 최근 활동순으로 표시합니다. 대기열 등록은 완료가 아닙니다. 같은 요청을 반복 선택하면 기존 대기 요청을 재사용합니다.

메뉴는 영어가 기본이며 영어, 번체 중국어, 간체 중국어, 일본어, 스페인어를 지원합니다. 문서는 한국어·프랑스어·러시아어·독일어도 제공하지만 해당 메뉴 번역은 아직 없습니다. 작업 이름, 기록, 저수준 진단은 원문을 유지합니다. 5는 언어를 저장하고 `-Language`는 해당 실행에만 적용됩니다.

```powershell
.\Codex-Session-Continuity.cmd -Language en
pwsh -NoProfile -File .\manual-switch.ps1 -Action Status -Language en -Json
```

## 임계값과 제한

예시 기본값은 소프트 500,000 / 하드 920,000 토큰이며 모든 모델에 적합하지 않습니다. 소프트 임계값은 끊김 없는 관찰 중 상향 통과할 때만 작동합니다. 시작·재개 시 이미 넘어선 값은 뒤늦게 재생하지 않고 현재 사용량의 하드 임계값을 기다립니다. 기본 압축은 다른 계산이나 더 작은 유효 창을 사용할 수 있습니다. 모델·압축 설정이나 컨텍스트 용량은 변경하지 않습니다.

## 데이터와 보안

설치 폴더의 `archive/`, `notes/`, 실행 중 `assets/`, SQLite, 설정, 로그에는 개인 정보가 포함될 수 있습니다. GitHub에 올리지 마세요. 별도 텔레메트리나 독립 클라우드 업로드 클라이언트를 추가하지 않지만 일반 Codex 메시지와 작업 생성은 기존 계정·서비스를 계속 이용합니다.

기록과 미디어를 자동 삭제하지 않습니다. 디스크 공간을 확인하고 별도로 백업하세요. 암호화, OCR, 음성 전사는 내장하지 않으며 원격 첨부도 몰래 내려받지 않습니다. 일시 중지는 이미 전송한 동작을 취소하지 않고, 프로세스를 완전히 멈추면 새 보관 작업도 멈춥니다.

[SECURITY.md](../SECURITY.md)

## 대기 및 오류

`waiting_handoff`는 원래 작업의 인계를 기다리고, `soft_expired`는 만료된 소프트 알림을 재전송하지 않는 상태입니다. `checkpoint_interrupted` 후에는 사용자가 다시 선택할지 결정합니다. `checkpoint_uncertain`/`creation_uncertain`은 결과를 확인한 뒤 처리해야 하며 무작정 재시도하지 않습니다. 프로젝트·권한이 다르면 중지하며 다른 폴더나 높은 권한을 임의로 사용하지 않습니다.

```powershell
node .\cli.mjs status
node .\cli.mjs tasks
node .\controller.mjs resolve "PASTE_TASK_UUID"
```

## 실행, 업데이트, 제거

다음 명령은 설치 폴더에서 실행합니다. 업데이트 전 프로세스를 중지하고 전체 비공개 실행 폴더를 백업한 뒤 같은 위치에 재설치하세요. 제거 과정은 프로그램, 설정, 원문, 노트, 첨부를 보존하며 Codex 작업을 삭제하지 않습니다.

```powershell
pwsh -NoProfile -File .\install-startup.ps1
pwsh -NoProfile -File .\install-startup.ps1 -Remove
pwsh -NoProfile -File .\stop.ps1
pwsh -NoProfile -File .\restart.ps1
pwsh -NoProfile -File .\uninstall.ps1
```

[자세한 Windows 가이드(영어)](WINDOWS.md) · [CHANGELOG](../CHANGELOG.md) · [NOTICE](../NOTICE.md)

공개 라이선스는 아직 정하지 않았으며 MIT/GPL을 가정하지 않습니다. NOTICE.md를 확인하세요. ImageGen 원본 그림은 기능 개념도이며 실제 화면이나 보장을 의미하지 않습니다.

## 인계 지시 언어와 권한 상속

기존 session의 인계 알림과 후속 session의 시작 지시는 `en`, `zh-Hant`, `zh-Hans`, `ja`, `es`, `fr`, `ko`, `ru`, `de`의 9개 언어를 지원합니다. 기본은 영어이며 메뉴 5에 저장한 언어를 따릅니다. 새 설치에는 `-HandoffLanguage ko`를 추가하세요. 기존 설치는 프로세스를 중지하고 `config.json`에 `"handoffLanguage": "ko"`를 추가한 뒤 재시작하세요. 업그레이드는 설정을 유지하며 이 속성을 삭제하면 메뉴 언어를 따릅니다. 일시적인 `-Language`는 백그라운드 지시를 바꾸지 않습니다. 한 번의 인계는 같은 언어를 유지하고 원래 제목, 경로, 명령, 권한 값, 확인 코드는 번역하지 않습니다.

새 session은 전역 기본값이나 관리 작업이 아닌 이전 session의 실제 sandbox와 승인 설정을 자동 상속합니다. 원본이 읽기 전용이면 전역이 Full access여도 읽기 전용을 유지해야 합니다. Codex의 정상 상속 경로를 사용하고 전송 직전에 원본을 다시 확인하며 생성 후 쓰기 범위, 네트워크 제한, profile을 검증합니다. 원본이 변경되면 다시 읽고, 불확실하거나 불일치하면 기존 ID를 보존한 채 중지합니다. 권한 상승, 전역 변경, 중복 생성은 하지 않습니다. 읽기 전용 원본이 HANDOFF.md를 저장할 수 없다면 사용자의 정상 권한 절차로 해결해야 합니다. 기존 로컬 버전은 자동으로 수정되지 않습니다.

