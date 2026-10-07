# image-preview

English | [한국어](README.ko.md)

A Claude Code mod that shows thumbnails of pasted images right above the prompt, in any terminal.

```
╭────────────╮ ╭────────────────────────╮
│▀▀▀▀▀▀▀▀▀▀▀▀│ │▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│
│▀▀▀▀▀▀▀▀▀▀▀▀│ │▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│
│▀▀▀▀▀▀▀▀▀▀▀▀│ │           #2           │
│     #1     │ ╰────────────────────────╯
╰────────────╯
❯ [Image #1] [Image #2] compare these two screens
```

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install image-preview --marketplace hahmjuntae/claude-image-preview
```

1. Answer `y` to `Add marketplace?`.
2. Pick a scope. The user scope is the default.
3. When `Installed image-preview. Plugin is now active.` appears, the mod is running in the current session.

Requires a Claude Code build with function-hook mods. Tested on Claude Code 2.1.292.

## How it works

| Step | What happens |
|---|---|
| Detect | Reads the prompt draft every 300 ms and looks for `[Image #N]` tokens |
| Source | Reads `images/N.*`, which Claude Code writes to the session temp folder the moment you paste |
| Draw | Renders a thumbnail with the best renderer your terminal supports (see below) |
| Clear | Thumbnails disappear when you delete the token or submit the prompt |

## Renderers

| Terminal | Thumbnail |
|---|---|
| kitty, Ghostty (outside tmux, screen and SSH) | Real pixels through the kitty graphics protocol |
| Everything else: iTerm2, Terminal.app, WezTerm, Alacritty, Windows Terminal, VS Code, tmux, screen, SSH | Colored half-block characters (`▀` `▄`) |

If a terminal looks like kitty but does not answer the graphics query, the mod switches to half-blocks on its own.

Inside tmux the thumbnail is always drawn with half-blocks. Claude Code does not send kitty graphics inside tmux, and it rejects the kitty Unicode placeholder character (`U+10EEEE`) that tmux image passthrough relies on.

## Settings

Change them in `/config`.

| Name | Values | Default |
|---|---|---|
| `renderer` | `auto`, `blocks`, `pixels`, `asterisk` | `auto` |
| `size` | `small` 16x4, `medium` 24x6, `large` 40x10 (terminal cells) | `medium` |

`auto` picks pixels on kitty and Ghostty and half-blocks everywhere else. `asterisk` is the overlay renderer described under Terminal integration.

## Supported formats

| Format | Handling |
|---|---|
| PNG | Built-in decoder: 1/2/4/8/16-bit, palette, transparency, interlaced |
| JPEG, GIF, WebP, HEIC and others | Converted to a small PNG with macOS `sips` |
| PNG over 4 MiB | Downscaled with macOS `sips` |

Outside macOS, formats other than PNG show `미리보기 불가` (preview unavailable).

## Terminal integration

A terminal can show real pixels even inside tmux by drawing an image over marker cells. The mod draws marker cells when `renderer` is `asterisk` or the environment has `ASTERISK_APP_TERMINAL=1`, and links the source image to `~/.claude/image-preview/<id as five hex digits>`.

| Field | Encoding |
|---|---|
| Glyph | `U+2800 + (row << 4 \| rows - 1)`, row counted from 0, at most 16 rows |
| Foreground | Nibbles `0xA`, `id[19:16]`, `id[15:12]`, each written as channel value `nibble × 17` |
| Background | Nibbles `id[11:8]`, `id[7:4]`, `id[3:0]`, each written as channel value `nibble × 17` |
| id | Low 20 bits of the FNV-1a 32-bit hash of the source path |

The Claude Code `Raster` palette keeps channel values that are multiples of 17, so the markers pass through tmux unchanged. A terminal scans its screen for these cells, groups them by id and draws the linked image over them.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
