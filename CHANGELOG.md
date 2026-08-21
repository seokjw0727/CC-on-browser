# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Full bilingual (EN/KO) release notes live on the
[GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases) page.

## [Unreleased]

## [1.10.2] - 2026-08-21

> **이 릴리스는 v1.9.5 · v1.10.0 · v1.10.1의 변경 내용을 모두 함께 담습니다.** 세 버전은
> 태그까지 올라갔지만 아래에서 고친 브라우저 테스트 실패로 릴리스가 만들어지지 못했습니다.
> 실제로 배포된 마지막 버전은 **v1.9.4**이므로, 거기서 올라오시는 경우 세 버전의 변경(브라우저를
> 닫을 때의 세션 정리, 실행 중 작업 도크·설정 4탭·사이드바 정보, `/clear`·`/compact` 접기 등)까지
> 한꺼번에 받게 됩니다. 항목 전체는
> [CHANGELOG](https://github.com/seokjw0727/CC-on-browser/blob/master/CHANGELOG.md)에 있습니다.
> (This release carries everything from v1.9.5, v1.10.0 and v1.10.1 as well — all three were
> tagged but never published, blocked by the browser test fixed below. The last actually
> published version was v1.9.4, so upgrading from there brings all of it at once; the full
> list is in the CHANGELOG.)
>
> **1.10.2에서 더해진 변경 자체는 제품 동작에 영향이 없습니다.** 릴리스 파이프라인을 세 번
> 연속 막던 브라우저 테스트 실패를 고친 것입니다 — 개발·테스트용 가짜 스택이 서버에 자기
> 버전을 알려 주지 않아 화면 상단에 거짓 "버전이 다릅니다" 경고가 떴고, 그 경고가 채팅 맨 위
> "이전 메시지 더 보기" 버튼을 덮어 클릭 테스트를 흔들고 있었습니다.
> (What 1.10.2 itself adds has no product-behaviour impact: it fixes the browser test that
> blocked the last three releases — the dev/E2E fake stack never told the server its own
> version, so a bogus version-skew toast covered the "load earlier" button.)

### Fixed
- **개발·E2E용 가짜 스택(`scripts/dev-fake.mjs`)이 자기 버전을 서버에 알려 주지 않던 것.**
  실제 진입점(`bin/cc-on-browser.mjs`)은 처음부터 `startServer`에 `version`을 넘겼지만 이
  스크립트는 빠뜨려, `/api/bootstrap`이 `version: null`을 돌려줬습니다. 화면은 "서버 버전을
  모른다"를 곧 버전 스큐의 증거로 읽으므로(의도된 설계), 가짜 스택으로 띄운 화면에는 페이지를
  열 때마다 붉은 스큐 경고 토스트가 떴습니다. 그 토스트는 상단 중앙에 6초간 떠 채팅 최상단의
  "이전 메시지 더 보기" 버튼을 덮었고, Playwright의 클릭 대상 검사가 실패·재시도하며 스크롤을
  흔들어 윈도잉 테스트가 간헐 실패했습니다(v1.9.5·v1.10.0·v1.10.1 릴리스 3회 차단).
  윈도잉·앵커 보정 로직 자체는 정상이었고 손대지 않았습니다.
  덤으로, 이 가짜 경고가 가려 놓던 **진짜** 에러 토스트가 이제 보입니다.
  (The fake dev/E2E stack now reports its own version like the real entry point does.)
- **릴리스 워크플로의 재실행 경로.** 이전 실행이 체크섬(`.sha256`)만 올리고 tarball 업로드에서
  죽은 경우, 자산 두 개를 한 번에 올리던 마지막 단계가 남아 있는 체크섬과 충돌해 재실행이
  영영 실패했습니다. 이제 tarball과 체크섬을 나눠 올립니다 — tarball은 `--clobber` 없이
  (같은 태그의 배포 산출물을 말없이 갈아치우지 않는다는 계약 유지), 체크섬만 덮어씁니다.
  (Release re-runs no longer dead-lock on a leftover checksum asset.)

### Added
- **버전 배선 회귀 가드(E2E).** 정보 모달에서 "데몬 버전"이 채워져 있고 번들 버전과 같으며
  스큐 배너가 없음을 단언합니다. 토스트가 아니라 bootstrap이 채운 값을 보므로 토스트의
  6초 수명과 경합하지 않습니다.
  (An E2E guard that asserts the daemon version actually arrives from `/api/bootstrap`.)

## [1.10.1] - 2026-08-21

> 탭을 모두 닫으면 실행 중이던 `claude` 세션도 확실히 함께 끝납니다. 데몬이 내려가기 전에
> 세션 프로세스와 그 자식(셸·MCP 서버)까지 정리하고 실제 사망을 확인하므로, 화면 없이
> 계속 돌며 구독을 소모하던 고아 프로세스가 남지 않습니다.
> (Closing the last tab now really ends the running `claude` session — the daemon
> force-kills the session's process tree and confirms it is gone before exiting, so no
> orphaned CLI keeps running and burning quota.)

### Fixed
- **브라우저를 닫으면 실행 중이던 CLI 세션도 확실히 함께 끝납니다.** 지금까지는 탭을 모두
  닫아 데몬이 내려갈 때, 종료 경로가 세션 프로세스의 사망을 기다리지 않았습니다 — 세션에
  "그만"만 전해 두고 곧바로 프로세스를 빠져나갔고, 그 뒤처리를 맡던 타이머는 발화할 기회가
  없었습니다. Windows에서는 부모가 죽어도 자식이 살아남으므로, 턴이 진행 중이던 `claude`가
  화면 없이 계속 돌며 구독을 소모할 수 있었습니다. 이제 종료 경로가 **우아한 종료 →
  강제 트리 종료 → 실제 사망 확인**을 마친 뒤에야 데몬을 내리고, CLI가 띄운 셸·MCP 서버
  같은 손자 프로세스까지 함께 정리합니다(Windows는 `taskkill /T`, POSIX는 프로세스 그룹).
  종료 중에 시작된 세션도 거부해 장부 밖에서 태어나는 고아를 막습니다. 정리를 끝내 확인하지
  못한 경우에는 조용히 넘어가지 않고 사유를 로그로 남깁니다.
  절전·리드 닫힘 생존과 원격 제어를 켜 둔 동안의 생존은 **그대로**입니다.
  (Closing the browser now really ends the CLI session: shutdown waits for a graceful exit,
  force-kills the process tree, and confirms death before the daemon exits — orphaned
  `claude` processes could previously keep running, and burning quota, after every tab
  was closed. Sleep/lid-close survival and remote-control pinning are unchanged.)

## [1.10.0] - 2026-08-20

> 실행 중인 셸·서브에이전트를 입력창 밖 독립 카드로 꺼내 눌러서 내용을 볼 수 있게 하고,
> 설정 팝업을 테마·세션·플러그인·업데이트 네 탭으로 나눴습니다. 사이드바에는 앱·데몬·CLI
> 버전을 보여 주는 '정보'가 생겼고, 설정에서 새 버전을 직접 확인할 수 있습니다.
> `/clear`·`/compact` 위의 지나간 대화도 이제 화면에서 접힙니다.
> (Running shells and subagents moved out of the composer into an expandable dock, the
> settings popup became four tabs, a new sidebar "정보" panel reports app/daemon/CLI
> versions with an on-demand update check, and history above `/clear`·`/compact` folds away.)

### Added
- **사이드바 하단에 '정보'가 생겼습니다.** 앱(번들) 버전, 데몬 버전, Claude CLI 버전,
  플랫폼, 포트, 저장소 링크를 한 화면에서 봅니다. 값은 앱을 켤 때 한 번 받는
  `/api/bootstrap` 응답에서만 오고(모달을 열 때 다시 조회하지 않습니다), 모르는 값은
  빈 칸이 아니라 "알 수 없음"으로 표시합니다. 서버와 화면의 버전이 어긋나 있으면 그
  경고도 여기 함께 뜹니다 — 판정은 사이드바 하단 경고와 같은 값을 씁니다.
  (New sidebar "정보" panel showing app/daemon/Claude CLI versions, platform, port and
  the repo link, sourced from the single bootstrap response.)
- **설정에서 업데이트를 확인할 수 있습니다.** 설정 → 업데이트 탭의 버튼을 누르면 서버가
  npm 레지스트리에 배포된 최신 버전을 물어보고 현재 버전과 견줍니다. **자동으로는 절대
  조회하지 않습니다** — 버튼을 누를 때만 나가며, 나가는 것은 URL의 GET 한 줄뿐입니다
  (토큰·세션·경로를 싣지 않습니다). 업데이트가 있으면 실행 명령을 보여 주기만 하고,
  설치는 사용자가 직접 합니다.
  (Manual update check in 설정 → 업데이트; never fires automatically.)

### Changed
- **설정 팝업이 테마·세션·플러그인·업데이트 네 탭으로 나뉘었습니다.** 한 줄로 늘어놓던
  시절엔 이 앱의 설정(테마·새 세션 기본값)과 Claude Code 자체의 설정이 같은 목록에 섞여
  구분되지 않았습니다. 플러그인 켬/끔은 이제 Config 편집기를 열지 않고 설정에서 바로
  할 수 있습니다 — 두 화면은 같은 폼과 같은 저장 규칙(mtime 기준선·409 충돌 거부)을
  공유하고, 저장하지 않은 변경이 있으면 그 사실을 상시로 알립니다.
  (The settings popup is now four tabs — theme, session, plugins, update — and plugin
  toggles are available without opening the Config editor.)
- **실행 중 작업 도크가 입력창 밖으로 나오고, 눌러서 내용을 볼 수 있습니다.** 예전에는
  입력 박스 안에 얹혀 있어 도크에 포커스만 가도 입력창 테두리가 물들었고, 행을 누르면
  곧바로 대화로 점프해 버려 **연결 정보가 없는 작업은 눌러 볼 수조차 없었습니다.** 이제
  도크는 입력창 아래 독립 카드이고, 행을 누르면 그 자리에서 상세가 펼쳐집니다 —
  서브에이전트는 지금까지의 진행(최근 8단계)과 활동 상태를, 셸은 명령 전문을,
  백그라운드 작업은 종류와 식별자를 보여 줍니다. 대화로의 이동은 상세 안의
  "대화에서 보기" 버튼이 맡고, Esc로 접으면 포커스가 원래 행으로 돌아옵니다.
  (The running-work dock moved outside the composer box; rows now expand in place to
  show what each shell/subagent is doing, with jump-to-chat as an explicit button.)
- **`/clear`·`/compact` 다음에는 그 위의 대화가 화면에서 접힙니다.** 두 명령은 CLI의
  컨텍스트를 비우는데 화면에는 지나간 대화가 그대로 남아 있어, 보이는 것과 모델이 실제로
  기억하는 것이 어긋났습니다. 이제 초기화 구분선·압축 카드가 채팅 창의 시작점이 되어
  대화가 새로 시작한 것처럼 보입니다. **숨긴 것이지 지운 것이 아닙니다** — 상단의
  "이전 메시지 N개 더 보기"/"모두 불러오기"(기존 버튼 그대로)로 언제든 되살아나고,
  위로 읽는 중이거나 이미 펼쳐 둔 창은 경계가 생겨도 접히지 않습니다. `/compact`는
  **압축이 끝나는 순간** 접습니다 — 진행 중에 접으면 컨텍스트가 아직 그대로인데 화면만
  비고, 중단(Esc) 시 접혔던 대화가 한꺼번에 되살아납니다.
  (Conversation history above a `/clear` divider or a completed `/compact` card is
  now folded out of the chat window, matching what the CLI actually remembers.
  Nothing is deleted: the existing "load earlier"/"load all" buttons bring it back,
  and an expanded or scrolled-up window is never collapsed underneath you.)

## [1.9.5] - 2026-08-19

> 원격 제어를 켜고 끄는 자리를 사이드바 세션 행 우클릭 한 곳으로 모으고, 업그레이드
> 직후에도 살아남은 구버전 백그라운드 서버 때문에 노력 수준 변경이 `unknown message
> type: setEffort`로 튕기며 세션이 재시작되던 문제를 고쳤습니다.
> (Remote control now lives solely in the sidebar row context menu, and the
> stale-daemon version skew that broke effort changes is fixed — the launcher
> replaces an idle stale daemon and the UI warns on mismatch.)

### Changed
- **원격 제어를 켜고 끄는 곳이 사이드바 우클릭 하나로 정리됐습니다.** 입력창 위의
  `📱 원격 제어` pill과 팝오버를 없애고, **세션 행 우클릭**(키보드는 Shift+F10)의
  "원격 제어 켜기/끄기"를 유일한 창구로 삼았습니다. pill이 하던 나머지 일은 그 자리로
  옮겼습니다 — 켜진 세션의 행에 📱 표시가 붙고(보조기술에는 "원격 제어 켜짐"으로
  읽힙니다), 접속 주소가 나오면 같은 메뉴에 "claude.ai/code에서 열기"가 생기며,
  켜짐·실패는 토스트로 알립니다(실패 사유는 메뉴 툴팁에도 남습니다). 팝오버의 "주소
  복사"와 세션 수(n/m) 표시는 제거됐고, 실패한 항목의 재시도는 끄기 → 켜기 2단계입니다.
  (Remote control is now toggled only from the sidebar row's context menu; the
  composer pill and its popover are gone, with the indicator, connect link and
  failure reason moved into the row and menu.)

### Fixed
- **노력 수준을 바꿀 때 나던 `unknown message type: setEffort` 오류와 뜻하지 않은
  세션 재시작을 고쳤습니다.** 원인은 코드가 아니라 **버전 스큐**였습니다: 백그라운드
  서버(데몬)는 브라우저를 닫아도 살아남고 재실행은 그 데몬을 재사용하는데, 정적 번들은
  디스크에서 매번 읽히므로 업그레이드 직후 "새 클라이언트 + 구 서버" 조합이 됩니다.
  구 서버는 v1.9.4에서 생긴 `setEffort`를 몰라 오류를 냈고, 그 오류에 상관자(reqId)가
  없어 클라이언트는 5초를 기다린 뒤 `--resume` 재시작으로 폴백했습니다. 이제
  ① 런처가 데몬 재사용 전에 버전을 견줘, **유휴** 구버전 데몬이면 `POST
  /api/shutdown-if-idle`(토큰 인증)로 내리고 새 데몬을 띄웁니다 — 살아있는 세션이나
  원격 제어가 있으면 절대 내리지 않고 경고만 남긴 채 재사용합니다. ② `/api/bootstrap`이
  서버 버전을 실어 주고, 클라이언트가 자기 빌드 버전과 달라지면 사이드바 하단에 상시
  경고를 띄웁니다. ③ 서버는 모르는 메시지 오류에도 `reqId`를 되돌려 줘, 다음 스큐에서는
  기다림 없이 즉시 폴백합니다.
  (Fixed `unknown message type: setEffort` and the surprise session restart it caused:
  a stale background daemon from before an upgrade was being reused. The launcher now
  replaces an *idle* stale daemon, the UI warns on version mismatch, and unknown-message
  errors carry `reqId` so clients fall back immediately.)
- **노력 수준이 재시작으로 폴백할 때 그 사실을 알립니다.** 지금까지는 조용히 세션을
  재시작해 사용자에게는 "바꿨더니 세션이 새로 떴다"로만 보였습니다.
  (The effort-change restart fallback now announces itself before restarting.)

## [1.9.4] - 2026-08-19

> 노력 수준을 세션 재시작 없이 실행 중 CLI에 바로 적용하고, 선택 UI를 드래그
> 슬라이더로 바꿨으며, 울트라코드를 CLI와 같은 의미로 전송합니다. 프론트엔드의
> 유니코드 이모지·픽토그램은 전부 직접 그린 SVG 아이콘 29종으로 교체됐습니다.
> (Effort changes now apply to the running CLI without a restart, chosen via a
> new drag slider, and ultracode is sent with CLI-equivalent semantics. Every
> rendered Unicode emoji/pictogram is replaced with a hand-drawn 29-icon SVG set.)

### Changed
- **노력 수준 변경이 더 이상 세션을 재시작하지 않습니다.** CLI v2.1.233에서
  `apply_flag_settings` 제어 요청으로 실행 중 세션의 노력 수준을 바꿀 수 있음을
  실측 확인해, 기존의 "정지 → `--effort` 재스폰(`--resume`)" 대신 런타임 채널로
  즉시 적용합니다. 재시작이 없으니 **진행 중인 턴에도** 바꿀 수 있습니다(다음 턴부터
  반영). 이 채널을 모르는 구버전 CLI에서는 요청이 거부되고, 그때만 예전 재시작
  방식으로 자동 폴백합니다(재시작은 여전히 턴이 끝난 뒤에만).
  (Changing the effort level no longer restarts the session — it is applied to the
  running CLI via `apply_flag_settings`, with the old restart path kept as a
  fallback for CLIs that do not support that control request.)
- **노력 수준 팝오버가 드래그 슬라이더로 바뀌었습니다.** 단계별 막대 대신 핸들을
  끌거나 도트를 눌러 고르고, 키보드(←/→/Home/End)로도 조작할 수 있습니다
  (`role="slider"` ARIA 규약). 헤더에 현재 수준과 **(?) 도움말**이, 트랙 양옆에
  "더 빠르게 / 더 스마트하게"가 붙고, 각 도트에 hover하면 그 수준의 설명이 뜹니다.
- **울트라코드가 CLI와 같은 의미로 나갑니다.** 지금까지는 UI 치장 티어를
  `--effort max`로 낮춰 보냈는데, CLI 자신의 `/effort ultracode`는 노력 수준
  `xhigh` + `ultracode` 플래그로 보냅니다(실측). 이제 같은 형태로 전송해 실제
  울트라코드(멀티에이전트 워크플로) 모드가 켜집니다 — 워크플로를 지원하지 않는
  계정·모델에서는 실효가 '매우 높음'에 머물고, 그 경우 표시도 자동으로 교정됩니다.
- **프론트엔드의 유니코드 이모지·픽토그램을 전부 직접 그린 SVG 아이콘으로 바꿨습니다.**
  ☰·🗑·✕·⚡ 등 OS·폰트마다 다르게 그려지던 문자 글리프 29종을, 통일된 규격(24
  격자·1.8px 라운드 스트로크·`currentColor`)의 SVG 아이콘 세트로 교체해 크기·굵기·
  정렬이 항상 고정됩니다. 정의는 `Icon.jsx` 한 곳에 모여 있고, 세션 삭제·신뢰모드
  경고·오류 토스트·울트라코드에만 포인트 색을 쓰며 그 외에는 전부 무채색입니다.
  (Replaced every rendered Unicode emoji/pictogram in the frontend with a
  hand-drawn, 29-icon SVG set for consistent sizing, weight, and alignment
  across operating systems and fonts.)

## [1.9.3] - 2026-08-17

> 원격 제어가 켜지지 않던 문제를 고쳤습니다 — CLI가 새로 묻는 동의 프롬프트에
> 앱이 답을 주지 못해 연결 전에 조용히 종료되고 있었습니다. 이제 사이드바 세션
> 행을 우클릭해서도 원격 제어를 켜고 끌 수 있습니다.
> (Fixes remote control never starting — the CLI's new consent prompt went
> unanswered, so it exited silently before connecting. You can now toggle remote
> control by right-clicking a session row in the sidebar, too.)

### Fixed
- **Remote control starts again — the CLI's consent prompt no longer kills it
  silently.** Since CLI v2.1.233 `claude remote-control` asks
  `Enable Remote Control? (y/n)` on stdout, without a trailing newline, and waits
  for stdin. The app spawned it with `stdin: 'ignore'`, so the CLI hit EOF and
  exited 0 before connecting — leaving only "원격 제어가 예기치 않게 종료되었습니다
  (exit code 0)". Because the CLI records that consent globally
  (`remoteDialogSeen`), it worked on machines where the prompt had already been
  answered in a terminal and always failed elsewhere, which is why it looked
  intermittent. The manager now keeps stdin open and answers the prompt once —
  pressing "원격 제어 켜기" in the UI *is* the consent — detecting it in the
  unterminated buffer so a redraw or a chunk boundary cannot hide it.
- **Workspace-trust failures now say what to do.** That error arrives on stderr,
  where error markers were not being matched, so it was buried in a generic
  "unexpected exit" message. The CLI's own instruction (run `claude` in that
  directory once and accept the trust dialog) is surfaced verbatim instead. Late
  stderr arriving while you are turning remote control *off* no longer flips the
  result to a failure.

