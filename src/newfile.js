#!/usr/bin/osascript -l JavaScript
// New File for Alfred — create files from templates in the frontmost Finder folder.
// Usage:
//   osascript -l JavaScript newfile.js filter <query>        Script Filter
//   osascript -l JavaScript newfile.js run <path>            create (reads nf_* variables)
//   osascript -l JavaScript newfile.js add-template <paths>  Universal Action (tab-separated or separate args)
// Data only ever arrives through argv and environment variables, never through code.
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("CoreServices");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

const FM = $.NSFileManager.defaultManager;
const WS = $.NSWorkspace.sharedWorkspace;
const HOME = $.NSHomeDirectory().js;
const UTF8 = $.NSUTF8StringEncoding;
const TEST = env("NF_TEST", "") === "1"; // test suite: never touch Finder or open apps

// Test suite safety net: never write outside the temporary folder, whatever the overrides say
function guard(p) {
  if (!TEST) return;
  const tmp = $($.NSTemporaryDirectory().js).stringByResolvingSymlinksInPath.js.replace(/\/+$/, "");
  const r = $(p).stringByResolvingSymlinksInPath.js;
  const ok = [tmp, "/private/tmp", "/tmp", "/private/var/folders", "/var/folders"].some((t) => r === t || r.startsWith(t + "/"));
  if (!ok) throw new Error(`test mode: refusing to write outside the temporary folder: ${p}`);
}

// Extensions textutil can produce from plain text (for the clipboard action and the seed).
const TEXTUTIL = ["rtf", "docx", "doc", "odt"];
const SCRIPT_EXTS = ["sh", "bash", "zsh", "fish", "py", "rb", "pl", "php", "js", "mjs", "command", "tool", "swift", "lua", "tcl"];
const PREFERRED = ["txt", "md", "html", "css", "js", "json", "py", "sh", "csv", "rtf", "docx"];
const JUNK = new Set([".DS_Store", ".localized", "Icon\r"]);

// ---------- paths and files ----------

function expand(p) {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return HOME + p.slice(1);
  return p;
}
function tilde(p) {
  if (p === HOME) return "~";
  return p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}
function basename(p) {
  const s = p.replace(/\/+$/, "");
  return s.slice(s.lastIndexOf("/") + 1) || "/";
}
function parent(p) {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
}
function join(dir, name) {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}
// Collapse "//", "." and ".." and drop trailing slashes, without resolving symlinks
// (NSString's stringByStandardizingPath would also turn /private/var into /var).
function standardize(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}
// Symlinks resolved (note: NSString also maps /private/var to /var, so only compare resolved paths)
function resolved(p) {
  return $(p).stringByResolvingSymlinksInPath.js;
}
function isDir(p) {
  const r = Ref();
  return FM.fileExistsAtPathIsDirectory(p, r) && !!r[0];
}
// lstat-style existence: also true for broken symlinks
function exists(p) {
  return !FM.attributesOfItemAtPathError(p, null).isNil();
}
// Regular file (following symlinks): not a FIFO, socket or device
function isRegular(p) {
  const a = FM.attributesOfItemAtPathError(resolved(p), null);
  return !a.isNil() && a.objectForKey("NSFileType").js === "NSFileTypeRegular";
}
function isPackage(p) {
  return !!WS.isFilePackageAtPath(p);
}
function writable(dir) {
  return isDir(dir) && !!FM.isWritableFileAtPath(dir);
}
function readData(p) {
  const d = $.NSData.dataWithContentsOfFile(p);
  return d.isNil() ? null : d;
}
function dataToText(d) {
  const s = $.NSString.alloc.initWithDataEncoding(d, UTF8);
  if (s.isNil()) return null;
  const t = s.js;
  return t.includes("\0") ? null : t;
}
function textToData(t) {
  return $(t).dataUsingEncoding(UTF8);
}
function perms(p) {
  const a = FM.attributesOfItemAtPathError(p, null);
  if (a.isNil()) return null;
  const n = a.objectForKey("NSFilePosixPermissions");
  return n.isNil() ? null : Number(n.js);
}
function setPerms(p, mode) {
  return FM.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: mode }), p, null);
}
function mkdirs(p) {
  return FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(p, true, $(), null);
}
function utf8Length(s) {
  return Number($(s).lengthOfBytesUsingEncoding(UTF8));
}

// Run a command; returns its stdout (NSData) or null on failure. Input is always a file path in argv.
function capture(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const outP = $.NSPipe.pipe;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = outP;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError(null)) return null;
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  return task.terminationStatus === 0 ? out : null;
}

function captureAll(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = outP;
  task.standardError = errP;
  if (!task.launchAndReturnError(null)) return null;
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const str = (d) => { const x = $.NSString.alloc.initWithDataEncoding(d, UTF8); return x.isNil() ? "" : x.js; };
  return { status: task.terminationStatus, out: str(out), err: str(err) };
}

function exec(path, args) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError(null)) return false;
  task.waitUntilExit;
  return task.terminationStatus === 0;
}

