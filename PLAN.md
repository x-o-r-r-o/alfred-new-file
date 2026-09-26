# New File — Plan

**Priority tier:** 2 · **Bundle ID:** `io.github.x-o-r-r-o.new-file` · **Keywords:** `new`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Easy New File | 13,930 |
| **Total** | **13,930** |

**Alfred today:** Several 2013 'Create New File' workflows, all unmaintained.

## Features (v1.0)
- [x] `new <name.ext>` create in frontmost Finder window (or the configurable default folder) and open/rename
- [x] Templates folder (filepicker; seeded in `$alfred_workflow_data`): txt, md, README, html, css, js, json, py/sh (executable), csv, rtf, docx (textutil), .gitignore
- [ ] ~~xlsx/pages blanks~~: skipped (can't be generated without bundling binaries); users add their own via the Universal Action
- [x] Hotkey to show the templates
- [x] `new foo` offers every template type; `new folder <name>`; empty query lists templates
- [x] Never overwrites (" 2", " 3"…, exclusive writes); invalid names; dotfiles; read-only and non-filesystem Finder locations fall back
- [x] ↩ open, ⌘↩ reveal, ⌥↩ editor, ⌃↩ clipboard contents, ⌘Y Quick Look template
- [x] Universal Actions: New File Here (folder or file), Add as New File Template
- [x] `{{name}}`, `{{folder}}`, `{{date}}`… placeholders; recently used templates first; paths in the query

## Tech
- **Stack:** zsh + JXA (Finder insertion location).
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. [x] Script filter prototype for the main keyword
2. [x] Actions + modifiers, Universal Actions / File Actions where relevant
3. [x] Workflow Configuration, icons, error states (no network / missing dependency)
4. [ ] README with screenshots, `python3 tools/build.py --package` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] Any compiled binary is Developer ID signed + notarised; never strip quarantine (none shipped)
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README (done) and the forum post (pending)
- [ ] Version bumped in `workflow.json`; `python3 tools/build.py --package`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