### Added
- **Turn remote control on/off from the sidebar.** Right-clicking a session row
  (Shift+F10 for keyboards) now offers `📱 원격 제어 켜기/끄기` between "이름 변경"
  and "세션 종료", so sessions in *other* projects can be controlled too — the
  composer pill only ever covered the active one. The item reflects the server
  snapshot (never an optimistic guess), keeps working through the cwd fallback
  when the session ended but remote control is still running, and greys out with
  the reason when the socket is down or the session has exited.

## [1.9.1] - 2026-08-11

> 탐색기에서 복사한 파일이나 방금 찍은 스크린샷을 입력창에 그대로 붙여넣으면
> 파일 경로가 들어갑니다 — 원본 파일이면 원본 경로가, 스크린샷이면 저장된 임시
> 파일의 경로가 삽입돼 그대로 읽고 고칠 수 있습니다.
> (Paste a copied file or a fresh screenshot straight into the composer and its
> path lands in the prompt — the original path for a real file, a saved temp
> file for a screenshot.)

### Added
- **Paste a file or a screenshot into the composer and get its path.** Copy a
  file in Explorer, paste into the input, and its **original absolute path** is
  inserted at the caret — so the CLI reads and edits that file in place rather
  than a copy. Paste a screenshot (or anything the clipboard holds only as
  bitmap bytes) and it is saved under your OS temp directory first, with that
  path inserted instead. Paths containing spaces are quoted, several files come
  in as a space-separated run, the insertion respects your caret and replaces
  the current selection, and a trailing space closes the token so you can keep
  typing. Plain-text paste is completely untouched: a clipboard that carries
  text alongside a bitmap — an Excel range, a Word table — falls through to the
  browser's native paste, so copying a spreadsheet still pastes the spreadsheet.
  Two authenticated local endpoints back it, `POST /api/clipboard-files` (reads
  only the clipboard's *file list*, and only when the browser has already handed
  over files) and `POST /api/paste-file` (20 MB per file). Uploaded names are
  sanitised for path separators, control characters, Windows reserved names and
  byte length before touching disk; each paste lands in its own unpredictable
  sub-directory; and the temp root is refused if it is a symlink or junction, so
  a planted link cannot redirect writes or deletions. Left-over paste folders
  older than 24 hours are swept on the next app start — from the real entry
  point only, so running the test suite never deletes yours.