// Plain text -> rtf/docx/doc/odt bytes via textutil (ships with macOS)
function convertText(text, ext) {
  const tmp = $.NSTemporaryDirectory().js + `nf-${$.NSUUID.UUID.UUIDString.js}.txt`;
  if (!textToData(text).writeToFileAtomically(tmp, true)) return null;
  const out = capture("/usr/bin/textutil", ["-format", "txt", "-inputencoding", "UTF-8", "-convert", ext, "-stdout", "--", tmp]);
  FM.removeItemAtPathError(tmp, null);
  return out && Number(out.length) > 0 ? out : null;
}

// ---------- names ----------

// "report.md" -> md. Only a short run of letters, digits, "_", "+" or "-" counts as an
// extension, so "Version 1.0 notes" and "v1.2 final" have none.
function splitName(name) {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return { base: name, ext: "" };
  const ext = name.slice(i + 1);
  if (!/^[\p{L}\p{N}_+-]{1,16}$/u.test(ext)) return { base: name, ext: "" };
  return { base: name.slice(0, i), ext };
}

// Bidi overrides/isolates can disguise a name ("txt.exe" shown as "exe.txt"); C0/C1 controls break titles
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

// Display strings only (titles, subtitles): the real value stays in arg and variables
function clean(s) {
  return typeof s === "string" ? s.replace(BIDI, "").replace(/[\r\n\t]+/g, " ").replace(CONTROL, "") : s;
}

function nameError(name) {
  if (name === "") return "Type a name";
  if (/[\/:]/.test(name)) return "Names can’t contain “/” or “:”";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "Names can’t contain line breaks, tabs or control characters";
  if (/[\u202a-\u202e\u2066-\u2069]/.test(name)) return "Names can’t contain text-direction override characters";
  if (name === "." || name === "..") return "“.” and “..” aren’t valid names";
  if (utf8Length(name) > 250) return "That name is too long";
  return null;
}

