# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Full bilingual (EN/KO) release notes live on the
[GitHub Releases](https://github.com/seokjw0727/CC-on-browser/releases) page.

## [Unreleased]

## [1.11.6] - 2026-09-06

> 저장소를 공개하기 위한 정리이자, 그 과정에서 드러난 두 가지를 함께 고친 릴리스입니다.
> 먼저 **계정 공식 사용률 조회가 옵트인이 되어 기본으로 꺼집니다** — 지금까지는 앱을
> 켜기만 해도 60초마다 CLI가 저장해 둔 구독 OAuth 토큰으로 api.anthropic.com을 조회했는데,
> 그 자격증명은 원래 Claude Code와 Anthropic 자체 앱을 위한 것이라 서드파티 도구가 대신
> 쓰는 판단은 사용자가 직접 내려야 한다고 보았습니다. 설정에서 켜면 예전과 똑같이
> 동작하고, 꺼 두면 로컬 대화 기록 집계만 표시됩니다. 다음으로 **앱 이름이 "CC on
> Browser"가 됩니다** — Anthropic의 상표 정책이 제품명·로고에 "Claude Code"를 쓰는 것을
> 금지하기 때문이며, 이 앱이 Claude Code CLI를 구동한다는 설명은 평문으로 그대로 남습니다.
> **번들된 폰트와 라이브러리의 라이선스 고지도 추가됩니다** — 빌드가 라이선스 배너를 지운
> 채 배포되고 있어 THIRD-PARTY-NOTICES.md가 유일한 고지가 되기 때문입니다. 화면에서는
> **worktree 브랜치 칩이 상태줄로 들어가** 실행 중 작업 도크를 더는 밀어내지 않고,
> **설정의 업데이트 확인이 실제로 동작합니다** — 게시된 적 없는 npm 패키지를 보느라 늘
> 실패하던 조회가 이제 진짜 배포 채널인 GitHub Releases를 봅니다.
> (Prepares the repository for public release and fixes two things found along the way.
> Official account-usage lookups become opt-in and default to off; the app is renamed to
> "CC on Browser"; the bundled fonts and libraries now carry the license notices that
> minification strips from the shipped bundle; the worktree branch chip moves into the
> status bar so it no longer displaces the running-work dock; and the update check now
> reads GitHub Releases — the actual distribution channel — instead of an npm package that
> was never published.)

### Added
- **THIRD-PARTY-NOTICES.md** — 번들되는 폰트(Pretendard, Monoplex KR)와 라이브러리
  (React, marked, DOMPurify, highlight.js, ws)의 저작권 표기와 라이선스 전문. 빌드가
  minify 과정에서 모든 라이선스 배너를 지우기 때문에, 배포되는 패키지에서는 이 파일이
  유일한 고지입니다. 폰트 라이선스 전문은 `client/public/licenses/`에도 두어 빌드
  산출물(`client/dist/licenses/`)과 함께 배포됩니다.
  (Adds the copyright notices and full license texts that the minified bundle strips.)
- **계정 공식 사용률 조회 토글** — 설정 → 세션. 기본 꺼짐이고, 켜야만 조회가 나갑니다.
  한도 알림은 이 값을 재료로 쓰므로, 알림만 켜 두면 안내가 함께 뜹니다.
  (A settings toggle for official account usage, off by default.)
- README와 앱 정보 패널에 **상표 고지** — Claude·Claude Code·Clawd가 Anthropic의 것이며
  이 프로젝트가 비공식임을 밝힙니다.
  (Trademark notice in both READMEs and the in-app info panel.)

### Changed
- **계정 공식 사용률은 이제 옵트인입니다(기본 꺼짐).** 관문은 서버에 있습니다 —
  `/api/usage`가 `?quota=1`을 명시적으로 받았을 때만 자격증명을 읽고 조회합니다.
  낡은 브라우저 탭이나 직접 두드리는 요청으로는 조회가 일어나지 않고, 켰다가 끈 뒤에는
  서버 캐시에 남은 값도 돌려주지 않습니다. 끄면 화면의 %도 그 자리에서 사라집니다.
  (Server-side gate: credentials are read only for an explicitly opted-in request, and
  cached values are never returned to a request that did not opt in.)
- **앱 이름이 "CC on Browser"로 바뀌었습니다.** 브라우저 탭 제목, 사이드바 로고, CLI
  도움말과 기동 배너, Windows 바로가기가 모두 새 이름을 씁니다. npm 패키지 이름
  (`cc-on-browser`), 명령 이름, 저장소 주소는 그대로입니다. `--shortcut`을 다시 실행하면
  새 이름의 바로가기를 만들고 **예전 이름의 바로가기는 치웁니다** — 그 바로가기가 우리가
  만든 것인지 확인한 뒤에만 지웁니다.
  (Renames the app; `--shortcut` now also removes the old-named shortcut it created.)
- SECURITY.md가 바깥으로 나가는 요청을 다시 설명합니다 — 기본값은 0이고, 옵트인 둘
  (공식 사용률·수동 업데이트 확인)이 무엇을 언제 보내는지, 공식 사용률을 켜기 전에
  무엇을 알아 두어야 하는지 적었습니다.
  (SECURITY.md now describes both opt-in network paths and what to weigh before enabling.)
- CI·릴리스 워크플로가 토큰을 덜 흘립니다 — `permissions: contents: read`를 명시하고,
  체크아웃이 GITHUB_TOKEN을 `.git/config`에 남기지 않도록 `persist-credentials: false`를
  걸었습니다(포크 PR의 코드가 같은 잡에서 도는 워크플로라 중요합니다).
  (Least-privilege token settings for the CI and release workflows.)
- 마스코트 주석과 README가 캐릭터의 출처를 정확히 밝히고, 무드 어휘를 참고한
  clawd-on-desk(AGPL-3.0)를 출처로 표기합니다.
  (Accurate provenance for the mascot, plus credit for the mood vocabulary it borrows.)
- **worktree 브랜치 칩이 상태줄로 들어갔습니다** — 컨텍스트·사용량 표시 오른쪽입니다.
  입력창과 "실행 중" 도크 사이에 독립 행으로 서 있던 자리에서는, 셸이나 서브에이전트가
  돌기 시작할 때마다 칩이 그 도크를 한 칸 아래로 밀어냈습니다. 상태줄은 조건과 무관하게
  늘 있는 줄이라 그 밀침이 사라집니다. 브랜치를 다시 읽는 시점(세션 전환·턴 종료·창
  포커스·패널 닫기)과 패널 내용은 그대로입니다.
  (Moves the worktree branch chip into the status bar, right of the usage readouts, so it
  no longer displaces the running-work dock.)
- 업데이트 확인이 이제 **GitHub Releases**를 봅니다(예전에는 npm 레지스트리). 이 패키지는
  npm에 게시된 적이 없어 그 조회는 언제나 빈손이었고, 실제 배포 채널은 릴리스마다 붙는
  `cc-on-browser-<버전>.tgz` 자산입니다. 새 버전이 있으면 릴리스 페이지 링크와 그 버전의
  tarball을 가리키는 설치 명령을 함께 보여 줍니다. 나가는 것은 여전히 버튼을 눌렀을 때의
  URL 하나뿐입니다.
  (The update check now reads GitHub Releases — the actual distribution channel — and
  shows the release link plus the matching tarball install command.)

### Removed
- 쓰이지 않던 클라이언트 헬퍼 `fetchSessions`·`browseDirs`와 참조되지 않는 `.faint`
  CSS 규칙. 서버의 `/api/browse` endpoint는 그대로 둡니다 — UI가 쓰지 않더라도 문서에
  적힌 1.x 릴리스의 표면이라 조용히 없애지 않습니다.
  (Drops two dead client helpers and an orphan CSS rule; the documented REST endpoint stays.)
- 에이전트 작업 지시서였던 `docs/superpowers/plans/` 문서 둘과 이미 낡은 UI 스펙 하나.
  남은 설계 스냅샷은 `docs/specs/`로 옮기고 아카이브임을 문서 머리에 명시했습니다.
  (Removes stale internal planning docs; the remaining design snapshot moves to docs/specs/.)

### Fixed
- 공식 사용률을 껐다 켜면 옛 기준선과 비교돼 있지도 않은 한도 알림이 한 번 뜨던 문제.
  이제 끄는 순간 기준선을 지우므로, 다시 켠 뒤의 첫 값은 기준선으로만 쓰입니다.
  (Turning official usage off and back on no longer emits a spurious limit notification.)
- 다른 탭에서 공식 사용률을 끄면 이 탭이 다음 폴링까지 계속 조회하던 문제. 이제
  `storage` 이벤트로 즉시 따라갑니다.
  (A toggle in another tab now takes effect immediately in every open tab.)
- `claude-settings-form.js`에 이스케이프 대신 실제 NUL 바이트가 들어 있어 git과 ripgrep이
  이 파일을 바이너리로 취급하던 문제 — 코드 리뷰에서 diff가 보이지 않았습니다.
  (A literal NUL byte made one source file register as binary to git and ripgrep.)
- **설정 → 업데이트의 "확인"이 언제나 실패하던 문제.** 조회처가 게시된 적 없는 npm
  패키지 이름이라 응답은 늘 404였고, 화면은 그것을 "네트워크를 확인해 주세요"라는 틀린
  진단으로 옮겼습니다. 이제 실제 배포 채널인 GitHub Releases를 보고, 아직 올라온 릴리스가
  없거나 저장소가 비공개라 확인할 수 없는 경우를 네트워크 오류와 구분해 말합니다 —
  그때는 재시도 버튼을 내주지 않습니다(다시 눌러도 달라질 것이 없기 때문입니다).
  (Fixes the Updates tab always reporting a network failure: it checked an npm package
  that was never published. It now reads GitHub Releases and distinguishes "no published
  release yet" from a genuine lookup failure.)

## [1.11.5] - 2026-09-04

> 사이드바 세션 목록의 **색 점이 작은 CLAW'D로 바뀌었습니다.** 지금까지 세션 상태는 이름
> 왼쪽의 점 하나가 색으로만 알렸는데, 색은 세션이 여러 개 쌓이면 서로 구분이 잘 안 되고
> 색각 이상이 있는 분에게는 사실상 아무 정보도 주지 못하는 표시였습니다. 이제 세션 이름
> 오른쪽에 18×10px 마스코트가 붙어 자세와 움직임으로 상태를 말합니다 — 대기 중에는 가만히
> 눈을 깜빡이고, 생각 중이면 옆에 점 세 개가 뜨고, 도구가 도는 동안에는 좌우를 두리번거리고,
> 권한이나 질문을 기다릴 때는 집게를 들고 폴짝 뛰고, 끝난 세션은 잡니다. 툴팁 문구와 스크린
> 리더가 읽는 문장은 예전 그대로이고, `prefers-reduced-motion`을 켜면 무드별 정지 그림으로
> 떨어집니다.
> (Replaces the coloured status dot in the sidebar session list with a small CLAW'D to the
> right of each session name. State is carried by pose and motion instead of hue, so it
> survives colour blindness and stays legible when many sessions are stacked. Tooltips and
> screen-reader labels are unchanged, and reduced motion resolves to a static per-mood frame.)

### Changed
- **상태 점이 미니 마스코트로 교체되었습니다.** 대기·생각 중·도구 실행·권한/질문 대기·종료
  다섯 상태가 각각 정면, 말풍선 점 세 개, 좌우 두리번, 집게 홉, 졸기로 나타납니다. 상태를
  판정하는 로직과 라벨 문구는 손대지 않아서, 툴팁에 뜨는 글자와 보조기술이 읽는 문장은 이전
  릴리스와 같습니다.
  (The colour dot becomes an 18×10px mascot; status derivation and its labels are untouched,
  so the tooltip text and the screen-reader string are identical to the previous release.)
- **연결이 끊긴 세션은 라벨에 연결 상태가 덧붙습니다.** 소켓이 끊기면 마스코트는 자는 자세가
  되는데, 라벨이 "대기"인 채로 남으면 그림과 설명이 서로 다른 이야기를 하게 됩니다. 이제
  "대기 · 연결 끊김"처럼 뒤에 붙여 둘을 맞췄습니다.
  (When the socket drops the mascot dozes, so the label now carries a connection suffix and
  pose and text agree again.)
- **행이 늘어도 타이머와 리스너는 늘지 않습니다.** `prefers-reduced-motion` 질의는 모듈에
  하나만 두고 모든 행이 함께 구독하며, 무드마다 타이머는 최대 하나입니다. 이름이 길어 잘리는
  행에서 말풍선이 떠도 글자가 밀리지 않도록 마스코트 자리를 미리 잡아 둡니다.
  (One shared media-query listener for every row and at most one timer per mood; the mascot's
  slot is width-reserved so a truncated name does not reflow when the thinking bubble appears.)
- **모션을 끄면 정지 그림으로 떨어집니다.** `prefers-reduced-motion`에서는 무드마다 정지
  프레임을 쓰되, 도구 실행 중에는 대기와 구분되도록 작은 막대 표식 하나를 남깁니다.
  (Under reduced motion each mood resolves to a static frame, with a small static bar kept for
  the busy state so it does not collapse into idle.)

## [1.11.4] - 2026-09-03

> 입력창 옆 마스코트 CLAW'D가 **에이전트가 겪는 모든 사건에 반응**하도록 넓어졌습니다.
> 지금까지는 생각 중·도구 실행 중·턴 종료 정도만 표정이 있었고, 컨텍스트 압축이나
> worktree 생성, 권한 알림처럼 눈에 띄어야 하는 순간에는 아무 일도 없는 것처럼 서
> 있었습니다. 이제 압축이 돌면 빗자루질을 하고, worktree를 만들면 상자를 들고 걷고,
> 알림이 오면 머리 위에 느낌표를 띄웁니다. 오래 아무것도 하지 않으면 가끔 책을 펴고,
> 세션이 여러 개 동시에 돌면 그만큼 손이 빨라집니다. 동작만 늘었을 뿐, 마스코트가
> 차지하는 자리와 크기는 그대로이고 `prefers-reduced-motion`을 켠 환경에서는 예전처럼
> 정지 그림으로 떨어집니다.
> (Widens the CLAW'D mascot beside the composer so that every agent-side event has a
> matching animation. Compaction sweeps, worktree creation carries a box, notifications
> pop an exclamation mark, long idles occasionally read a book, and concurrent sessions
> speed the working loop up in tiers. The mascot's footprint is unchanged and the
> reduced-motion fallback still resolves to a static frame.)

### Added
- **압축·worktree·알림·독서 무드가 새로 생겼습니다.** 마스코트 무드가 9개에서 13개로
  늘었습니다 — 컨텍스트 압축 중에는 `sweep`(빗자루질 + 먼지), worktree를 만드는 도구가
  실행 중이면 `carry`(상자를 들고 뒤뚱), 알림 카드가 올라오면 `notify`(느낌표 팝 1회),
  한동안 아무 입력이 없으면 `read`(20~40초마다 5초간 책)로 바뀝니다. 프레임은 새 비트맵
  5장을 추가해 그렸고, 나머지는 기존 프레임 위의 CSS로 처리합니다.
  (Four new moods — sweep, carry, notify, read — bringing the mascot from 9 states to 13.)
- **동시 실행 수에 따른 속도 티어.** 세션이 1개일 때는 예전과 완전히 같은 속도이고,
  2개면 조금, 3개 이상이면 확실히 빨라집니다. 서브에이전트가 2개 이상이면 저글링도
  한 단계 빨라집니다. 새 그림 없이 프레임 간격과 CSS 클래스(`tier-1|2|3`)로만 표현해서,
  1티어는 이전 릴리스와 픽셀 단위로 동일합니다.
  (Concurrency tiers for the working and juggling loops; tier 1 is byte-identical to the
  previous behaviour, so nothing changes for the single-session case.)
- **도구 단위 실패 반응.** 지금까지는 턴 전체가 실패해야 찡그린 표정이 나왔습니다. 이제
  도구 하나가 실패한 순간 바로 반응하고, Esc로 직접 끊은 경우는 실패로 치지 않습니다.
  (A failing tool call now reacts immediately instead of waiting for the whole turn to
  fail; a user interrupt is still not treated as an error.)

### Changed
- **반응에 "작업 중에도 보이는" 층이 생겼습니다.** 기존 규칙은 일회성 반응을 한가할 때만
  띄웠는데, 알림과 도구 실패는 대개 작업이 도는 중에 일어나서 그 규칙 아래서는 화면에
  나올 기회가 없었습니다. 알림·도구 실패는 작업 표시를 잠깐 밀고 나오고, 턴 종료 반응은
  예전 그대로 새 턴이 시작되면 양보합니다.
  (Splits transient reactions into live and turn-end tiers, so a notification or tool
  failure is visible mid-work while the old "a new turn beats a stale reaction" contract
  is preserved for end-of-turn reactions.)
- **신호를 대화 기록에서 한 번에 뽑습니다.** 압축 진행·압축 완료·worktree 생성·알림·도구
  실패를 메시지 배열 한 번의 순회로 계산하고, 마스코트에는 원시 값만 넘깁니다 — 스트리밍
  델타마다 마스코트가 다시 그려지지 않습니다. 세션을 바꿀 때는 지난 세션의 알림이 다시
  재생되지 않도록 기준선을 다시 잡습니다.
  (Derives all mascot signals in a single pass over the message list and passes only
  primitives down, and re-baselines on session switch so historical notifications are not
  replayed.)

## [1.11.3] - 2026-09-01

> worktree 패널이 사이드바에서 나와 **입력창 바로 아래의 독립 버튼**이 되었습니다.
> 버튼에는 워크트리 아이콘과 지금 브랜치 이름(예: `master`)이 함께 적혀 있어서, 누르지
> 않아도 어느 브랜치에서 작업 중인지 보입니다. 사이드바 하단 버튼 행에는 통계·설정·정보
> 셋만 남습니다. 누르면 열리는 패널의 내용과 조회 전용 성격은 그대로입니다.
> (Moves the worktree panel out of the sidebar into a standalone button directly beneath the
> composer input. The button shows a worktree icon plus the current branch name, so the branch
> is visible without opening anything. The sidebar foot row keeps only stats, settings and
> info. The panel's contents and its read-only nature are unchanged.)

### Changed
- **worktree 버튼이 입력창 아래로 내려왔습니다.** 어느 브랜치에서 프롬프트를 보내는지는
  보내기 직전에 보여야 하는 값이라, 통계·설정과 나란한 사이드바 부가 패널 자리에서
  컴포저 옆으로 옮겼습니다. 입력 상자 바깥·실행 중 작업 도크 앞에 두어, 작업이 돌 때만
  자리가 밀리는 일이 없습니다.
  (The chip sits outside the input box and before the running-work dock, so its position
  does not shift when work is in progress.)
- **버튼 라벨이 현재 브랜치를 말합니다.** detached HEAD면 짧은 sha와 함께 그 사실을
  적고, 커밋이 하나도 없는 저장소도 브랜치 이름을 그대로 보여 줍니다. 세션을 옮기거나
  턴이 끝나거나 창으로 돌아올 때 다시 읽어, Claude나 터미널이 브랜치를 바꿔도 라벨이
  옛 값에 머물지 않습니다.
  (The label refreshes on session change, turn completion and window focus, so a checkout
  made by Claude or in an external terminal does not leave it stale.)
- **worktree 모달을 그 버튼이 직접 갖습니다.** 사이드바의 패널 표에서 완전히 빠졌고,
  포커스 트랩·Esc·배경 클릭·닫힘 페이드 동작은 예전과 같습니다.

### Added
- **경량 브랜치 조회 창구(`GET /api/branch`).** 늘 떠 있는 라벨을 기존 worktree 전경
  조회로 채우면 세션을 옮길 때마다 worktree 전수 상태와 60커밋 그래프를 돌게 됩니다.
  흔한 경우는 git 호출 한 번으로 끝납니다. 기준 디렉터리를 세션 id로 되찾는 규칙은
  worktree 창구와 같습니다 — 클라이언트가 경로를 부르지 않습니다.
  (A cheap current-branch endpoint for the always-visible label; the common case costs a
  single git invocation, and the working directory is still resolved server-side from the
  session id rather than accepted from the client.)

## [1.11.2] - 2026-08-31

> 권한 모드 선택창이 화면 우측 상단에서 **입력창 안쪽 우측 상단**으로 들어왔습니다.
> 무엇을 보낼지 쓰는 자리와 어떤 권한으로 보낼지 고르는 자리가 화면 양 끝으로 떨어져
> 있어서, 보내기 직전에 모드를 확인하려면 시선을 반대편까지 옮겨야 했습니다. 이제
> 입력하는 첫 줄 옆에 붙어 있어 쓰면서 그대로 보이고, 대화 위에 떠 있던 컨트롤이
> 사라져 답변의 오른쪽 위 모서리를 가리지도 않습니다. 고를 수 있는 모드와 동작은
> 그대로이고 자리만 바뀝니다.
> (Moves the permission-mode select from the screen's top-right corner into the composer's
> message box, pinned to its inner top-right. It now sits beside the first line you type,
> so the current mode stays in view while writing, and it no longer floats over the
> top-right corner of the conversation. The modes and their behaviour are unchanged —
> this is a placement change only.)

### Changed
- **권한 모드 선택창이 입력창 안으로 들어왔습니다.** 컴포저 상자 전체가 아니라 글을
  쓰는 입력 영역을 기준으로 얹었습니다. 상자 맨 윗줄에는 GOAL 배지와 인터럽트 복구
  안내가 상황에 따라 들어오는데, 상자 기준으로 띄우면 그것들 위에 겹쳐 서로를 가리기
  때문입니다. 입력 영역 기준이면 그런 안내가 있든 없든 언제나 첫 줄 옆입니다.
  (The select is anchored to the text input rather than the whole composer shell, so the
  conditionally-rendered GOAL badge and interrupt-recovery bar at the shell's top row can
  never collide with it.)
- **긴 문장이 선택창 밑으로 흐르지 않습니다.** 입력창이 선택창 너비만큼 오른쪽 여백을
  비워 두고, 그 너비를 두 곳이 같은 값으로 공유합니다 — 한쪽만 바뀌어 글자와 선택창이
  겹치는 일이 없습니다. 세션이 없어 선택창이 뜨지 않을 때는 입력창이 원래 너비를 씁니다.
  (The textarea reserves right padding from the same CSS variable that sets the select's
  width, so text wraps before the control instead of sliding under it — and the padding
  disappears when no session is open and the select is not rendered.)
- **화면 우측 상단에는 세션 이름 배지만 남습니다.** 세션이 열려 있고 사이드바를 접었을
  때만 나오며, 그 조건이 아닐 때는 배지 띠도 채팅 위쪽 여백도 만들지 않습니다.
  (The floating top-right strip now carries only the session-name badge, and both the strip
  and the chat's top offset are created only when that badge is actually shown.)

## [1.11.1] - 2026-08-31

> 5시간·7일 사용량 한도가 걸리거나 다시 풀릴 때 브라우저 알림을 받을 수 있습니다.
> 한도에 걸린 줄 모르고 쓰다가 막히는 일을 줄이려는 것으로, 설정 → 세션 탭의
> **사용량 한도 알림**을 켜면 동작하고 기본값은 꺼짐입니다. 처음 켤 때 브라우저가 알림
> 권한을 묻습니다. 사용률은 이미 60초마다 받아 오던 값을 그대로 쓰므로 새로 조회하는
> 것이 없고, 따라서 이 기능은 구독을 한 톨도 쓰지 않습니다. 알림은 창이 한도에 닿는
> 순간과 다시 풀리는 순간에만 한 번씩 오고, 앱을 켤 때나 조회가 잠시 실패할 때는 오지
> 않습니다 — 잘못 오는 알림 하나가 기능 자체를 꺼 버리게 만들기 때문입니다.
> (Adds optional browser notifications when the 5-hour or 7-day usage window hits its limit
> or frees up again. Off by default; enable it under Settings → 세션. It reads the usage
> figures the app already polls every 60 seconds, so it makes no extra request and consumes
> no subscription quota. Notifications fire only on an actual threshold crossing — never on
> app start, a repeated value, or a failed poll.)

### Added
- **사용량 한도 알림.** 5시간 창과 7일 창을 각각 따로 보고, 사용률이 100%에 닿으면
  "5시간 사용량 한도 도달", 다시 100% 아래로 내려가면 "5시간 사용량 한도 해제"를
  띄웁니다. 본문에는 사용률과 초기화 시각이 함께 들어갑니다. 창 이름을 제목에 넣은
  것은 두 창이 한꺼번에 걸렸을 때 무엇이 걸렸는지 알림 목록에서 바로 보이게 하기
  위해서입니다. 창마다 알림을 하나로 유지하므로, 해제 알림이 앞선 도달 알림을 대신하고
  브라우저 탭을 여러 개 열어 두어도 같은 알림이 여러 번 쌓이지 않습니다.
  (Per-window notifications on crossing 100% in either direction, titled by window so
  simultaneous 5h/7d events stay distinguishable, and collapsed to one live notification
  per window so releases replace hits and extra tabs do not multiply them.)
- **설정 → 세션 탭의 켬/끔 스위치.** 기본값은 꺼짐입니다. 브라우저가 알림을 지원하지
  않을 때, 이 사이트의 알림을 차단해 두었을 때, 권한 요청 창을 닫아 아직 권한이 없을
  때를 각각 다른 문구로 안내합니다. 마지막 경우에는 **권한 요청** 버튼이 함께 나와
  스위치를 껐다 켜지 않고도 다시 물어볼 수 있습니다 — 브라우저는 사용자가 직접 누른
  경우에만 권한 창을 띄우기 때문입니다.
  (A switch under Settings → 세션, off by default, with distinct notes for unsupported,
  blocked, and not-yet-granted permission — the last carrying a 권한 요청 button, since
  browsers only surface the prompt from a user gesture.)

### Fixed
- **사용량 폴링의 응답 순서.** 한 요청이 폴링 주기보다 오래 걸리면 뒤늦게 도착한 옛
  응답이 새 값을 덮어써 사용률이 잠깐 뒷걸음질칠 수 있었습니다. 이제 순번을 붙여 뒤처진
  응답을 버립니다. 상태줄 수치가 튀지 않고, 새 알림이 그 뒷걸음을 "한도 해제"로 잘못
  읽지도 않습니다.
  (Usage poll responses are now sequence-guarded, so a slow request arriving out of order
  can no longer roll the displayed utilization backwards — or fake a limit-release event.)

## [1.11.0] - 2026-08-30

> git worktree 현황을 브라우저에서 볼 수 있습니다. 사이드바 아래쪽에 **worktree** 버튼이
> 생겼고, 누르면 지금 세션이 열려 있는 저장소의 커밋 그래프와 worktree 목록이 뜹니다.
> 카드마다 브랜치·경로·깨끗함/변경됨·변경 파일 수·최근 커밋이 있고, 그 디렉터리에서
> 열린 CC-on-browser 세션 이름도 함께 보입니다 — 어느 작업이 어느 갈래에서 돌고 있는지
> 확인하러 터미널로 나갈 일이 줄어듭니다. 이번 단계는 **보기 전용**입니다: worktree를
> 만들거나 지우거나 옮겨 다니는 버튼은 없고, 세션 이름도 표시만 될 뿐 눌러도 이동하지
> 않습니다. 서버가 실행하는 git 명령도 조회형 넷뿐입니다.
> (Adds a read-only git worktree view. A new sidebar panel shows the commit graph for the
> repository your session is in, plus one card per worktree — branch, path, clean/dirty,
> changed-file count, latest commit — and the names of CC-on-browser sessions whose working
> directory sits inside it. Display only: no create, remove, prune or switch actions, and
> session names are not clickable.)

### Added
- **worktree 패널.** 사이드바 하단 버튼 행의 네 번째 항목으로, 기존 통계·설정과 같은
  중앙 모달로 열립니다. 위쪽 커밋 그래프는 각 worktree의 HEAD가 어느 갈래에 있고 어디서
  갈라졌는지를 보여 주고, 그래프 옆에는 같은 커밋이 짧은 해시·제목·시각으로 나란히
  적혀 그림 없이도 읽을 수 있습니다. 지금 세션이 붙어 있는 worktree 카드는 강조됩니다.
  (A new fourth entry in the sidebar footer opens a center modal: a commit graph marking
  each worktree's HEAD, with a readable commit list beside it, and one card per worktree.)
- **세션이 어느 worktree에 있는지 표시.** 라이브 세션과 최근 세션 모두 자기 작업
  디렉터리가 속한 worktree 카드에 이름으로 실립니다. 이름은 사이드바와 똑같은 우선순위
  (직접 지정한 이름 → CLI가 붙인 이름 → 첫 발화 요약)를 따르므로, 두 화면이 같은 세션을
  다른 이름으로 부르지 않습니다.
  (Live and recent sessions appear on the card for the worktree containing their working
  directory, named by the same precedence the sidebar uses.)
- **상태별 안내.** git이 없을 때, 저장소가 아닐 때, git이 저장소를 신뢰하지 않을 때
  (소유자 불일치), 실행 중인 세션이 없을 때를 각각 다른 문구로 안내합니다 — 어느 경우도
  빈 화면으로 두지 않습니다.
  (git missing, not a repository, dubious-ownership refusal, and no live session each get
  their own message instead of a silent empty panel.)

### Security
- **조회 경로가 하위 프로세스 창구가 되지 않게 했습니다.** git을 어느 디렉터리에서
  실행할지는 요청이 아니라 서버가 정합니다 — 조회 API는 경로가 아니라 세션 식별자를
  받아, 실제 작업 디렉터리를 서버의 세션 장부에서 되찾습니다. git 인자는 항상 배열로
  넘겨 셸을 거치지 않고, `core.fsmonitor`를 꺼서 저장소 설정에 걸린 훅이 조회만으로
  실행되는 경로도 함께 막습니다.
  (The worktree API takes a session id, not a path: the server resolves the working
  directory from its own session ledger, so a request can never choose where git runs.
  Arguments are always passed as an array — never through a shell — and `core.fsmonitor`
  is disabled so a repository-configured hook cannot run during a read.)

## [1.10.6] - 2026-08-29

> 지난 세션 목록에서 CLI 이름이 보이지 않던 것을 고쳤습니다. 지난 릴리스에서 터미널의
> 세션 이름을 브라우저에도 띄웠는데, 정작 목록에서는 여전히 첫 발화 요약만 보이는
> 경우가 대부분이었습니다. 원인은 Claude Code CLI가 세션이 끝나면 이름을 적어 둔 파일을
> 스스로 지운다는 데 있었습니다 — 그 이름은 트랜스크립트에도 없어서, 세션이 끝나는
> 순간 어디에도 남지 않았습니다. 이제 한 번이라도 본 이름을 따로 적어 두었다가 세션이
> 끝난 뒤에 대신 보여 줍니다. 터미널에서 이름을 바꾸면 살아 있는 이름이 언제나
> 먼저이므로, 바뀐 이름이 그 즉시 반영됩니다.
> (Fixes CLI session names disappearing from the past-session list: the CLI deletes its
> own name file when a session ends, so a finished session's name survived nowhere. Names
> we have observed are now remembered and used as a fallback once that file is gone; the
> live file always wins, so renaming in the terminal still shows up immediately.)

### Fixed
- **끝난 세션의 CLI 이름이 목록에서 사라지던 것.** 관찰한 이름을 앱 소유 디렉터리
  (`~/.cc-on-browser/session-names.json`)에 적어 두고, CLI가 이름 파일을 지운 뒤의
  폴백으로 씁니다. 살아 있는 파일이 언제나 우선이라 CLI에서 이름을 바꾸면 곧바로
  새 이름이 보이고, 저장소는 그 파일이 사라진 뒤만 메웁니다. 저장은 임시 파일에 쓴 뒤
  이름 바꾸기로 원자 교체하며, 읽지 못한 저장소 위에는 절대 쓰지 않습니다 — 일시적인
  읽기 실패를 "비어 있음"으로 오해해 기억 전체를 덮어쓰지 않기 위해서입니다. 항목은
  500개까지만 유지하고 오래된 것부터 버립니다.
  (Observed names are persisted to `~/.cc-on-browser/session-names.json` and used only as a
  fallback after the CLI removes its own file. Writes go through a temp file + atomic
  rename, are serialized per store path, never proceed on top of an unreadable store, and
  are capped at 500 entries.)

### Changed
- **이름 저장소는 실제 앱 실행에서만 켜집니다.** 부수효과를 갖는 기능이라 진입점
  (`bin/cc-on-browser.mjs`)만 옵트인하고, 라이브러리로서의 `startServer` 기본값은
  "저장소 없음"입니다 — 서버를 띄우는 것만으로 홈 디렉터리에 파일이 생기지 않습니다.
  (The name store is opt-in from the app entry point only; `startServer`'s default remains
  side-effect free.)

## [1.10.5] - 2026-08-24

> 터미널에서 쓰던 세션 이름이 브라우저에도 그대로 보입니다. Claude Code CLI는
> 세션마다 이름을 자동으로 만들어 두는데, 지금까지 브라우저는 그걸 모른 채 첫
> 발화 요약을 제목으로 썼습니다 — 같은 세션을 터미널과 브라우저가 서로 다른
> 이름으로 부르는 셈이었습니다. 이제 사이드바의 세션 목록, 사이드바를 접었을
> 때의 이름 배지, 지난 세션 목록, 삭제 확인 창이 모두 CLI가 붙인 그 이름을
> 보여 줍니다.
> (Sessions now show the CLI's own auto-generated session name in the browser — the
> sidebar rows, the collapsed-sidebar name badge, the past-session list and the delete
> confirmation all use the same name you see in the terminal.)

### Added
- **CLI가 붙인 세션 이름이 화면에 보입니다.** 직접 지정한 이름이 있으면 여전히 그것이
  먼저이고, 그다음이 CLI 이름, 그것도 없으면 기존처럼 첫 발화 요약으로 돌아갑니다.
  라이브 세션은 시작되어 id가 확정되는 즉시 이름을 찾아 반영하고, CLI가 이름을 조금
  늦게 적는 경우도 잠시 기다렸다가 잡아냅니다. `/clear`처럼 세션 id가 바뀌면 옛 이름을
  붙들지 않고 새 세션의 이름을 다시 찾으며, 브라우저를 새로고침해 다시 접속해도 이름이
  사라지지 않습니다.
  (Display priority is custom title → CLI name → first-utterance summary. Live sessions
  pick the name up as soon as the session id is known, retry briefly when the CLI writes
  the name file late, drop the stale name when `/clear` or a fork changes the session id,
  and keep it across reconnects.)

## [1.10.4] - 2026-08-24

> 입력창에서 모델이나 노력 수준을 바꿔도 적용되지 않거나, 손대지도 않았는데 저 혼자
> 바뀌던 문제를 고쳤습니다. 세 가지 원인이 겹쳐 있었습니다 — 모델 변경을 CLI가 받아들였는지
> 확인하지 않고 화면만 먼저 바꾸던 것, 진행 중인 답변이 계속 보고하는 **이전** 모델을 그대로
> 받아 방금 고른 모델을 되돌리던 것, 그리고 모델마다 쓸 수 있는 노력 수준이 다른 탓에
> 슬라이더가 '낮음'으로 내려앉던 것입니다.
> (Fixes model / effort-level changes in the composer that either did not take effect or
> changed by themselves: the model switch was applied to the UI before the CLI accepted it,
> in-flight turns kept reporting the *previous* model and overwrote the choice, and the
> effort slider collapsed to '낮음' whenever the current level was outside the new model's
> supported list.)

### Fixed
- **모델을 바꿨는데 적용되지 않던 것.** 예전에는 서버로 요청을 보내는 데 성공하기만 하면
  화면의 모델 피커를 곧바로 바꿨습니다. 그런데 Claude CLI는 모델을 거부할 수 있습니다 —
  알 수 없는 모델 id, 조직 정책 제한, 동의가 필요한 모델 등. 그때 화면만 새 모델로 남아
  실제 세션과 어긋났고, 사용자에게는 "바꿨는데 그대로 옛 모델로 답한다"로 보였습니다.
  이제 CLI가 실제로 받아들인 뒤에야 피커가 바뀝니다. 거부되면 피커는 그대로 있고 CLI가
  알려 준 사유가 표시됩니다. 응답이 아예 없으면(데몬이 구버전인 경우) 실패로 단정하지 않고
  "적용됐는지 확인하지 못했다"고 알립니다 — 그 데몬도 변경 자체는 CLI에 전달하므로 이미
  적용됐을 수 있고, 실패라고 말하면 반대 방향의 거짓이 되기 때문입니다.
  (Model changes now wait for the CLI's acknowledgement before the picker moves. A refusal
  leaves the picker untouched and surfaces the CLI's own reason; a missing acknowledgement is
  reported as "could not confirm" rather than as a failure, because a stale daemon still
  forwards the change.)
- **손대지 않았는데 모델 표시가 저 혼자 바뀌던 것.** 모델 전환은 다음 API 호출부터 걸리므로,
  이미 시작된 답변은 계속 **이전** 모델을 보고합니다. 그 보고를 그대로 받아들여 방금 고른
  모델이 되돌아갔고, 다음 턴에 새 모델 보고가 오면 또 혼자 바뀌었습니다(왕복). 이제 전환이
  확정될 때까지는 고른 모델과 같은 계열의 보고만 받아들입니다. 대기가 영구히 걸리지 않도록
  다음 턴이 끝나는 시점과 세션 종료가 반드시 이 대기를 풀어 주므로, CLI가 조용히 다른 모델로
  대체한 경우에도 다음 턴부터는 실제 모델이 그대로 보입니다.
  (An in-flight turn's stale model report no longer overwrites a just-made switch; the pending
  state is always released at the next turn boundary or on session exit, so a CLI-side
  substitution still surfaces truthfully from the following turn.)
- **모델을 바꾸면 CTX 사용률이 실제보다 훨씬 낮게 보이던 것.** 1M 컨텍스트 모델에서 200k
  모델로 바꾼 직후, 아직 이전 모델로 돌던 답변이 끝나면서 보고한 1M 창 크기가 새 모델에
  붙어 사용률이 1/5로 축소 표시됐습니다. 전환이 확정되기 전에는 이전 모델의 창 크기를
  받아들이지 않습니다.
  (The context-window denominator is no longer taken from the previous model's turn while a
  switch is pending — a 1M→200k switch used to show CTX% at a fifth of the real value.)
- **모델을 바꾸면 노력 수준 슬라이더가 '낮음'으로 내려앉던 것.** 쓸 수 있는 노력 수준은
  모델마다 다른데, 현재 값이 새 모델의 목록에 없으면 슬라이더가 위치를 못 찾아 맨 왼쪽으로
  뭉개졌습니다. 이제 현재 값을 표시에서 잃지 않습니다. 표시로만 남는 것이라 그 모델이
  지원하지 않는 수준이 새로 전송되지는 않습니다.
  (The effort slider keeps the current level visible even when the new model does not list it,
  instead of collapsing to the lowest tier; retention is display-only and never sends an
  unsupported level.)
- **적용 여부를 확인하지 못한 모델 변경 뒤에 세션이 재시작되면 버린 모델로 되살아나던 것.**
  노력 수준 변경이 구버전 CLI에서 세션 재시작으로 폴백할 때 쓰는 스폰 인자가, 확인되지 않은
  모델 변경 뒤에도 옛 모델을 가리키고 있었습니다. 이제 확인하지 못한 변경 뒤에는 그 인자를
  비워, 재시작이 대화의 실제 모델로 이어집니다.
  (After an unconfirmed model change the spawn lineage is cleared, so the effort-restart
  fallback no longer respawns the model the user just abandoned.)

## [1.10.3] - 2026-08-23

> 화면 크롬 정리입니다. 입력창 위의 레포 pill을 걷어내 새 세션 진입을 사이드바
> 하나로 모으고, 권한 모드는 반대로 입력창 밖 화면 우측 상단으로 꺼내 항상 같은
> 자리에 두었습니다. 설정 → 테마에는 색(라이트/다크)과 별개로 **모서리 모양**을
> 고르는 축이 생겨, 지금까지의 둥근 UI를 각진 UI로 통째로 바꿀 수 있습니다.
> (Screen-chrome cleanup: the repo pill leaves the composer so the sidebar is the single
> new-session entry point, the permission-mode selector moves out to a fixed spot at the
> top-right, and 설정 → 테마 gains a corner-shape axis — rounded or square — independent
> of light/dark.)

### Added
- **모서리 스타일(둥근/각진)을 고를 수 있습니다.** 설정 → 테마에 '모서리' 항목이 생겼습니다.
  기본값은 지금까지와 같은 **둥근(pill)**이고, **각진(square)**을 고르면 버튼·칩·카드·입력창·
  모달까지 화면 전체가 함께 각져집니다. 색 테마와는 완전히 독립된 축이라 라이트·다크 어느
  쪽과도 조합되며, 한쪽을 바꿔도 다른 쪽을 덮어쓰지 않습니다. 선택은 브라우저에 저장되고
  페이지를 열 때 **첫 그림부터** 적용되므로 새로고침할 때 이전 모양이 한 번 번쩍이지
  않습니다. 상태 점처럼 '동그라미'가 곧 뜻인 요소는 각진 모드에서도 원형으로 남습니다.
  (New 모서리 setting in 설정 → 테마 — pill (default, unchanged) or square, applied across
  the whole UI through the radius tokens and fully independent of light/dark.)

### Changed
- **권한 모드가 입력창을 떠나 화면 우측 상단으로 갔습니다.** 대화가 길어져 입력창이
  커지거나 스크롤을 올려도 지금 어떤 권한 모드인지가 늘 같은 자리에 보입니다. 고르는 방법과
  동작은 그대로입니다 — 신뢰모드는 여전히 세션을 시작할 때만 들어갈 수 있고, 연결이 끊긴
  상태에서는 화면만 바뀌지 않도록 잠깁니다. 사이드바를 접었을 때 뜨던 세션 이름 배지와 한
  줄에 나란히 놓이며, 창이 좁아지면 이름 배지가 먼저 줄어듭니다.
  (The permission-mode selector moved out of the composer to the top-right of the main area,
  where it stays visible regardless of composer height or scroll position.)
- **알림 토스트가 조금 아래에서 뜹니다.** 예전 위치(위에서 14px)는 새로 생긴 우측 상단
  컨트롤과 같은 띠라, 권한 모드를 바꾼 직후 그 변경 토스트가 방금 누른 셀렉트를 덮어
  연달아 조작할 수 없었습니다.
  (Toasts now start below the new top control rail instead of overlapping it.)

### Removed
- **입력창 위의 workspace(레포) pill을 없앴습니다.** 새 세션은 사이드바의 '+ 새 세션'
  하나로만 들어갑니다 — 같은 일을 하는 입구가 둘이었고, 현재 작업 디렉터리는 사이드바
  세션 목록과 (접었을 때는) 우측 상단 배지가 이미 보여 주고 있었습니다. 이에 맞춰 세션이
  없을 때의 빈 화면 안내도 "아래에서 레포를 고르고"에서 사이드바를 가리키도록 고쳤습니다.
  (The workspace/repo pill is gone from the composer; the sidebar's '+ 새 세션' is now the
  single entry point, and the empty-state hint points there instead of at the old pill.)

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

[Unreleased]: https://github.com/seokjw0727/CC-on-browser/compare/v1.11.6...HEAD
[1.11.6]: https://github.com/seokjw0727/CC-on-browser/compare/v1.11.5...v1.11.6
[1.11.5]: https://github.com/seokjw0727/CC-on-browser/compare/v1.11.4...v1.11.5
[1.11.4]: https://github.com/seokjw0727/CC-on-browser/compare/v1.11.3...v1.11.4
[1.11.3]: https://github.com/seokjw0727/CC-on-browser/compare/v1.11.2...v1.11.3
[1.11.2]: https://github.com/seokjw0727/CC-on-browser/compare/v1.11.1...v1.11.2
[1.11.1]: https://github.com/seokjw0727/CC-on-browser/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.6...v1.11.0
[1.10.6]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.5...v1.10.6
[1.10.5]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.4...v1.10.5
[1.10.4]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.3...v1.10.4
[1.10.3]: https://github.com/seokjw0727/CC-on-browser/compare/v1.10.2...v1.10.3
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