## [1.9.0] - 2026-08-10

> 어시스턴트가 만든 결과물을 대화 옆 패널에서 바로 확인 — 턴이 끝나면 저절로
> 열립니다. 사이드바 세션 행은 이름 + 상태 점만 남기고 정리했습니다.
> (See what the assistant just wrote in a side panel — it opens by itself when
> the turn finishes. Sidebar session rows are now just a name and a status dot.)

### Added
- **Artifact preview panel — opens by itself when a turn finishes.** When a turn
  ends successfully and the assistant wrote a file during it, the panel opens on
  the right with that result already rendered. If several files were written, it
  picks the one you most likely want to look at (HTML → Markdown → image/PDF →
  text), and if you were already looking at a file it also touched, your
  selection is kept rather than swapped out. Failed or interrupted turns never
  open it, and if you close the panel yourself the rest of that turn stays quiet
  — sending your next prompt re-arms it. You can still open any artifact by hand
  from the **미리보기** button on a successful `Write`/`Edit`/`MultiEdit`/
  `NotebookEdit` card, switch files from the header picker, refresh, or pop the
  file out to a new tab. HTML and SVG render in a sandboxed `<iframe>` (relative
  `./style.css` and `img/*.png` load from the same scope), Markdown renders
  through the chat's own renderer with relative links rebased, images and PDFs
  use the browser's viewers, other text is syntax-highlighted, and anything else
  offers a download. The panel is resizable (drag or arrow keys) and slides over
  the conversation instead of squeezing it on narrow windows.
  Serving is deliberately narrow: an authenticated `GET /api/preview-ticket`
  returns a short-lived, directory-scoped ticket, and `GET /preview/<ticket>/…`
  serves bytes without the app token so previewed documents can never read it.
  The server re-derives the session's working directory from its own ledger,
  resolves symlinks, refuses anything outside that directory, caps responses at
  10 MB, and sends `Content-Security-Policy: sandbox …` with HTML/SVG so a
  previewed document has no app-origin privileges even when opened directly.
  `SECURITY.md` documents the boundary and what it does not cover.