function sanitize(name) {
  return name
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL, "")
    .replace(BIDI, "")
    .replace(/[\/:]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// "report.md" -> "report 2.md" -> "report 3.md"; "report 2.md" continues at 3, but a year or
// other long number is part of the name: "Budget 2026.md" -> "Budget 2026 2.md"
function numbered(name, n, folder) {
  const { base, ext } = folder ? { base: name, ext: "" } : splitName(name);
  const m = base.match(/^(.*\S) ([1-9]\d{0,2})$/);
  const stem = m ? m[1] : base;
  const start = m ? Number(m[2]) : 1;
  const b = `${stem} ${start + n}`;
  return ext ? `${b}.${ext}` : b;
}

function candidates(name, folder) {
  const out = [name];
  for (let n = 1; n < 1000; n++) out.push(numbered(name, n, folder));
  return out;
}

function uniqueName(dir, name, folder) {
  for (const c of candidates(name, folder)) if (!exists(join(dir, c))) return c;
  return null;
}

// ---------- configuration ----------

function dataDir() {
  const d = env("alfred_workflow_data", "");
  return d ? d.replace(/\/+$/, "") : null;
}

function templatesDir() {
  const custom = env("templates_folder", "").trim();
  if (custom) return { path: standardize(expand(custom)), custom: true };
  const d = dataDir();
  return d ? { path: `${d}/Templates`, custom: false } : null;
}

function defaultFolder() {
  const f = env("default_folder", "").trim();
  return standardize(expand(f || "~/Desktop"));
}

// ---------- templates ----------

const SEED = [
  ["Plain text.txt", ""],
  ["Markdown.md", "# {{name}}\n\n"],
  ["README.md", "# {{folder}}\n\nA short description of the project.\n\n## Usage\n\n## License\n"],
  [
    "Web page.html",
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>{{name}}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>{{name}}</h1>\n\n  <script src="script.js"></script>\n</body>\n</html>\n',
  ],
  ["Stylesheet.css", "*,\n*::before,\n*::after {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n  line-height: 1.5;\n}\n"],
  ["JavaScript.js", '"use strict";\n\n'],
  ["JSON.json", "{}\n"],
  ["Python script.py", '#!/usr/bin/env python3\n"""{{name}}"""\n\n\ndef main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n', 0o755],
  ["Shell script.sh", "#!/bin/bash\nset -euo pipefail\n\n", 0o755],
  ["CSV.csv", "Name,Value\n"],
  ["Rich text.rtf", null],
  ["Word document.docx", null],
  [".gitignore", ".DS_Store\n*.log\n.env\nnode_modules/\n__pycache__/\ndist/\nbuild/\n"],
];

// Seed the default templates folder once. Written to a scratch folder first and moved into
// place in one step, so an interrupted or concurrent run never leaves a half-seeded folder.
function seed(path) {
  if (exists(path)) return true;
  guard(path);
  const scratch = `${parent(path)}/.seeding-${$.NSUUID.UUID.UUIDString.js}`;
  if (!mkdirs(scratch)) return false;
  for (const [name, content, mode] of SEED) {
    const p = join(scratch, name);
    const data = content === null ? convertText("", splitName(name).ext) : textToData(content);
    if (!data) continue; // textutil unavailable: skip that starter
    data.writeToFileAtomically(p, false);
    if (mode) setPerms(p, mode);
  }
  const moved = FM.moveItemAtPathToPathError(scratch, path, null);
  if (!moved) FM.removeItemAtPathError(scratch, null);
  return exists(path);
}

// Case- and normalization-insensitive form for comparing names ("Café" typed vs NFD "Café" on disk)
function fold(s) {
  return s.normalize("NFC").toLowerCase();
}

function loadTemplates() {
  const t = templatesDir();
  if (!t) return { error: "Workflow data folder is not set", list: [] };
  if (!t.custom) seed(t.path);
  if (!isDir(t.path)) return { error: `Templates folder not found: ${tilde(t.path)}`, dir: t.path, list: [] };
  const names = FM.contentsOfDirectoryAtPathError(t.path, null);
  const list = [];
  if (names.isNil()) return { error: `Can’t read the templates folder ${tilde(t.path)}`, dir: t.path, list };
  {
    for (const n of names.js.map((x) => x.js)) {
      if (JUNK.has(n) || n.startsWith("._") || n.startsWith(".seeding-")) continue;
      const p = join(t.path, n);
      if (!FM.fileExistsAtPath(p)) continue; // broken symlink
      if (isDir(p) ? !isPackage(p) : !isRegular(p)) continue;
      const { base, ext } = splitName(n);
      list.push({ file: n, key: fold(n), path: p, label: base, ext: fold(ext), keepName: keepsName(n) });
    }
  }
  const recent = loadUsage();
  const rank = (t) => {
    const r = recent.indexOf(t.file);
    if (r >= 0) return r;
    const p = PREFERRED.indexOf(t.ext);
    return 1000 + (p >= 0 ? p : 100);
  };
  list.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return { dir: t.path, list };
}

// Templates named in capitals (README.md, LICENSE), dotfiles (.gitignore) and extensionless
// names (Makefile) keep their own name; others become "Untitled.<ext>".
function keepsName(file) {
  const { base, ext } = splitName(file);
  if (file.startsWith(".") || !ext) return true;
  // README.md, LICENSE.txt keep their name; JSON.json, CSV.csv are just type labels
  return /[A-Z]/.test(base) && base === base.toUpperCase() && !base.toLowerCase().startsWith(ext.toLowerCase());
}

function untitled(t) {
  return t.keepName ? t.file : `Untitled.${splitName(t.file).ext}`;
}

// Most recently used templates, most recent first
function usagePath() {
  const d = dataDir();
  return d ? `${d}/recent.json` : null;
}
function loadUsage() {
  const p = usagePath();
  if (!p) return [];
  const d = readData(p);
  if (!d) return [];
  try {
    const v = JSON.parse(dataToText(d) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (e) {
    return [];
  }
}
function recordUsage(file) {
  const p = usagePath();
  if (!p || !file) return;
  const list = [file, ...loadUsage().filter((f) => f !== file)].slice(0, 30);
  guard(p);
  mkdirs(parent(p));
  textToData(JSON.stringify(list)).writeToFileAtomically(p, true);
}

// ---------- placeholders ----------

function pad(n) {
  return String(n).padStart(2, "0");
}
const MARKUP = ["html", "htm", "xhtml", "xml", "svg", "plist", "xib", "storyboard"];
const JSONISH = ["json", "jsonc", "json5", "geojson", "webmanifest"];
function escapeMarkup(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// the inside of a JSON string, so "{{name}}" stays valid JSON for any name
function escapeJSON(s) {
  return JSON.stringify(s).slice(1, -1);
}
function fillPlaceholders(text, name, dir) {
  if (!text.includes("{{")) return text;
  const ext = splitName(name).ext.toLowerCase();
  const esc = MARKUP.includes(ext) ? escapeMarkup : JSONISH.includes(ext) ? escapeJSON : (x) => x;
  const now = new Date();
  const values = {
    name: splitName(name).base,
    filename: name,
    folder: basename(dir),
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    year: String(now.getFullYear()),
    user: $.NSFullUserName().js,
  };
  // one pass, so a value that itself contains "{{…}}" is never expanded again
  return text.replace(/\{\{(name|filename|folder|date|time|year|user)\}\}/g, (_, k) => esc(values[k]));
}

// ---------- target folder ----------

function finderLocation() {
  const fake = env("NF_TEST_FINDER", null); // test suite: "none", "nonfs", "denied", "error" or a path
  if (fake !== null) {
    if (fake === "none") return { none: true };
    if (fake === "nonfs") return { nonfs: true };
    if (fake === "denied") return { denied: true };
    if (fake === "error") return { error: true };
    return { path: fake };
  }
  const raw = env("NF_TEST_FINDER_RAW", null); // test suite: osascript's result as JSON {status, out, err}
  if (TEST && raw === null && env("NF_REAL_FINDER", "") !== "1") return { none: true };
  const r = raw !== null ? JSON.parse(raw) : captureAll("/usr/bin/osascript", ["-e", FINDER_SCRIPT]);
  if (!r) return { error: true };
  const out = r.out.replace(/\n$/, "");
  if (r.status !== 0) {
    if (/-1743/.test(r.err)) return { denied: true };
    if (/-1712/.test(r.err)) return { error: true }; // timed out
    if (/-600\b/.test(r.err)) return { none: true }; // Finder quit while asking
    return { nonfs: true };
  }
  if (out === "none:") return { none: true };
  if (out === "denied:") return { denied: true };
  if (out === "timeout:") return { error: true };
  if (out.startsWith("path:") && out.length > 5) return { path: out.slice(5) };
  return { nonfs: true };
}

// Fixed source, no data interpolated. Recents, AirDrop, search results and Network windows
// have no file URL, so they report "nonfs:".
const FINDER_SCRIPT = `with timeout of 3 seconds
  tell application id "com.apple.finder"
    if not running then return "none:"
    if (count of Finder windows) is 0 then return "none:"
    try
      set u to URL of (target of Finder window 1)
    on error number n
      if n is -1743 then return "denied:"
      if n is -1712 then return "timeout:"
      return "nonfs:"
    end try
    if u does not start with "file://" then return "nonfs:"
    try
      return "path:" & POSIX path of (insertion location as alias)
    on error number n
      if n is -1743 then return "denied:"
      if n is -1712 then return "timeout:"
      return "nonfs:"
    end try
  end tell
end timeout`;

function frontmostIsFinder() {
  const fake = env("NF_TEST_FRONTMOST", null);
  if (fake !== null) return fake === "com.apple.finder";
  // Alfred's window can make Alfred the frontmost app; the menu bar still belongs to the app
  // the user was in, so ask for that first.
  for (const app of [WS.menuBarOwningApplication, WS.frontmostApplication]) {
    if (app.isNil() || app.bundleIdentifier.isNil()) continue;
    const id = app.bundleIdentifier.js;
    if (id.startsWith("com.runningwithcrayons.Alfred")) continue;
    return id === "com.apple.finder";
  }
  return false;
}

// -> { dir, note } ; note explains a fallback
function resolveTarget() {
  const mode = env("location", "finder");
  const fallback = defaultFolder();
  const fb = (note) => ({ dir: fallback, note });
  if (mode === "default") return fb("");
  if (mode === "finder_active" && !frontmostIsFinder()) return fb("");
  const loc = finderLocation();
  if (loc.none) return fb("");
  if (loc.denied) return fb("Alfred may not control Finder: allow it in Privacy & Security › Automation");
  if (loc.error) return fb("Finder didn’t answer");
  if (loc.nonfs) return fb("the Finder window isn’t a folder");
  const p = standardize(loc.path);
  if (/(^|\/)\.Trash(es)?(\/|$)/.test(p)) return fb("Finder is showing the Trash"); // ~/.Trash, /Volumes/X/.Trashes/501
  if (!isDir(p)) return fb("the Finder folder no longer exists");
  if (!writable(p)) return fb(`“${basename(p)}” is read-only`);
  return { dir: p, note: "" };
}

// ---------- query parsing ----------

// A query starting with "/" or "~/" names the folder explicitly (the Universal Action passes a
// path). The longest existing folder prefix is the target; the rest (after "/" or a space) is the name.
function parsePath(q) {
  const full = expand(q);
  // a package (an .app, .rtfd or .key bundle) is a document to Finder: use the folder it's in
  if (isDir(full) && isPackage(full)) return { dir: parent(standardize(full)), name: "" };
  if (isDir(full)) return { dir: standardize(full), name: "" };
  if (exists(full) && !full.endsWith("/")) return { dir: parent(standardize(full)), name: "" };
  for (let i = full.length - 1; i >= 0; i--) {
    const c = full[i];
    if (c !== "/" && c !== " ") continue;
    const cand = full.slice(0, i) || "/";
    if (!isDir(cand)) continue;
    const rest = full.slice(i + 1).trim();
    if (rest.includes("/")) {
      const missing = rest.slice(0, rest.lastIndexOf("/"));
      return { error: `No such folder: ${tilde(join(standardize(cand), missing))}` };
    }
    return { dir: standardize(cand), name: rest };
  }
  return { error: `No such folder: ${q}` };
}

function parseQuery(query) {
  const q = query.replace(/^\s+|\s+$/g, "");
  let r;
  if (q === "~" || q.startsWith("/") || q.startsWith("~/")) {
    r = parsePath(q);
    if (r.error) return r;
    r.explicit = true;
  } else {
    r = Object.assign({ name: q }, resolveTarget());
  }
  const m = r.name.match(/^folder(?:\s+([\s\S]*))?$/i);
  if (m) {
    r.folder = true;
    r.name = (m[1] || "").trim();
  }
  return r;
}

// ---------- Script Filter ----------

function display(item) {
  item.title = clean(item.title);
  item.subtitle = clean(item.subtitle);
  for (const m of Object.values(item.mods || {})) m.subtitle = clean(m.subtitle);
  return item;
}

function icon(name) {
  return { path: `icons/${name}.png` };
}
function info(title, subtitle, ic = "info") {
  return { title, subtitle: subtitle || "", valid: false, icon: icon(ic) };
}

function where(ctx) {
  return `in ${tilde(ctx.dir)}` + (ctx.note ? ` (${ctx.note})` : "");
}

function canUseClipboard(name, template) {
  const ext = splitName(name).ext.toLowerCase();
  if (TEXTUTIL.includes(ext)) return true;
  if (!template) return isTextType(ext);
  if (isDir(template)) return false;
  return looksLikeText(template);
}

// Unknown extensions and anything conforming to public.text (source code, JSON, CSV…) take text;
// images, archives and other known binary types don't.
function isTextType(ext) {
  if (!ext) return true;
  try {
    const uti = $.UTTypeCreatePreferredIdentifierForTag($.kUTTagClassFilenameExtension, $(ext), $());
    const id = ObjC.castRefToObject(uti).js;
    return id.startsWith("dyn.") || !!$.UTTypeConformsTo(uti, $.kUTTypeText);
  } catch (e) {
    return true;
  }
}

// Text if the first 8 KB have no NUL byte (cheap enough to run for every row)
function looksLikeText(path) {
  const h = $.NSFileHandle.fileHandleForReadingAtPath(path);
  if (h.isNil()) return false;
  const d = h.readDataOfLength(8192);
  h.closeFile;
  const bytes = $.NSString.alloc.initWithDataEncoding(d, $.NSISOLatin1StringEncoding);
  return !bytes.isNil() && !bytes.js.includes("\0");
}

// One creatable row. Everything the run step needs travels in variables.
function createItem(ctx, o) {
  const name = o.name;
  const planned = uniqueName(ctx.dir, name, o.kind === "folder") || name;
  const path = join(ctx.dir, planned);
  const vars = { nf_dir: ctx.dir, nf_name: name, nf_kind: o.kind, nf_template: o.template ? o.template.path : "", nf_template_file: o.template ? o.template.file : "" };
  const v = (action) => Object.assign({}, vars, { nf_action: action });
  const ret = returnAction();
  const cmdAction = ret === "reveal" ? "open" : "reveal";
  const cmdText = cmdAction === "open" ? "Create and open it in the default app" : "Create and select it in Finder";
  const clash = planned !== name ? `“${name}” exists: creates “${planned}” · ` : "";
  const clip = o.kind === "file" && canUseClipboard(name, vars.nf_template);
  const item = {
    uid: undefined,
    title: o.title,
    subtitle: clash + (o.subtitle || where(ctx)),
    arg: path,
    autocomplete: (ctx.prefix || "") + (o.kind === "folder" ? `folder ${name}` : name),
    icon: o.icon,
    variables: v(ret),
    text: { copy: path, largetype: path },
    mods: {
      cmd: { arg: path, valid: true, subtitle: `${cmdText} · ${where(ctx)}`, variables: v(cmdAction) },
      alt: { arg: path, valid: true, subtitle: `Create and open in ${editorName()}`, variables: v("editor") },
      ctrl: clip
        ? { arg: path, valid: true, subtitle: "Create with the clipboard as its contents", variables: v("clipboard") }
        : { arg: path, valid: false, subtitle: o.kind === "folder" ? "Folders have no contents" : "Only text files can take the clipboard" },
      fn: { arg: path, valid: true, subtitle: "Create and copy its path", variables: v("copypath") },
    },
  };
  if (o.template) item.quicklookurl = o.template.path;
  else item.quicklookurl = ctx.dir;
  if (name.startsWith(".")) item.subtitle = `Hidden file (⌘⇧. shows it in Finder) · ${item.subtitle}`;
  delete item.uid;
  return item;
}

// What ↩ does (Workflow Configuration popup); ⌘↩ then does the other of open/reveal
function returnAction() {
  const a = env("return_action", "open").trim();
  return a === "reveal" || a === "editor" ? a : "open";
}

function editorName() {
  const e = env("editor_app", "").trim();
  return e ? basename(e).replace(/\.app$/i, "") : "TextEdit";
}

function templateIcon(t) {
  return { type: "fileicon", path: t.path };
}

function filterItems(query) {
  const ctx = parseQuery(query);
  if (ctx.error) return [info(ctx.error, "Check the path, or type just a name", "error")];
  if (ctx.explicit) ctx.prefix = ctx.dir === "/" ? "/" : `${tilde(ctx.dir)}/`;
  if (!isDir(ctx.dir)) return [info(`Folder not found: ${tilde(ctx.dir)}`, "Set the default folder in the Workflow’s Configuration", "error")];
  if (!writable(ctx.dir)) return [info(`Can’t create files in “${basename(ctx.dir)}”`, `${tilde(ctx.dir)} is read-only`, "error")];

  const tpl = loadTemplates();
  const items = [];
  const name = ctx.name;

  // ----- folders -----
  if (ctx.folder) {
    const n = name || "untitled folder";
    const err = nameError(n);
    if (err) return [invalidName(ctx, n, err, true)];
    items.push(createItem(ctx, { name: n, kind: "folder", title: `New folder “${n}”`, icon: icon("folder") }));
    return items;
  }

  // ----- empty query: list the templates -----
  if (name === "") {
    for (const t of tpl.list) {
      items.push(createItem(ctx, { name: untitled(t), kind: "file", template: t, title: t.label, subtitle: `${untitled(t)} ${where(ctx)} · or type a name`, icon: templateIcon(t) }));
      items[items.length - 1].autocomplete = (ctx.prefix || "") + untitled(t);
    }
    items.push(createItem(ctx, { name: "untitled folder", kind: "folder", title: "Folder", subtitle: `untitled folder ${where(ctx)} · or type “folder <name>”`, icon: icon("folder") }));
    items[items.length - 1].autocomplete = (ctx.prefix || "") + "folder ";
    if (tpl.error) items.push(info(tpl.error, "Set the templates folder in the Workflow’s Configuration", "error"));
    else if (!tpl.list.length) items.push(info("No templates yet", "Add files to the templates folder, or use the “Add as New File Template” Universal Action"));
    if (tpl.dir) items.push(openTemplatesItem(tpl.dir));
    return items;
  }

  const err = nameError(name);
  if (err) return [invalidName(ctx, name, err, false)];

  const { ext } = splitName(name);
  const lext = fold(ext);
  const exact = tpl.list.filter((t) => t.key === fold(name));
  const fileRow = (n, t, extra) =>
    createItem(ctx, { name: n, kind: "file", template: t, title: n, subtitle: extra ? `${extra} · ${where(ctx)}` : undefined, icon: t ? templateIcon(t) : icon("file") });

  if (ext) {
    // report.md: exact-name templates, then every template with that extension, then an empty file
    const same = tpl.list.filter((t) => t.ext === lext && !exact.includes(t));
    for (const t of [...exact, ...same]) items.push(fileRow(name, t, `${t.label} template`));
    items.push(fileRow(name, null, "Empty file"));
    // still typing the extension ("report.m"): suggest templates whose extension starts with it
    if (!same.length && !exact.length) {
      for (const t of tpl.list.filter((t) => t.ext && t.ext !== lext && t.ext.startsWith(lext))) {
        const n = `${splitName(name).base}.${t.ext}`;
        items.push(fileRow(n, t, `${t.label} template`));
      }
    }
  } else if (name.startsWith(".")) {
    // dotfile: exact template (e.g. .gitignore) or an empty file
    for (const t of exact) items.push(fileRow(name, t, `${t.label} template`));
    items.push(fileRow(name, null, "Empty file"));
  } else {
    // no extension: one row per template type ("notes." becomes "notes.md", not "notes..md")
    const stem = name.replace(/\.+$/, "") || name;
    for (const t of exact) items.push(fileRow(name, t, `${t.label} template`));
    for (const t of tpl.list.filter((t) => t.ext && !t.keepName && !exact.includes(t))) items.push(fileRow(`${stem}.${t.ext}`, t, `${t.label} template`));
    items.push(fileRow(name, null, "Empty file without an extension"));
    items.push(createItem(ctx, { name, kind: "folder", title: `New folder “${name}”`, icon: icon("folder") }));
  }
  if (tpl.error) items.push(info(tpl.error, "Set the templates folder in the Workflow’s Configuration", "error"));
  return items;
}

function invalidName(ctx, name, err, folder) {
  const fixed = sanitize(name);
  const ok = fixed && !nameError(fixed);
  return {
    title: err,
    subtitle: ok ? `Press ⇥ to use “${fixed}”` : "Type another name",
    valid: false,
    autocomplete: ok ? (ctx.prefix || "") + (folder ? "folder " : "") + fixed : undefined,
    icon: icon("error"),
  };
}

function openTemplatesItem(dir) {
  return {
    title: "Open Templates Folder",
    subtitle: `${tilde(dir)} · add or edit files to change the templates`,
    arg: dir,
    icon: icon("templates"),
    variables: { nf_action: "opentemplates", nf_dir: dir },
    mods: {
      cmd: { arg: dir, valid: true, subtitle: "Open the templates folder", variables: { nf_action: "opentemplates", nf_dir: dir } },
      alt: { arg: dir, valid: false, subtitle: "Open the templates folder with ↩" },
      ctrl: { arg: dir, valid: false, subtitle: "Open the templates folder with ↩" },
      fn: { arg: dir, valid: false, subtitle: "Open the templates folder with ↩" },
    },
  };
}

// ---------- run: create the file ----------

function clipboardText() {
  const fake = env("NF_TEST_CLIPBOARD", null);
  if (fake !== null) return fake;
  const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
  return s.isNil() ? null : s.js;
}

// Contents for a new file (NSData), or { error }
function contentsFor(name, dir, templatePath, action, given) {
  const ext = splitName(name).ext.toLowerCase();
  if (action === "text") return { data: textToData(given) };
  if (action === "clipboard") {
    const text = clipboardText();
    if (text === null) return { error: "The clipboard has no text" };
    if (TEXTUTIL.includes(ext)) {
      const d = convertText(text, ext);
      return d ? { data: d } : { error: `textutil couldn’t create a .${ext} file` };
    }
    return { data: textToData(text) };
  }
  if (!templatePath) {
    if (!TEXTUTIL.includes(ext)) return { data: textToData("") };
    const d = convertText("", ext); // a 0-byte .docx wouldn't open
    return d ? { data: d } : { error: `textutil couldn’t create a .${ext} file` };
  }
  const d = readData(templatePath);
  if (!d) return { error: `Can’t read the template “${basename(templatePath)}”` };
  const text = dataToText(d);
  if (text !== null && text.includes("{{")) return { data: textToData(fillPlaceholders(text, name, dir)) };
  return { data: d };
}

// Create without ever overwriting: every write is exclusive, and on a clash the next
// numbered name is tried, so two runs racing for the same name both succeed.
function createFile(dir, name, templatePath, action, given) {
  guard(dir);
  const isPkg = templatePath && isDir(templatePath);
  let content = null;
  if (!isPkg) {
    content = contentsFor(name, dir, templatePath, action, given);
    if (content.error) return content;
  }
  const precheck = env("NF_TEST_NO_PRECHECK", "") !== "1"; // tests prove the write itself is exclusive
  for (const n of candidates(name)) {
    const p = join(dir, n);
    if (precheck && exists(p)) continue;
    let ok;
    if (isPkg) ok = FM.copyItemAtPathToPathError(templatePath, p, null);
    else ok = content.data.writeToFileOptionsError(p, 2 /* NSDataWritingWithoutOverwriting */, null);
    if (ok) {
      if (isPkg) FM.setAttributesOfItemAtPathError($({ NSFileModificationDate: $.NSDate.date, NSFileCreationDate: $.NSDate.date }), p, null);
      else fixPermissions(p, n, templatePath, content.data);
      return { path: p };
    }
    if (exists(p)) continue; // lost a race for this name: try the next one
    return { error: createError(dir, n) };
  }
  return { error: `Too many files named like “${name}”` };
}

function fixPermissions(p, name, templatePath, data) {
  const mode = perms(p);
  if (mode === null) return;
  let want = mode;
  const tm = templatePath ? perms(templatePath) : null;
  if (tm !== null && tm & 0o111) want |= (tm & 0o111) & ((mode & 0o444) >> 2);
  const ext = splitName(name).ext.toLowerCase();
  if (SCRIPT_EXTS.includes(ext) || ext === "") {
    const head = Number(data.length) >= 2 ? dataToText(data.subdataWithRange($.NSMakeRange(0, 2))) : null;
    if (head === "#!") want |= (mode & 0o444) >> 2;
  }
  if (want !== mode) setPerms(p, want);
}

function createError(dir, name) {
  if (!isDir(dir)) return `The folder ${tilde(dir)} no longer exists`;
  if (!writable(dir)) return `You don’t have permission to create files in “${basename(dir)}”`;
  if (utf8Length(name) > 255) return `The name “${name}” is too long`;
  return `Couldn’t create “${name}” in ${tilde(dir)}`;
}

function createFolder(dir, name) {
  guard(dir);
  const precheck = env("NF_TEST_NO_PRECHECK", "") !== "1";
  for (const n of candidates(name, true)) {
    const p = join(dir, n);
    if (precheck && exists(p)) continue;
    if (FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(p, false, $(), null)) return { path: p };
    if (exists(p)) continue;
    return { error: createError(dir, n) };
  }
  return { error: `Too many folders named like “${name}”` };
}

// In the test suite, actions are printed instead of performed.
function perform(action, path) {
  if (TEST) return env("NF_TEST_SILENT", "") === "1" ? "" : `${action.toUpperCase()} ${path}`; // SILENT: as a real success
  if (action === "copypath") {
    const pb = $.NSPasteboard.generalPasteboard;
    pb.clearContents;
    pb.setStringForType($(path), $.NSPasteboardTypeString);
    return "";
  }
  const url = $.NSURL.fileURLWithPath(path);
  if (action === "reveal") {
    WS.activateFileViewerSelectingURLs($([url]));
    return "";
  }
  if (action === "editor") {
    const app = env("editor_app", "").trim() || "TextEdit";
    if (exec("/usr/bin/open", ["-a", expand(app), "--", path])) return "";
    WS.activateFileViewerSelectingURLs($([url]));
    return `Couldn’t open it in “${app}”: check the editor in the Workflow’s Configuration`;
  }
  // open in the default app; with no app for the type (e.g. no extension), select it in Finder
  if (!isDir(path) && WS.URLForApplicationToOpenURL(url).isNil()) {
    WS.activateFileViewerSelectingURLs($([url]));
    return "";
  }
  if (!WS.openURL(url)) WS.activateFileViewerSelectingURLs($([url]));
  return "";
}

function runAction() {
  const action = env("nf_action", "open");
  const dir = env("nf_dir", "");
  if (action === "opentemplates") {
    if (!dir) return "No templates folder";
    const t = templatesDir();
    if (t && !t.custom && standardize(dir) === t.path) seed(t.path);
    else if (!isDir(dir)) { guard(dir); mkdirs(dir); }
    return perform("open", dir);
  }
  const name = env("nf_name", "");
  const kind = env("nf_kind", "file");
  const template = env("nf_template", "");
  if (!dir || !isDir(dir)) return `The folder ${tilde(dir) || "(none)"} doesn’t exist`;
  const err = nameError(name);
  if (err) return err;
  const r = kind === "folder" ? createFolder(dir, name) : createFile(dir, name, template && exists(template) ? template : "", action);
  if (r.error) return r.error;
  if (template) recordUsage(env("nf_template_file", "") || basename(template));
  return perform(action === "clipboard" ? "open" : action, r.path);
}

// ---------- Universal Action: add files as templates ----------

function addTemplates(arg) {
  const t = templatesDir();
  if (!t) return "Workflow data folder is not set";
  guard(t.path);
  if (!t.custom) seed(t.path);
  if (!mkdirs(t.path) && !isDir(t.path)) return `Can’t create ${tilde(t.path)}`;
  const paths = arg.split("\t").map((s) => s.replace(/\n+$/, "")).filter(Boolean);
  if (!paths.length) return "Select a file first";
  const added = [], problems = [];
  for (const p of paths) {
    const src = resolved(standardize(expand(p)));
    if (!FM.fileExistsAtPath(src)) { problems.push(`${basename(src)} not found`); continue; } // also a broken symlink
    if (JUNK.has(basename(src)) || basename(src).startsWith("._")) { problems.push(`${basename(src)} is a system file`); continue; }
    if (isDir(src) && !isPackage(src)) { problems.push(`${basename(src)} is a folder`); continue; }
    if (resolved(parent(src)) === resolved(t.path)) { problems.push(`${basename(src)} is already a template`); continue; }
    const same = join(t.path, basename(src));
    if (!isDir(src) && isRegular(same) && FM.contentsEqualAtPathAndPath(src, same)) { problems.push(`${basename(src)} is already a template`); continue; }
    let done = null;
    for (const n of candidates(basename(src))) {
      const dest = join(t.path, n);
      if (exists(dest)) continue;
      if (FM.copyItemAtPathToPathError(src, dest, null)) { done = n; break; }
      if (!exists(dest)) break;
    }
    if (done) added.push(done);
    else problems.push(`couldn’t copy ${basename(src)}`);
  }
  const msg = [];
  if (added.length) msg.push(`Added ${added.map((n) => `“${n}”`).join(", ")} as ${added.length === 1 ? "a template" : "templates"}`);
  if (problems.length) msg.push(problems.join("; "));
  return msg.join(". ");
}

// ---------- Universal Action: save selected text as a new file ----------

// Creates "Untitled.txt" with the text in the usual target folder and selects it in Finder,
// ready to rename.
function fromText(text) {
  if (!text || !text.trim()) return "Select some text first";
  const ctx = resolveTarget();
  if (!isDir(ctx.dir)) return `Folder not found: ${tilde(ctx.dir)}`;
  if (!writable(ctx.dir)) return `Can’t create files in “${basename(ctx.dir)}”: it’s read-only`;
  const r = createFile(ctx.dir, "Untitled.txt", "", "text", text);
  if (r.error) return r.error;
  return perform("reveal", r.path);
}

// ---------- entry ----------

// osascript prints a lone newline for "", which Alfred may treat as a populated notification
// argument; returning undefined prints nothing at all.
function quiet(s) {
  return s ? s : undefined;
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    switch (cmd) {
      case "filter":
        return JSON.stringify({ skipknowledge: true, items: filterItems(query).map(display) });
      case "run":
        return quiet(runAction());
      case "add-template":
        // several files arrive either as one tab-separated argument or as separate arguments
        return quiet(addTemplates(rest.join("\t")));
      case "from-text":
        // Universal Action on text: arrives as one argument (joined back if Alfred ever splits it)
        return quiet(fromText(rest.join(" ")));
      default:
        return JSON.stringify({ items: [info(`Unknown command: ${cmd}`, "", "error")] });
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    return cmd === "filter" ? JSON.stringify({ items: [info("New File error", msg, "error")] }) : `New File error: ${msg}`;
  }
}
