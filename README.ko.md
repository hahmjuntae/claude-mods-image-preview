# image-preview

[English](README.md) | 한국어

Claude Code 입력창에 이미지를 붙여넣으면 프롬프트 위에 썸네일을 표시하는 모드입니다. 터미널 종류와 관계없이 동작합니다.

![Claude Code 프롬프트 위에 표시된 붙여넣은 이미지 썸네일 2장](docs/screenshot.png)

이미지를 지원하지 않는 터미널에서는 같은 배치를 RGB 반블록 문자로 그립니다.

```
╭────────────╮ ╭────────────────────────╮
│▀▀▀▀▀▀▀▀▀▀▀▀│ │▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│
│▀▀▀▀▀▀▀▀▀▀▀▀│ │▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│
│▀▀▀▀▀▀▀▀▀▀▀▀│ │           #2           │
│     #1     │ ╰────────────────────────╯
╰────────────╯
❯ [Image #1] [Image #2] 이 두 화면 비교해줘
```

## 설치

Claude Code 터미널 세션의 프롬프트에 입력합니다.

```
/plugin install image-preview --marketplace hahmjuntae/claude-image-preview
```

1. `Add marketplace?` 질문에 `y` 를 입력합니다.
2. 설치 범위를 고릅니다. 기본값은 user 범위입니다.
3. `Installed image-preview. Plugin is now active.` 가 표시되면 현재 세션부터 적용됩니다.

함수 훅 모드를 지원하는 Claude Code 가 필요합니다. Claude Code 2.1.292 에서 검증했습니다.

## 동작 방식

| 단계 | 내용 |
|---|---|
| 감지 | 입력창 초안을 300ms 간격으로 읽어 `[Image #N]` 토큰을 찾습니다 |
| 원본 | Claude Code 가 붙여넣는 즉시 세션 임시 폴더에 저장하는 `images/N.*` 파일을 읽습니다 |
| 렌더링 | 터미널이 지원하는 가장 좋은 렌더러로 썸네일을 그립니다 |
| 정리 | 토큰을 지우거나 프롬프트를 보내면 썸네일이 사라집니다 |

## 렌더러

| 터미널 | 표시 방식 |
|---|---|
| kitty, Ghostty (tmux, screen, SSH 밖) | kitty graphics protocol 실제 픽셀 |
| 그 외 전부: iTerm2, Terminal.app, WezTerm, Alacritty, Windows Terminal, VS Code, tmux, screen, SSH | 위아래 반블록 문자 `▀` `▄` 와 RGB 색상 |

kitty 계열로 판단했지만 터미널이 그래픽 질의에 응답하지 않으면 반블록으로 자동 전환합니다.

tmux 안에서는 항상 반블록으로 표시합니다. Claude Code 는 tmux 안에서 kitty graphics 를 내보내지 않고, tmux 이미지 전달에 쓰이는 kitty 유니코드 플레이스홀더 문자 `U+10EEEE` 도 거부합니다.

## 설정

`/config` 에서 바꿀 수 있습니다.

| 이름 | 값 | 기본값 |
|---|---|---|
| `renderer` | `auto`, `blocks`, `pixels`, `asterisk` | `auto` |
| `size` | `small` 16x4, `medium` 24x6, `large` 40x10 (터미널 칸 기준) | `medium` |

`auto` 는 kitty 와 Ghostty 에서 픽셀, 그 외에서 반블록을 고릅니다. `asterisk` 는 터미널 연동 절의 오버레이 렌더러입니다.

## 지원 형식

| 형식 | 처리 |
|---|---|
| PNG | 내장 디코더. 1/2/4/8/16비트, 팔레트, 투명도, 인터레이스 지원 |
| JPEG, GIF, WebP, HEIC 등 | macOS `sips` 로 축소 PNG 변환 후 표시 |
| 4MiB 초과 PNG | macOS `sips` 로 축소 후 표시 |

macOS 가 아닌 환경에서 PNG 외 형식은 `미리보기 불가` 로 표시합니다.

## 터미널 연동

터미널이 마커 셀 위에 이미지를 겹쳐 그리면 tmux 안에서도 실제 픽셀을 표시할 수 있습니다. 모드는 `renderer` 가 `asterisk` 이거나 환경 변수 `ASTERISK_APP_TERMINAL=1` 이 있을 때 마커 셀을 그리고, 원본 이미지를 `~/.claude/image-preview/<id 16진수 다섯 자리>` 심볼릭 링크로 둡니다.

| 이름 | 설명 |
|---|---|
| 글리프 | `U+2800 + (row << 4 \| rows - 1)`, row 는 0부터, rows 는 16 이하 |
| 전경색 | 니블 `0xA`, `id[19:16]`, `id[15:12]` 를 각각 `니블 × 17` 채널값으로 기록 |
| 배경색 | 니블 `id[11:8]`, `id[7:4]`, `id[3:0]` 을 각각 `니블 × 17` 채널값으로 기록 |
| id | 원본 경로 FNV-1a 32비트 해시의 하위 20비트 |

Claude Code 의 `Raster` 팔레트는 17 배수 채널값을 보존하므로 tmux 를 거쳐도 값이 바뀌지 않습니다. 터미널은 화면에서 이 셀을 찾아 id 별로 묶고, 링크된 이미지를 그 위에 그립니다.

## 개발

```
claude plugin validate .
claude plugin test .
```

## 라이선스

MIT