### Changed
- **Sidebar session rows are now just a name and a status dot.** The text status
  badge and the inline `⋯`/`✕` buttons are gone; state is carried by the dot's
  colour (waiting · thinking · tool · needs you · exited), with the wording kept
  for screen readers and the hover tooltip so nothing is colour-only. Rename and
  close moved entirely to the row's right-click menu (Shift+F10 for keyboard
  users, announced via `aria-keyshortcuts`), which makes the row a single
  focusable target and stops the buttons from crowding long session names.

## [1.8.3] - 2026-08-09

> 사이드바 세션을 우클릭해 이름 변경·닫기, 설정에서 Claude Code 설정
> (`~/.claude/settings.json`) 직접 편집.
> (Right-click a sidebar session to rename or close it; edit your Claude Code
> settings file from Settings.)

### Added
- **Rename or close a session from its right-click menu.** Right-clicking a
  session in the sidebar (or using the `⋯` button, which is what keyboard and
  touch users get) opens a menu with **이름 변경 / 닫기**. Renaming edits the row
  in place — Enter saves, Esc cancels, an empty name falls back to the automatic
  title. Names are stored in this browser (`localStorage`), keyed by session id,
  and follow the conversation when a resume forks it into a new id; every place
  that shows a session title now derives it the same way (sidebar row, the badge
  shown when the sidebar is collapsed, the "지난 세션" list, the delete
  confirmation). "닫기" stops the CLI process for a live session, and removes an
  already-exited one from the list — the menu says which one it will do.
