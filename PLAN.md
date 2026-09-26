# New File — Plan

**Priority tier:** 2 · **Bundle ID:** `com.xorro.new-file`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Easy New File | 13,930 |
| **Total** | **13,930** |

**Alfred today:** Several 2013 'Create New File' workflows, all unmaintained.

## Features (v1.0)
- [ ] `new <name.ext>` create in frontmost Finder window (or Desktop) and open/rename
- [ ] Templates folder: md, txt, html, py, sh, docx/xlsx/pages blanks
- [ ] Hotkey to create + open in default app

## Tech
- **Stack:** zsh + JXA (Finder insertion location).
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
