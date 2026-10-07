# claude-mods-image-preview

English | [한국어](README.ko.md)

A Claude Code mod that shows thumbnails of pasted images right above the prompt, in any terminal.

![Thumbnails of two pasted images above the Claude Code prompt](docs/screenshot.png)

Terminals without image support get the same layout in colored quadrant blocks:

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
/plugin install mods-image-preview --marketplace hahmjuntae/claude-mods-image-preview
```

1. Answer `y` to `Add marketplace?`.
2. Pick a scope. The user scope is the default.
3. When `Installed mods-image-preview. Plugin is now active.` appears, the mod is running in the current session.

Requires a Claude Code build with function-hook mods. Tested on Claude Code 2.1.292.

## How it works

| Step | What happens |
|---|---|
| Detect | Reads the prompt draft every 300 ms and looks for `[Image #N]` tokens |
| Source | Reads `images/N.*`, which Claude Code writes to the session temp folder the moment you paste |
| Draw | Renders a thumbnail with the best renderer your terminal supports (see below) |
| Fit | Shrinks thumbnails to the rows and columns free above the prompt. When the frame would make the image smaller than its size setting, the frame is dropped and the number moves beside the image |
| Open | Opens the original in the connected IDE's editor without taking the focus (see Original quality) |
| Clear | Thumbnails disappear when you delete the token or submit the prompt |

## Renderers

| Terminal | Thumbnail |
|---|---|
| kitty, Ghostty (outside tmux, screen and SSH) | Real pixels through the kitty graphics protocol |
| A terminal that advertises the overlay (see Terminal integration), tmux included | Real pixels drawn by the terminal over marker cells |
| Everything else: iTerm2, Terminal.app, WezTerm, Alacritty, Windows Terminal, VS Code, tmux, screen, SSH | Colored quadrant block characters (`▀` `▌` `▚` `▗` ...), two pixels across and two down per cell |
| Any terminal or IDE on Windows, with `renderer` set to `window` | The original at full quality, drawn by a helper window over the thumbnail (see Original quality) |

If a terminal looks like kitty but does not answer the graphics query, the mod switches to quadrant blocks on its own.

Each cell picks the two colors and the quadrant glyph that best fit its 2x2 pixels, so a cell holds twice the horizontal detail of a half-block (`▀`) while a split between the pixel rows still draws as `▀`.

Inside tmux, Claude Code does not send kitty graphics, and it rejects the kitty Unicode placeholder character (`U+10EEEE`) that tmux image passthrough relies on. So inside tmux the thumbnail is drawn with quadrant blocks unless the outer terminal supports the overlay.

## tmux

Thumbnails work inside tmux with no extra setup. Two settings decide whether their colors are exact:

| Setting | Where | Why |
|---|---|---|
| `export CLAUDE_CODE_TMUX_TRUECOLOR=1` | Shell profile (`~/.zshrc`, `~/.bashrc`) | Claude Code lowers its colors to 256 inside tmux unless this is set. On Claude Code 2.1.292 a thumbnail drew with 256-color codes without it and 24-bit RGB with it |
| `set -sa terminal-features ',*:RGB'` | `~/.tmux.conf` (tmux 3.2+) | Lets tmux pass 24-bit color to the outer terminal. On older tmux use `set -ga terminal-overrides ',*:Tc'` |

The overlay renderer needs both inside tmux. Without `CLAUDE_CODE_TMUX_TRUECOLOR=1` the mod falls back to quadrant blocks on its own.

## Windows

Works in Windows Terminal, PowerShell and Git Bash with quadrant blocks. PNG is decoded by the built-in decoder, and other formats are converted with PowerShell (`System.Drawing`) when it is available.

## Original quality

A terminal draws a thumbnail out of text cells unless it speaks the kitty graphics protocol, so in the JetBrains terminal, Windows Terminal, VS Code and the rest a screenshot's text cannot be read in the thumbnail. The mod therefore offers two ways to see the original:

- `renderer` set to `window` (Windows): the thumbnail is painted in one marker color, and a helper (`hooks/overlay.ps1`, PowerShell with C#) finds that rectangle on screen about ten times a second and draws the original over it in a borderless window. The window takes neither the focus nor clicks, follows the band as it moves, and disappears with the token, the submitted prompt, or the terminal leaving the screen. It is excluded from screen capture, so it does not show in your own screenshots. The helper only reads the screen to find the marker, keeps nothing, and exits within 15 seconds after the session ends; if it cannot start, the session falls back to blocks.
- With `open` set to `ide`, inside an IDE terminal with the Claude Code extension (JetBrains, VS Code), each pasted image opens once in an editor tab, the IDE's own image viewer at full quality. The tab opens without taking the focus, so you keep typing in the prompt, and the thumbnail above the prompt shrinks to a one-line `#1 in IDE`. When Claude Code does not lend the IDE connection to mods, the mod reaches the same IDE server itself through PowerShell on Windows.
- Pressing a thumbnail's number (`#1`) opens it again, in the IDE or, outside an IDE, in the system image viewer.
- `open` set to `viewer` also opens the system image viewer on paste when no IDE is connected.

This only changes what you see. Claude always receives the original file.

## Settings

Change them in `/config`.

| Name | Values | Default |
|---|---|---|
| `renderer` | `auto`, `blocks`, `pixels`, `overlay`, `window` | `auto` |
| `size` | `small` 16x4, `medium` 24x6, `large` 40x10 (terminal cells) | `medium` |
| `open` | `off`, `ide`, `viewer` | `off` |

`auto` picks the overlay when the terminal advertises it, pixels on kitty and Ghostty, and quadrant blocks everywhere else.

## Supported formats

| Format | Handling |
|---|---|
| PNG | Built-in decoder: 1/2/4/8/16-bit, palette, transparency, interlaced |
| JPEG, GIF, WebP, HEIC and others | Converted to a small PNG with the first converter found: macOS `sips`, ImageMagick (`magick`, `convert`), Windows PowerShell |
| PNG over 4 MiB | Downscaled with the same converters |

Without any of these converters, formats other than PNG show `unsupported`.

## Terminal integration

A terminal can show real pixels even inside tmux by drawing an image over marker cells.

1. Advertise the overlay by setting `CLAUDE_MODS_IMAGE_OVERLAY=1` in the environment of the shells it starts. Inside tmux, the mod also accepts the same variable in the tmux global environment (`tmux set-environment -g CLAUDE_MODS_IMAGE_OVERLAY 1`), so panes that were already open pick it up.
2. The mod draws marker cells in place of the thumbnail and links the source image to `~/.claude/claude-mods-image-preview/<id as five hex digits>`.
3. The terminal scans its screen for marker cells, groups them by id and draws the linked image over them.

| Field | Encoding |
|---|---|
| Glyph | `U+2800 + (row << 4 \| rows - 1)`, row counted from 0, at most 16 rows |
| Foreground | Nibbles `0xA`, `id[19:16]`, `id[15:12]`, each written as channel value `nibble × 17` |
| Background | Nibbles `id[11:8]`, `id[7:4]`, `id[3:0]`, each written as channel value `nibble × 17` |
| id | Low 20 bits of the FNV-1a 32-bit hash of the source path |

The Claude Code `Raster` palette keeps channel values that are multiples of 17, so the markers pass through tmux unchanged.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