- **Edit `~/.claude/settings.json` from Settings → Claude Code Config.** The
  editor loads the file as-is (formatting and key order preserved), validates
  JSON before saving, and writes through a new authenticated `GET/PUT
  /api/claude-config`: writes are serialised, applied atomically (temp file +
  rename, new files `0600`, existing permissions kept), and refused with a
  "다시 불러오기" prompt if the file changed elsewhere since it was loaded.
  Saved settings apply to every session started afterwards, including outside
  this app — the editor says so, and `SECURITY.md` documents the new boundary.

## [1.8.2] - 2026-08-01

> Windows에서 원격 제어를 켜도 pill이 꺼진 채로 남던 문제 수정(1.8.1의 누락분 포함).
> (Fixes the Remote Control pill staying off on Windows.)

### Fixed
- **Remote Control could look like it never turned on, on Windows.** The manager
  canonicalised the target directory with one `realpath` implementation and the
  server matched sessions against it with another; the two disagree on 8.3 short
  names (`C:\Users\RUNNER~1\…`) and some symlinked paths, so no session
  ever matched the running control and the pill stayed off even though
  `claude remote-control` was actually up. Both sides now go through a single
  `canonicalCwdSync` (`fs.realpathSync.native`), which resolves short names,
  symlinks and casing in one step; matching additionally folds case on Windows.
  Found by the Windows CI runner, whose temp directory uses a short name.
  The same mismatch also emptied the advertised `cwds` list, which is what lets
  the browser stop a remote control after its session has already exited.

## [1.8.0] - 2026-08-01

> Claude Code 원격 제어 연동(claude.ai·모바일 앱에서 이 레포 조종), 입력창 아래
> "실행 중" 도크, 메시지 시각 표시. 그리고 `/clear` 후 모델 선택이 풀리던 문제 수정,
> 재실행 시 실행 중인 서버 재사용, Windows 무콘솔 실행 바로가기, 입력창 배지 정리.
> (Remote Control from claude.ai and the mobile app; a running-work dock under the
> composer; message timestamps. Plus: model stays selected after `/clear`; relaunch
> reuses a live server; a console-free Windows launcher; slimmer composer badges.)

### Fixed
- **The model picker no longer clears itself after `/clear`.** Measured against
  the real CLI v2.1.220: right after `/clear` the CLI emits a correct
  `system/init` and then a dummy `assistant` message whose `message.model` is the
  literal sentinel `<synthetic>` with the body `(no content)`. The client was
  harvesting that sentinel as the session's model, so `familyOf()` found no
  family — the pill fell back to "모델" with nothing checked in the menu, and the
  measured context window was reset along with it. The sentinel is now excluded
  from model harvesting (exact match only — no model-name allowlist that could
  reject future models), and that `(no content)` placeholder no longer renders as
  an empty assistant bubble. A `<synthetic>` message that carries real text (for
  example a login prompt) is still shown.

### Added
- **Remote Control: drive this repo from claude.ai/code or the Claude mobile app.**
  A `📱 원격 제어` pill next to the repo pill starts `claude remote-control` for the
  session's directory and shows the resulting `claude.ai/code?environment=…` link,
  a copy button and a stop button. Measured against the real CLI v2.1.220: the
  `--remote-control` flag is silently ignored in `-p`/stream-json mode, and
  `claude daemon remote-control` is unavailable on Windows, so the server manages
  the process directly — one child per canonical directory, tree-terminated on
  stop. The browser only ever sends a session key; the server resolves the
  directory from its own session ledger, so no client-supplied path can open a
  remote control. **While Remote Control is on, closing the browser no longer
  shuts the app down** — that is the point of the feature — so remember to turn it
  off; the popover says so. See SECURITY.md for what the feature exposes.
- **A "실행 중" dock under the composer shows running shells and subagents.**
  Background shells, background agents and in-flight foreground `Bash`/`Task`
  calls are listed under the input; clicking one scrolls the transcript to that
  card and highlights it briefly. The running list comes from the CLI's own
  `background_tasks_changed` snapshot rather than guesswork over tool-result text,
  so items appear and disappear exactly when the CLI says they do, and a resumed
  conversation never shows ghosts of tools that stopped long ago.
- **Messages carry a small `HH:MM` timestamp.** User messages and assistant
  answers only — tool cards and thinking blocks stay uncluttered. The time comes
  from the CLI event itself, so a resumed conversation shows when things actually
  happened rather than when it was reopened; hovering shows the full date.
- **Re-running `cc-on-browser` while a server is already up now just opens a new
  tab.** The background daemon outlives the browser for a while (about 10 seconds
  after every tab is deliberately closed, longer when the connection was merely
  lost to sleep, longer still while CLI sessions are alive), and re-running during
  that window used to die with `Port 8787 is already in use` — from a shortcut or
  Win+R that looked like nothing happened at all. The daemon now records its port,
  token, pid and version in `~/.cc-on-browser/instance-<port>.json`; a relaunch
  authenticates against the running server with that token (and checks the port it
  reports back) and, when it is ours, opens a browser tab and exits 0 with
  `Already running (v…) on port … — opened a new browser tab.` Live CLI sessions
  survive. A foreign program on the port still produces the original error. No
  unauthenticated HTTP endpoint was added; see SECURITY.md for the trust boundary
  of the token file.
- **`cc-on-browser --shortcut` (Windows): launch with no console window at all.**
  Running the command from Win+R or Explorer flashes a command prompt for 1–3
  seconds, because npm's generated `cc-on-browser.cmd` creates that console before
  Node can run — nothing in the app can hide it. The new flag creates a
  "Claude Code on Browser" shortcut on the Desktop and in the Start Menu that goes
  through `wscript.exe` (a GUI-subsystem host, so no console exists) and starts the
  server with a hidden window: only the browser appears. Partial success is
  reported per location, and the command runs before every server-related preflight
  so unrelated setup problems cannot block it.

### Changed
- **The running-subagent panel moved below the input and became the work dock.**
  It used to sit above the input and only appear while a turn was in flight, which
  hid exactly the long-running background work it should have shown. Items are now
  clickable.
- **The composer no longer shows the `⚡ 울트라코드` and `🔓 권한 상승` badges.**
  The effort picker and the permission-mode select already show that state, so the
  badges were duplicate signage. The options themselves are untouched.
- **The active-goal badge is now just `GOAL`.** The full goal text moved into the
  tooltip (hover, and keyboard focus for anyone without a mouse) instead of taking
  up a line above the input.

## [1.7.1] - 2026-07-29

> `/clear`·`/compact` 직후 상태줄 CTX가 다음 턴까지 옛 값으로 남던 문제 수정.
> (Stale CTX after `/clear` and `/compact`.)

### Fixed
- **The CTX status-line value now updates immediately after `/clear` and `/compact`.**
  Both are local CLI commands that make no model call, so no authoritative
  per-call `assistant` usage arrives to refresh the context size, and any `result`
  that follows is absent, empty, or a turn aggregate unusable as a context
  measurement. The status line therefore kept showing the pre-command number until
  the next real turn (e.g. still reading 117k right after a compaction down to
  3,171). `/clear` now resets it to 0 and
  `/compact` adopts the `postTokens` the CLI already reports on its
  `compact_boundary` event, so the number matches the compaction card. Automatic
  compaction goes through the same event and is covered too. Other commands are
  deliberately untouched: the CLI gives no authoritative context-token signal for
  them, so nothing is guessed.

### Changed
- **The CTX ring stays visible at 0%** instead of disappearing. Display is now
  decided by a flag (`usage.ctxDisplayable`) rather than by `contextTokens > 0`,
  which could not tell "context was cleared" apart from "no turn has run yet".
  A freshly started session with no turns still shows no ring. The ring's tooltip
  now reads "마지막 API 호출·압축/초기화 기준" — the old wording claimed the value
  always came from the last API call, which stopped being true.
- **Resumed sessions now show compaction cards in their history.** The server's
  transcript reader used to discard every `system` event except the first `init`,
  which threw away the `compact_boundary` lines. They are now passed through, so
  resuming a session that ended right after a compaction restores the correct CTX
  — and, as a side effect, the compaction completion cards that were previously
  missing from resumed history are rendered.

## [1.7.0] - 2026-07-28

> 긴 대화 성능·메모리 개선 — 메시지 창(윈도잉) · 렌더 메모이제이션 · 대량 유입 시 하단 고정 수정.
> (Long-conversation performance & memory: message windowing, render memoization,
> bottom-following fix.)

### Changed
- **BEHAVIOR — by default the chat keeps only the most recent 200 messages in the page.**
  Older messages are one click away ("이전 메시지 N개 더 보기" / "모두 불러오기"),
  and expanding preserves your reading position. The trade-off: messages outside
  the window are absent from the page, so **Ctrl+F, select-all/copy, printing and
  screen-reader browsing do not reach them** until you load them. An expansion
  sticks until you press "↓ 최신으로" or switch sessions. Scrolling up freezes the
  top of the window so incoming messages cannot shift what you are reading.
- **Model picker fallback updated for Claude Opus 5** (`claude-opus-5`, released
  2026-07). The Opus family's fallback display version is now `5` (was `4.8`);
  the catalog helpers (`MODEL_FAMILIES` / `parseVersion` / `familyOf` /
  `buildModelOptions`) moved from `Composer.jsx` into
  `client/src/lib/model-catalog.js` so they can be regression-tested with
  `node --test`. This only affects the fallback label shown when the CLI
  catalog has no matching Opus entry or its `resolvedModel` cannot be parsed;
  when the catalog does match, both the version shown and the value sent to the
  CLI still come from it. The picker's family list itself is hard-coded and
  unchanged — all four families are always offered.

### Added
- Regression cover for the window contract: `client/test/chat-window.test.js`
  (`node --test`) pins the window arithmetic across the default / reading-up /
  expanded states, and a new `bulk` fake-CLI scenario (hundreds of messages in one
  turn) backs five browser tests — the default 200-item window, "load earlier"
  anchoring, "load all" + focus handoff, the raw-debug toggle surviving
  memoization, and switching away to another session and back without replaying
  the entrance animation over the whole history.

### Fixed
- **Long conversations no longer freeze the UI or balloon browser memory.** Two
  causes, both measured (Chromium + CDP, 1920 messages, one streamed reply of 200
  deltas): every streaming delta re-rendered the *entire* message tree, and the
  whole conversation stayed in the DOM (a heap snapshot attributed **72% of the
  heap to DOM nodes**, 27.8 MB of 38.7 MB). `Message` is now memoized and the chat
  list renders a window of the most recent messages. Main-thread blocking during a
  streamed reply dropped from **3851 ms to 0 ms**, and the heap snapshot from
  **38.7 MB to 17.6 MB** (DOM 27.8 MB → 3.5 MB) for a session with 20 KB tool
  outputs.
- **Bulk event arrival no longer breaks bottom-following.** Replaying hundreds of
  events at once (reconnect, resume) left the view stranded far above the latest
  message: while the list was still growing, a scroll event reporting a stale
  `scrollTop` was read as "the user scrolled up", which cancelled auto-follow (and,
  with windowing, froze the window in place). The scroll handler now treats an
  event as a user scroll only when `scrollTop` actually moved away from where we
  last pinned it. Measured with 400 turns pushed in one go: **53,634 px above the
  bottom (window stuck at 1200 items) → 0 px (200 items)**.
- `updateByUid` in the event reducer walks backwards and copies with `slice`
  instead of `map` — per-delta cost at 8000 messages went from 75 µs to ~5 µs.
  (The array copy remains, so garbage volume is largely unchanged: 13.5 → 12.6 MB
  per streamed block at 4000 messages.)

## [1.6.0] - 2026-07-22

> 지난 세션 모달 통합 · 신뢰모드 시작 전용화 · 새 세션 기본값 설정 · favicon.

### Changed
- **Past-session management moved into the new-session modal.** The sidebar now
  lists only currently open sessions; the modal's "recent sessions" became a full
  "past sessions" manager (two-line rows with directory / last access / transcript
  size, per-row delete with confirmation, "show more" 20→50, loading/error/retry
  states, live-session 409 handling).
- **Resuming applies the model and permission mode selected in the modal** (leaving
  the model empty omits `--model`, keeping the session's previous model). Duplicate
  resume is guarded by an attempt-generation lock with a 15s watchdog.
- **BREAKING — Trust mode (`bypassPermissions`) is now start-only.** Sessions spawned in any
  other mode can no longer switch into trust mode mid-session (enforced server-side;
  the composer hides the option and permission-dialog escalation suggestions are
  filtered). Trust-spawned sessions may still leave and return to it.

### Added
- **Default model & default permission mode** in Settings (localStorage-persisted,
  validated against the CLI's model catalog before spawning) — they seed the
  new-session modal's initial selection. The model list becomes available after the
  first session `init`.
- **Browser tab icon** (`favicon.svg`, the brand sparkle mark).
- E2E: isolated `projectsRoot` seeding (`FAKE_PROJECTS_ROOT`) so history list /
  resume-with-arguments / deletion are tested against disposable fixtures — the
  real `~/.claude/projects` is never touched. New scenarios for modal history,
  settings defaults, resume spawn arguments, and confirmed deletion.
- Focus-trap restore targets (`useFocusTrap` third argument) so deleting a session
  from the nested confirm dialog lands focus on the list heading instead of `<body>`.

### Fixed
- `startSession` now reports WebSocket send failure to callers, so the new-session
  modal no longer closes as if a session had started while disconnected.

## [1.5.0] - 2026-07-19

> 공개 릴리스 준비 — 기본 권한 모드 안전화, 지난 세션 UX, E2E·릴리스 자동화. (First public-release-ready version.)

### Changed
- **New sessions now default to the `default` permission mode** (the CLI asks before
  tool uses that need confirmation) instead of `bypassPermissions`. The previous
  behavior is still one click away in the new-session modal / composer, with the
  warning banner kept.
- README rewritten around a quick-start flow with a troubleshooting section;
  English README fully re-synced.
- Client bundle is split into `app` + `vendor-react` / `vendor-hljs` / `vendor-md`
  chunks (same total gzip size, better cache reuse across app updates).

### Added
- **Past sessions in the sidebar**: collapsible section (state persisted), per-row
  summary title with directory, relative last-access time and transcript size, and
  a delete button with confirmation (`DELETE /api/sessions`, live sessions protected).
- **Browser E2E tests** (Playwright + the subscription-free fake CLI stack): session
  start, default-permission-mode assertion, streamed markdown rendering, and a
  permission allow/deny round-trip. Runs locally via `npm run test:e2e` and in CI.
- **Release automation** (`.github/workflows/release.yml`): tag push builds, tests,
  packs a single tarball, smoke-installs it, uploads it (with SHA-256) to the GitHub
  Release, and publishes to npm when an `NPM_TOKEN` secret is configured — with a
  dry-run rehearsal mode and a manual recovery path.
- `SECURITY.md` (threat model, hardening notes, private reporting path) and this
  `CHANGELOG.md`.
- Background (default) start mode now reports the detected `claude` CLI version, or
  a clear warning when the CLI cannot be found — previously only `--no-open` did.

### Fixed
- Running `cc-on-browser` from a shell spawned inside an app-hosted CLI session no
  longer silently enters daemon mode (daemon detection moved from an inherited
  environment variable to an internal argv flag).

### Security
- The daemon now scrubs the auth token from its environment right after startup, so
  CLI sessions (and their child shells) no longer inherit the local API bearer token.

## [1.4.0] - 2026-07-18

> 절전 세션 생존 · 서브에이전트 패널 · 커스텀 툴팁 · 사용량 잔디.

### Added
- Sleep survival: connection loss (laptop lid close, suspend) no longer shuts the
  server down; live CLI sessions are kept and the browser reattaches on wake.
- Live subagent panel above the composer while Task/Agent subagents run.
- Custom tooltip layer replacing native `title` tooltips.
- GitHub-style daily usage heatmap (12 weeks / 1 year) in the sidebar.

## [1.3.1] - 2026-07-16

### Fixed
- Native folder picker no longer opens behind the browser window.
- `/compact` summaries and CLI-injected context messages render as proper cards
  instead of giant user bubbles; ANSI escapes stripped from slash-command output.

## [1.3.0] - 2026-07-13

### Added
- New-session working directory via the native Windows folder dialog.
- "Recent sessions" (across all projects) in the new-session modal, resumable in
  one click (`GET /api/recent-sessions`).

### Fixed
- 5h/7d usage rings no longer fall back to raw token counts on transient fetch
  failures; `@` autocomplete no longer keeps stale results selectable.

## [1.2.0] - 2026-07-13

### Added
- `@` file-tag autocomplete over the session working directory (server returns
  relative paths only; file contents are never read).

### Fixed
- CLAW'D mascot no longer shows a phantom second pair of eyes while eye-tracking.

## [1.1.1] - 2026-07-11

### Fixed
- Context gauge denominator follows the model's real context window (1M-context
  models no longer show ~5× inflated usage).

## [1.1.0] - 2026-07-11

### Added
- Status bar with official 5h/7d account utilization rings and context gauge.
- claude.ai-style model & effort picker; smooth rAF-paced streaming; CLAW'D mascot
  mood system; permission-mode revamp with toast notifications.

## [1.0.0] - 2026-07-09

First distributable release — streaming markdown chat, tool cards, permission
dialogs, session resume, local-only server (127.0.0.1 + token auth) driving the
locally installed Claude Code CLI. No SDK, no API key.

[Unreleased]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.2...HEAD
[1.10.2]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.1...v1.10.2
[1.10.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.9.5...v1.10.0
[1.9.5]: https://github.com/seokjw0727/CC-on-browser/compare/v1.9.4...v1.9.5
[1.9.4]: https://github.com/seokjw0727/CC-on-browser/compare/v1.9.3...v1.9.4
[1.9.3]: https://github.com/seokjw0727/CC-on-browser/compare/v1.9.2...v1.9.3
[1.9.2]: https://github.com/seokjw0727/CC-on-browser/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.8.3...v1.9.0
[1.7.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/seokjw0727/CC-on-browser/releases/tag/v1.0.0
