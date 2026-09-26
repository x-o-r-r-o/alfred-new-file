#!/usr/bin/env python3
"""End-to-end tests: run the Script Filter and the actions the way Alfred does, in temp folders.

NF_TEST=1 makes the script print the action it would take (OPEN/REVEAL/EDITOR <path>) instead of
opening apps, and never talk to Finder unless a test asks for it. NF_TEST_FINDER fakes Finder.
"""
import json, os, plistlib, shutil, stat, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
TMP = tempfile.mkdtemp(prefix="newfile-test-")


def tmpdir(name="d"):
    return os.path.realpath(tempfile.mkdtemp(prefix=name + "-", dir=TMP))


class Env:
    """A fresh workflow data folder and target folder per test."""

    def __init__(self):
        self.data = tmpdir("data")
        self.target = tmpdir("target")
        self.templates = os.path.join(self.data, "Templates")

    def base(self, **extra):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("nf_", "NF_"))}
        e.update(NF_TEST="1", alfred_workflow_data=self.data, NF_TEST_FINDER=self.target)
        e.update({k: str(v) for k, v in extra.items()})
        return e

    def sf(self, query="", **extra):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./newfile.js", "filter", query], cwd=SRC,
                             env=self.base(**extra), capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        data = json.loads(out.stdout)
        validate(data)
        return data["items"]

    def run_item(self, item, mod=None, **extra):
        """Select an item (optionally with a modifier) and run the action with its variables."""
        src = item["mods"][mod] if mod else item
        assert src.get("valid", True) is not False, src
        variables = dict(src.get("variables") or item.get("variables") or {})
        return self.run(src["arg"], **variables, **extra)

    def run(self, arg="", **variables):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./newfile.js", "run", arg], cwd=SRC,
                             env=self.base(**variables), capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    def add(self, *paths, **extra):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./newfile.js", "add-template", "\t".join(paths)],
                             cwd=SRC, env=self.base(**extra), capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    def files(self, d=None):
        return sorted(os.listdir(d or self.target))


def validate(data):
    assert isinstance(data.get("items"), list)
    assert data["items"], "no items"
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        ic = it.get("icon")
        if ic:
            if ic.get("type") == "fileicon":
                assert os.path.exists(ic["path"]), ic
            else:
                assert os.path.exists(os.path.join(SRC, ic["path"])), ic
        if it.get("valid", True) is not False:
            assert "arg" in it, it
            assert it.get("variables", {}).get("nf_action"), it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m


def titles(items):
    return [i["title"] for i in items]


def find(items, title, subtitle=None):
    for i in items:
        if i["title"] == title and (subtitle is None or subtitle in i.get("subtitle", "")):
            return i
    raise AssertionError(f"no item {title!r} / {subtitle!r} in {titles(items)}")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, data, mode=None):
    with open(path, "wb" if isinstance(data, bytes) else "w") as f:
        f.write(data)
    if mode:
        os.chmod(path, mode)


class SeedTests(unittest.TestCase):
    def test_seeded_once_with_starters(self):
        e = Env()
        items = e.sf("")
        names = set(os.listdir(e.templates))
        for n in ["Plain text.txt", "Markdown.md", "README.md", "Web page.html", "Stylesheet.css", "JavaScript.js",
                  "JSON.json", "Python script.py", "Shell script.sh", "CSV.csv", "Rich text.rtf",
                  "Word document.docx", ".gitignore"]:
            self.assertIn(n, names)
        self.assertTrue(os.stat(os.path.join(e.templates, "Shell script.sh")).st_mode & stat.S_IXUSR)
        self.assertTrue(os.stat(os.path.join(e.templates, "Python script.py")).st_mode & stat.S_IXUSR)
        with open(os.path.join(e.templates, "Word document.docx"), "rb") as f:
            self.assertEqual(f.read(2), b"PK")
        self.assertTrue(read(os.path.join(e.templates, "Rich text.rtf")).startswith("{\\rtf1"))
        self.assertIn("<!DOCTYPE html>", read(os.path.join(e.templates, "Web page.html")))
        self.assertEqual(read(os.path.join(e.templates, "JSON.json")), "{}\n")
        # deleting a starter is respected: no re-seed while the folder exists
        os.remove(os.path.join(e.templates, "CSV.csv"))
        e.sf("")
        self.assertNotIn("CSV.csv", os.listdir(e.templates))
        # no scratch folders left behind
        self.assertEqual([n for n in os.listdir(e.data) if n.startswith(".seeding")], [])
        self.assertIn("Markdown", titles(items))

    def test_empty_query_lists_templates_folder_and_open(self):
        e = Env()
        items = e.sf("")
        self.assertEqual(items[0]["title"], "Plain text")
        md = find(items, "Markdown")
        self.assertEqual(md["arg"], os.path.join(e.target, "Untitled.md"))
        self.assertEqual(md["autocomplete"], "Untitled.md")
        self.assertEqual(find(items, "README")["arg"], os.path.join(e.target, "README.md"))
        self.assertEqual(find(items, "JSON")["arg"], os.path.join(e.target, "Untitled.json"))
        self.assertEqual(find(items, ".gitignore")["arg"], os.path.join(e.target, ".gitignore"))
        self.assertEqual(find(items, "Folder")["arg"], os.path.join(e.target, "untitled folder"))
        op = find(items, "Open Templates Folder")
        self.assertEqual(op["variables"]["nf_action"], "opentemplates")
        self.assertEqual(e.run(op["arg"], **op["variables"]), f"OPEN {e.templates}")
        self.assertEqual(e.files(), [])  # listing never creates anything

    def test_custom_templates_folder_is_not_seeded(self):
        e = Env()
        custom = tmpdir("custom")
        write(os.path.join(custom, "Note.md"), "# {{name}}\n")
        items = e.sf("", templates_folder=custom)
        self.assertEqual(titles(items)[0], "Note")
        self.assertFalse(os.path.exists(e.templates))
        self.assertEqual(os.listdir(custom), ["Note.md"])
        items = e.sf("", templates_folder=os.path.join(custom, "missing"))
        self.assertIn("Templates folder not found", " ".join(titles(items)))
        # still usable without templates
        self.assertEqual(e.sf("x.md", templates_folder=os.path.join(custom, "missing"))[0]["title"], "x.md")

    def test_empty_templates_folder(self):
        e = Env()
        custom = tmpdir("empty")
        items = e.sf("", templates_folder=custom)
        self.assertIn("No templates yet", titles(items))
        self.assertEqual(items[0]["title"], "Folder")


class CreateTests(unittest.TestCase):
    def test_create_from_matching_template_and_open(self):
        e = Env()
        items = e.sf("report.md")
        self.assertEqual(items[0]["title"], "report.md")
        self.assertIn("Markdown template", items[0]["subtitle"])
        self.assertEqual(find(items, "report.md", "Empty file")["variables"]["nf_template"], "")
        out = e.run_item(items[0])
        p = os.path.join(e.target, "report.md")
        self.assertEqual(out, f"OPEN {p}")
        self.assertEqual(read(p), "# report\n\n")

    def test_modifiers(self):
        e = Env()
        it = e.sf("a.txt")[0]
        self.assertEqual(e.run_item(it, "cmd"), f"REVEAL {os.path.join(e.target, 'a.txt')}")
        it = e.sf("b.txt")[0]
        self.assertEqual(e.run_item(it, "alt"), f"EDITOR {os.path.join(e.target, 'b.txt')}")
        self.assertIn("TextEdit", it["mods"]["alt"]["subtitle"])
        self.assertIn("BBEdit", e.sf("b.txt", editor_app="/Applications/BBEdit.app")[0]["mods"]["alt"]["subtitle"])
        it = e.sf("c.txt")[0]
        self.assertEqual(e.run_item(it, "ctrl", NF_TEST_CLIPBOARD="from clipboard"), f"OPEN {os.path.join(e.target, 'c.txt')}")
        self.assertEqual(read(os.path.join(e.target, "c.txt")), "from clipboard")
        self.assertEqual(e.files(), ["a.txt", "b.txt", "c.txt"])

    def test_no_extension_offers_every_type(self):
        e = Env()
        items = e.sf("notes")
        t = titles(items)
        for n in ["notes.txt", "notes.md", "notes.html", "notes.py", "notes.sh", "notes.docx", "notes", "New folder “notes”"]:
            self.assertIn(n, t)
        self.assertEqual(t[0], "notes.txt")
        self.assertEqual(t.count("notes.md"), 1)  # README (a named template) isn't offered as notes.md
        self.assertEqual(e.files(), [])

    def test_recently_used_template_comes_first(self):
        e = Env()
        e.run_item(e.sf("x.py")[0])
        self.assertEqual(e.sf("notes")[0]["title"], "notes.py")
        self.assertEqual(e.sf("")[0]["title"], "Python script")

    def test_partial_extension_suggestions(self):
        e = Env()
        items = e.sf("report.m")
        self.assertEqual(items[0]["title"], "report.m")
        self.assertIn("report.md", titles(items))

    def test_unknown_extension_creates_empty_file(self):
        e = Env()
        items = e.sf("data.xyz")
        self.assertEqual(titles(items), ["data.xyz"])
        e.run_item(items[0])
        self.assertEqual(os.path.getsize(os.path.join(e.target, "data.xyz")), 0)

    def test_extension_is_case_insensitive(self):
        e = Env()
        it = e.sf("README.MD")
        self.assertIn("README template", it[0]["subtitle"])
        it = e.sf("Notes.MD")
        self.assertIn("Markdown template", it[0]["subtitle"])

    def test_exact_name_template_first(self):
        e = Env()
        items = e.sf("readme.md")
        self.assertIn("README template", items[0]["subtitle"])
        e.run_item(items[0])
        self.assertEqual(read(os.path.join(e.target, "readme.md")).splitlines()[0], "# " + os.path.basename(e.target))

    def test_scripts_are_executable(self):
        e = Env()
        for n in ["run.sh", "tool.py"]:
            e.run_item(e.sf(n)[0])
            m = os.stat(os.path.join(e.target, n)).st_mode
            self.assertTrue(m & stat.S_IXUSR, n)
        self.assertTrue(read(os.path.join(e.target, "run.sh")).startswith("#!/bin/bash"))
        e.run_item(e.sf("plain.txt")[0])
        self.assertFalse(os.stat(os.path.join(e.target, "plain.txt")).st_mode & stat.S_IXUSR)

    def test_docx_and_rtf(self):
        e = Env()
        e.run_item(e.sf("letter.docx")[0])
        with open(os.path.join(e.target, "letter.docx"), "rb") as f:
            self.assertEqual(f.read(2), b"PK")
        it = e.sf("memo.docx")[0]
        e.run_item(it, "ctrl", NF_TEST_CLIPBOARD="Dear “you” 😀\nline 2")
        txt = subprocess.run(["textutil", "-convert", "txt", "-stdout", os.path.join(e.target, "memo.docx")],
                             capture_output=True, text=True).stdout
        self.assertIn("Dear “you” 😀", txt)
        self.assertIn("line 2", txt)
        e.run_item(e.sf("r.rtf")[0], "ctrl", NF_TEST_CLIPBOARD="rich")
        self.assertIn("rich", read(os.path.join(e.target, "r.rtf")))

    def test_placeholders(self):
        e = Env()
        write(os.path.join(tmpdir(), "x"), "")
        e.sf("")  # seed
        write(os.path.join(e.templates, "Note.txt"), "{{name}}|{{filename}}|{{folder}}|{{year}}|{{date}}|{{unknown}}|{{user}}")
        items = e.sf("my {{name}} note.txt")
        it = find(items, "my {{name}} note.txt", "Note template")
        e.run_item(it)
        text = read(os.path.join(e.target, "my {{name}} note.txt"))
        parts = text.split("|")
        self.assertEqual(parts[0], "my {{name}} note")  # values are not expanded again
        self.assertEqual(parts[1], "my {{name}} note.txt")
        self.assertEqual(parts[2], os.path.basename(e.target))
        self.assertRegex(parts[3], r"^\d{4}$")
        self.assertRegex(parts[4], r"^\d{4}-\d\d-\d\d$")
        self.assertEqual(parts[5], "{{unknown}}")
        self.assertTrue(parts[6])

    def test_binary_template_copied_byte_for_byte(self):
        e = Env()
        e.sf("")
        blob = bytes(range(256)) * 4 + b"{{name}}"
        write(os.path.join(e.templates, "Blob.bin"), blob)
        it = e.sf("x.bin")[0]
        self.assertFalse(it["mods"]["ctrl"]["valid"])
        e.run_item(it)
        with open(os.path.join(e.target, "x.bin"), "rb") as f:
            self.assertEqual(f.read(), blob)

    def test_package_template(self):
        e = Env()
        e.sf("")
        pkg = os.path.join(e.templates, "Blank.rtfd")
        os.mkdir(pkg)
        write(os.path.join(pkg, "TXT.rtf"), "{\\rtf1 hi}")
        it = e.sf("doc.rtfd")[0]
        self.assertIn("Blank template", it["subtitle"])
        e.run_item(it)
        self.assertEqual(read(os.path.join(e.target, "doc.rtfd", "TXT.rtf")), "{\\rtf1 hi}")
        e.run_item(e.sf("doc.rtfd")[0])
        self.assertIn("doc 2.rtfd", e.files())

    def test_folder(self):
        e = Env()
        items = e.sf("folder My Photos")
        self.assertEqual(titles(items), ["New folder “My Photos”"])
        self.assertEqual(e.run_item(items[0], "cmd"), f"REVEAL {os.path.join(e.target, 'My Photos')}")
        self.assertTrue(os.path.isdir(os.path.join(e.target, "My Photos")))
        e.run_item(e.sf("folder My Photos")[0])
        self.assertTrue(os.path.isdir(os.path.join(e.target, "My Photos 2")))
        items = e.sf("folder")
        self.assertEqual(items[0]["arg"], os.path.join(e.target, "untitled folder"))
        self.assertFalse(items[0]["mods"]["ctrl"]["valid"])
        # "folder.txt" is a file, not the folder command
        self.assertEqual(e.sf("folder.txt")[0]["title"], "folder.txt")
        # folder row in the no-extension list
        it = find(e.sf("stuff"), "New folder “stuff”")
        e.run_item(it)
        self.assertTrue(os.path.isdir(os.path.join(e.target, "stuff")))


class ClashTests(unittest.TestCase):
    def test_never_overwrites(self):
        e = Env()
        write(os.path.join(e.target, "a.md"), "keep me")
        it = e.sf("a.md")[0]
        self.assertIn("creates “a 2.md”", it["subtitle"])
        self.assertEqual(it["arg"], os.path.join(e.target, "a 2.md"))
        e.run_item(it)
        e.run_item(it)  # selecting a stale row twice still never overwrites
        self.assertEqual(read(os.path.join(e.target, "a.md")), "keep me")
        self.assertEqual(e.files(), ["a 2.md", "a 3.md", "a.md"])

    def test_numbering_continues(self):
        e = Env()
        write(os.path.join(e.target, "x 2.txt"), "")
        e.run_item(e.sf("x 2.txt")[0])
        self.assertIn("x 3.txt", e.files())
        write(os.path.join(e.target, ".env"), "")
        e.run_item(e.sf(".env")[0])
        self.assertIn(".env 2", e.files())
        write(os.path.join(e.target, "Makefile"), "")
        e.run_item(find(e.sf("Makefile"), "Makefile"))
        self.assertIn("Makefile 2", e.files())

    def test_case_insensitive_clash(self):
        e = Env()
        write(os.path.join(e.target, "Report.md"), "keep")
        e.run_item(e.sf("report.md")[0])
        self.assertEqual(read(os.path.join(e.target, "Report.md")), "keep")
        self.assertIn("report 2.md", e.files())

    def test_broken_symlink_is_not_replaced(self):
        e = Env()
        os.symlink(os.path.join(e.target, "nowhere"), os.path.join(e.target, "link.txt"))
        e.run_item(e.sf("link.txt")[0])
        self.assertTrue(os.path.islink(os.path.join(e.target, "link.txt")))
        self.assertIn("link 2.txt", e.files())

    def test_concurrent_creates_all_succeed(self):
        e = Env()
        it = e.sf("race.txt")[0]
        env = e.base(**it["variables"])
        procs = [subprocess.Popen(["osascript", "-l", "JavaScript", "./newfile.js", "run", it["arg"]], cwd=SRC, env=env,
                                  stdout=subprocess.PIPE, text=True) for _ in range(6)]
        outs = [p.communicate()[0].strip() for p in procs]
        self.assertTrue(all(o.startswith("OPEN ") for o in outs), outs)
        self.assertEqual(len(set(outs)), 6)
        self.assertEqual(len(e.files()), 6)


class NameTests(unittest.TestCase):
    def test_invalid_characters(self):
        e = Env()
        for q, fixed in [("a/b.txt", "a-b.txt"), ("a:b.txt", "a-b.txt"), ("folder x/y", "folder x-y")]:
            it = e.sf(q)
            self.assertEqual(len(it), 1, q)
            self.assertFalse(it[0]["valid"])
            self.assertIn("“/” or “:”", it[0]["title"])
            self.assertEqual(it[0]["autocomplete"], fixed)
        self.assertEqual(e.files(), [])

    def test_control_characters_and_dots(self):
        e = Env()
        it = e.sf("two\nlines.txt")[0]
        self.assertFalse(it["valid"])
        self.assertEqual(it["autocomplete"], "two lines.txt")
        self.assertFalse(e.sf("tab\there.txt")[0]["valid"])
        for q in [".", ".."]:
            self.assertFalse(e.sf(q)[0]["valid"], q)
        self.assertFalse(e.sf("x" * 300 + ".txt")[0]["valid"])
        self.assertFalse(e.sf("😀" * 70 + ".txt")[0]["valid"])  # 280 UTF-8 bytes

    def test_run_revalidates(self):
        e = Env()
        self.assertIn("“/”", e.run("x", nf_action="open", nf_dir=e.target, nf_name="../evil.txt", nf_kind="file"))
        self.assertIn("doesn’t exist", e.run("x", nf_action="open", nf_dir=os.path.join(e.target, "nope"), nf_name="a.txt", nf_kind="file"))
        self.assertEqual(e.files(), [])
        self.assertEqual(os.listdir(os.path.dirname(e.target)).count("evil.txt"), 0)

    def test_quotes_unicode_emoji_and_shell_metacharacters(self):
        e = Env()
        names = ['He said "hi" & $(touch pwned) `id` \'q\'.md', "Café résumé ünïcode.txt", "😀 emoji 🎉.json",
                 "-rf.txt", "--help.md", "\\back\\slash.txt", "semi;colon|pipe>.txt", "日本語のファイル.md"]
        for n in names:
            it = e.sf(n)[0]
            self.assertEqual(it["title"], n)
            self.assertEqual(e.run_item(it), f"OPEN {os.path.join(e.target, n)}")
            self.assertTrue(os.path.exists(os.path.join(e.target, n)), n)
        import unicodedata  # Cocoa writes decomposed (NFD) names; APFS matches either form
        self.assertEqual(sorted(unicodedata.normalize("NFC", f) for f in e.files()), sorted(names))
        self.assertFalse(os.path.exists(os.path.join(SRC, "pwned")))
        self.assertEqual(read(os.path.join(e.target, names[0])), "# " + names[0][:-3] + "\n\n")

    def test_decomposed_unicode_clash(self):
        import unicodedata
        e = Env()
        write(os.path.join(e.target, unicodedata.normalize("NFD", "café.txt")), "keep")
        e.run_item(e.sf(unicodedata.normalize("NFC", "café.txt"))[0])
        self.assertEqual(len(e.files()), 2)

    def test_whitespace_trimmed(self):
        e = Env()
        self.assertEqual(e.sf("   spaced.txt  ")[0]["title"], "spaced.txt")

    def test_dotfiles(self):
        e = Env()
        items = e.sf(".gitignore")
        self.assertIn(".gitignore template", items[0]["subtitle"])
        self.assertIn("Hidden file", items[0]["subtitle"])
        e.run_item(items[0])
        self.assertIn("node_modules/", read(os.path.join(e.target, ".gitignore")))
        items = e.sf(".env")
        self.assertEqual(titles(items), [".env"])
        self.assertIn("Empty file", items[0]["subtitle"])
        items = e.sf(".env.local")
        self.assertEqual(items[0]["title"], ".env.local")


class LocationTests(unittest.TestCase):
    def test_fallbacks(self):
        e = Env()
        fb = tmpdir("fallback")
        cases = {"none": "", "nonfs": "isn’t a folder", "denied": "Automation", "error": "didn’t answer"}
        for fake, note in cases.items():
            it = e.sf("x.txt", NF_TEST_FINDER=fake, default_folder=fb)[0]
            self.assertEqual(it["arg"], os.path.join(fb, "x.txt"), fake)
            self.assertIn(note, it["subtitle"])
        it = e.sf("x.txt", NF_TEST_FINDER=os.path.join(e.target, "gone"), default_folder=fb)[0]
        self.assertEqual(it["arg"], os.path.join(fb, "x.txt"))
        it = e.sf("x.txt", NF_TEST_FINDER=os.path.join(os.path.expanduser("~"), ".Trash"), default_folder=fb)[0]
        self.assertIn("Trash", it["subtitle"])

    def test_default_folder_tilde(self):
        e = Env()
        it = e.sf("x.txt", NF_TEST_FINDER="none", default_folder="")[0]
        self.assertEqual(it["arg"], os.path.join(os.path.expanduser("~"), "Desktop", "x.txt"))
        it = e.sf("x.txt", NF_TEST_FINDER="none", default_folder="~/Desktop")[0]
        self.assertEqual(it["arg"], os.path.join(os.path.expanduser("~"), "Desktop", "x.txt"))
        it = e.sf("x.txt", NF_TEST_FINDER="none", default_folder="/nonexistent-folder")[0]
        self.assertFalse(it["valid"])
        self.assertIn("Folder not found", it["title"])

    def test_location_modes(self):
        e = Env()
        fb = tmpdir("fallback")
        self.assertEqual(e.sf("x", location="default", default_folder=fb)[0]["arg"], os.path.join(fb, "x.txt"))
        it = e.sf("x", location="finder_active", default_folder=fb, NF_TEST_FRONTMOST="com.apple.Safari")[0]
        self.assertTrue(it["arg"].startswith(fb))
        it = e.sf("x", location="finder_active", default_folder=fb, NF_TEST_FRONTMOST="com.apple.finder")[0]
        self.assertTrue(it["arg"].startswith(e.target))

    def test_read_only_finder_folder_falls_back(self):
        e = Env()
        ro, fb = tmpdir("ro"), tmpdir("fallback")
        os.chmod(ro, 0o555)
        try:
            it = e.sf("x.txt", NF_TEST_FINDER=ro, default_folder=fb)[0]
            self.assertEqual(it["arg"], os.path.join(fb, "x.txt"))
            self.assertIn("read-only", it["subtitle"])
            # an explicitly chosen read-only folder is an error, not a silent fallback
            it = e.sf(ro + "/x.txt")[0]
            self.assertFalse(it["valid"])
            self.assertIn("Can’t create files", it["title"])
            # and the run step reports it if the folder became read-only after listing
            msg = e.run("x", nf_action="open", nf_dir=ro, nf_name="x.txt", nf_kind="file")
            self.assertIn("permission", msg)
            msg = e.run("x", nf_action="open", nf_dir=ro, nf_name="f", nf_kind="folder")
            self.assertIn("permission", msg)
        finally:
            os.chmod(ro, 0o755)
        self.assertEqual(os.listdir(ro), [])

    def test_real_finder_is_read_only(self):
        """Reads Finder's insertion location (read-only) and checks it resolves to a folder."""
        e = Env()
        env = e.base(NF_REAL_FINDER="1")
        env.pop("NF_TEST_FINDER")
        out = subprocess.run(["osascript", "-l", "JavaScript", "./newfile.js", "filter", "probe.txt"], cwd=SRC, env=env,
                             capture_output=True, text=True, timeout=30)
        it = json.loads(out.stdout)["items"][0]
        self.assertTrue(it["title"] == "probe.txt" or it["valid"] is False, it)
        if it.get("valid", True):
            self.assertTrue(os.path.isdir(os.path.dirname(it["arg"])))
            self.assertFalse(os.path.exists(it["arg"]) and os.path.basename(it["arg"]) == "probe.txt")


class PathTests(unittest.TestCase):
    def test_universal_action_folder_and_file(self):
        e = Env()
        dest = tmpdir("My Folder")
        items = e.sf(dest)  # Universal Action passes the folder path
        md = find(items, "Markdown")
        self.assertEqual(md["arg"], os.path.join(dest, "Untitled.md"))
        self.assertEqual(md["autocomplete"], dest + "/Untitled.md")
        write(os.path.join(dest, "some file.txt"), "")
        items = e.sf(os.path.join(dest, "some file.txt"))  # a file: its folder
        self.assertEqual(find(items, "Markdown")["arg"], os.path.join(dest, "Untitled.md"))

    def test_path_with_name(self):
        e = Env()
        dest = tmpdir("with space")
        for q in [dest + "/a b.md", dest + " a b.md", dest + "/ a b.md"]:
            it = e.sf(q)[0]
            self.assertEqual(it["arg"], os.path.join(dest, "a b.md"), q)
        e.run_item(e.sf(dest + "/a b.md")[0])
        self.assertTrue(os.path.exists(os.path.join(dest, "a b.md")))
        it = e.sf(dest + " folder Sub")[0]
        self.assertEqual(it["arg"], os.path.join(dest, "Sub"))
        self.assertEqual(it["variables"]["nf_kind"], "folder")
        it = e.sf(dest + "/new sub")  # a missing folder name becomes the new file's name
        self.assertIn(os.path.join(dest, "new sub.txt"), [i.get("arg") for i in it])

    def test_missing_path(self):
        e = Env()
        it = e.sf(e.target + "/missing/deeper/x.md")[0]
        self.assertFalse(it["valid"])
        self.assertIn("No such folder", it["title"])
        it = e.sf("/definitely-not-here-xyz/x.md")[0]
        self.assertFalse(it["valid"])

    def test_tilde(self):
        e = Env()
        items = e.sf("~/")
        self.assertTrue(find(items, "Markdown")["arg"].startswith(os.path.expanduser("~") + "/Untitled"))
        self.assertTrue(find(items, "Markdown")["autocomplete"].startswith("~/"))


class TemplateActionTests(unittest.TestCase):
    def test_add_templates(self):
        e = Env()
        src = tmpdir("src")
        a, b = os.path.join(src, 'Invoice "2026".numbers'), os.path.join(src, "Memo.md")
        write(a, b"PK\x03\x04binary")
        write(b, "# memo")
        out = e.add(a, b)
        self.assertIn("Added", out)
        self.assertTrue(os.path.exists(os.path.join(e.templates, 'Invoice "2026".numbers')))
        self.assertIn("Plain text.txt", os.listdir(e.templates))  # seeded first
        out = e.add(b)
        self.assertIn("Memo 2.md", out)
        self.assertEqual(read(os.path.join(e.templates, "Memo.md")), "# memo")
        self.assertIn('Invoice "2026" template', e.sf("q3.numbers")[0]["subtitle"])
        self.assertIn("is a folder", e.add(src))
        self.assertIn("not found", e.add(os.path.join(src, "nope.txt")))
        self.assertIn("already a template", e.add(os.path.join(e.templates, "Memo.md")))
        self.assertEqual(e.add(""), "Select a file first")

    def test_quicklook_is_template(self):
        e = Env()
        it = e.sf("x.md")[0]
        self.assertEqual(it["quicklookurl"], os.path.join(e.templates, "Markdown.md"))

    def test_junk_files_ignored(self):
        e = Env()
        e.sf("")
        write(os.path.join(e.templates, ".DS_Store"), b"\0\0")
        write(os.path.join(e.templates, "._Markdown.md"), b"\0\0")
        os.mkdir(os.path.join(e.templates, "Plain folder"))
        t = titles(e.sf(""))
        self.assertNotIn(".DS_Store", t)
        self.assertNotIn("._Markdown", t)
        self.assertNotIn("Plain folder", t)

    def test_deleted_template_between_list_and_run(self):
        e = Env()
        it = e.sf("gone.md")[0]
        os.remove(it["variables"]["nf_template"])
        e.run_item(it)
        self.assertEqual(os.path.getsize(os.path.join(e.target, "gone.md")), 0)


class Audit1Tests(unittest.TestCase):
    """Regressions for bugs found in the first audit."""

    def test_dotted_folder_names_are_numbered_whole(self):
        e = Env()
        os.mkdir(os.path.join(e.target, "v1.2"))
        it = e.sf("folder v1.2")[0]
        self.assertEqual(it["arg"], os.path.join(e.target, "v1.2 2"))
        e.run_item(it)
        self.assertTrue(os.path.isdir(os.path.join(e.target, "v1.2 2")))

    def test_only_real_extensions_count(self):
        e = Env()
        t = titles(e.sf("Version 1.0 notes"))
        self.assertIn("Version 1.0 notes.md", t)
        self.assertIn("New folder “Version 1.0 notes”", t)
        write(os.path.join(e.target, "Version 1.0 notes"), "")
        e.run_item(find(e.sf("Version 1.0 notes"), "Version 1.0 notes"))
        self.assertIn("Version 1.0 notes 2", e.files())
        self.assertIn("Markdown template", e.sf("résumé.md")[0]["subtitle"])

    def test_broken_symlink_template_is_skipped(self):
        e = Env()
        e.sf("")
        os.symlink(os.path.join(e.data, "gone.md"), os.path.join(e.templates, "Broken.md"))
        self.assertNotIn("Broken", titles(e.sf("")))
        self.assertNotIn("Broken template", " ".join(i.get("subtitle", "") for i in e.sf("x.md")))

    def test_markup_placeholders_are_escaped(self):
        e = Env()
        e.run_item(e.sf('a <b> & "c".html')[0])
        html = read(os.path.join(e.target, 'a <b> & "c".html'))
        self.assertIn("<title>a &lt;b&gt; &amp; &quot;c&quot;</title>", html)
        e.run_item(e.sf("x <y>.md")[0])
        self.assertEqual(read(os.path.join(e.target, "x <y>.md")), "# x <y>\n\n")

    def test_large_text_template_sniffed_quickly(self):
        e = Env()
        e.sf("")
        write(os.path.join(e.templates, "Big.log"), "line\n" * 400000)
        it = e.sf("x.log")[0]
        self.assertTrue(it["mods"]["ctrl"]["valid"])
        write(os.path.join(e.templates, "Late.bin"), b"a" * 9000 + b"\0")  # NUL after the sniffed prefix
        self.assertTrue(e.sf("x.bin")[0]["mods"]["ctrl"]["valid"])

    def test_path_mode_folder_autocomplete(self):
        e = Env()
        dest = tmpdir("dest")
        it = e.sf(dest + "/folder New")[0]
        self.assertEqual(it["autocomplete"], dest + "/folder New")
        self.assertEqual(e.sf(dest + "/folder New")[0]["variables"]["nf_kind"], "folder")
        it = e.sf(dest + "/folder a:b")[0]
        self.assertEqual(it["autocomplete"], dest + "/folder a-b")

    def test_add_symlink_copies_the_file(self):
        e = Env()
        src = tmpdir("src")
        real = os.path.join(src, "Real.md")
        write(real, "# real")
        link = os.path.join(src, "Link.md")
        os.symlink(real, link)
        e.add(link)
        added = os.path.join(e.templates, "Real.md")
        self.assertTrue(os.path.isfile(added) and not os.path.islink(added))

    def test_finder_query_has_a_timeout(self):
        with open(os.path.join(SRC, "newfile.js")) as f:
            js = f.read()
        self.assertIn("with timeout of 3 seconds", js)
        self.assertNotIn("Application(", js)  # no untimed Apple Events


class Audit2Tests(unittest.TestCase):
    """Regressions for bugs found in the second audit."""

    def test_blank_documents_without_template_are_valid(self):
        e = Env()
        custom = tmpdir("empty")  # no templates at all
        for n in ["a.docx", "b.rtf", "c.odt"]:
            it = e.sf(n, templates_folder=custom)[0]
            self.assertIn("Empty file", it["subtitle"])
            e.run_item(it)
            self.assertGreater(os.path.getsize(os.path.join(e.target, n)), 0, n)
        with open(os.path.join(e.target, "a.docx"), "rb") as f:
            self.assertEqual(f.read(2), b"PK")

    def test_clipboard_only_into_text_types(self):
        e = Env()
        custom = tmpdir("empty")
        self.assertFalse(e.sf("x.png", templates_folder=custom)[0]["mods"]["ctrl"]["valid"])
        self.assertFalse(e.sf("x.zip", templates_folder=custom)[0]["mods"]["ctrl"]["valid"])
        for n in ["x.yaml", "x.swift", "x.unknownext", "Makefile", "x.docx"]:
            self.assertTrue(e.sf(n, templates_folder=custom)[0]["mods"]["ctrl"]["valid"], n)

    def test_fifo_in_templates_is_ignored(self):
        e = Env()
        e.sf("")
        os.mkfifo(os.path.join(e.templates, "Pipe.txt"))
        items = e.sf("x.txt")  # would block forever if the FIFO were sniffed
        self.assertNotIn("Pipe template", " ".join(i.get("subtitle", "") for i in items))

    def test_write_itself_is_exclusive(self):
        e = Env()
        write(os.path.join(e.target, "keep.txt"), "original")
        os.mkdir(os.path.join(e.target, "dir"))
        out = e.run("x", nf_action="open", nf_dir=e.target, nf_name="keep.txt", nf_kind="file",
                    nf_template="", NF_TEST_NO_PRECHECK="1", NF_TEST_CLIPBOARD="new")
        self.assertEqual(out, f"OPEN {os.path.join(e.target, 'keep 2.txt')}")
        self.assertEqual(read(os.path.join(e.target, "keep.txt")), "original")
        out = e.run("x", nf_action="open", nf_dir=e.target, nf_name="dir", nf_kind="folder", NF_TEST_NO_PRECHECK="1")
        self.assertEqual(out, f"OPEN {os.path.join(e.target, 'dir 2')}")


class Audit3Tests(unittest.TestCase):
    """Regressions for bugs found in the third audit."""

    def test_finder_active_mode_runs_without_override(self):
        e = Env()
        fb = tmpdir("fallback")
        env = e.base(location="finder_active", default_folder=fb)
        env.pop("NF_TEST_FINDER")  # real frontmost/menu-bar app lookup; Finder itself stays faked off
        out = subprocess.run(["osascript", "-l", "JavaScript", "./newfile.js", "filter", "x.txt"], cwd=SRC, env=env,
                             capture_output=True, text=True, timeout=30)
        it = json.loads(out.stdout)["items"][0]
        self.assertEqual(it["title"], "x.txt")
        with open(os.path.join(SRC, "newfile.js")) as f:
            self.assertIn("menuBarOwningApplication", f.read())

    def test_system_files_are_not_added_as_templates(self):
        e = Env()
        src = tmpdir("src")
        write(os.path.join(src, ".DS_Store"), b"\0")
        self.assertIn("system file", e.add(os.path.join(src, ".DS_Store")))
        self.assertNotIn(".DS_Store", os.listdir(e.templates))

    def test_unreadable_templates_folder_is_reported(self):
        e = Env()
        custom = tmpdir("locked")
        write(os.path.join(custom, "A.txt"), "")
        os.chmod(custom, 0o000)
        try:
            items = e.sf("", templates_folder=custom)
            self.assertIn("Can’t read the templates folder", " ".join(titles(items)))
            self.assertNotIn("No templates yet", titles(items))
        finally:
            os.chmod(custom, 0o755)

    def test_corrupt_recent_list_is_ignored(self):
        e = Env()
        write(os.path.join(e.data, "recent.json"), "{not json")
        self.assertEqual(e.sf("notes")[0]["title"], "notes.txt")
        e.run_item(e.sf("x.py")[0])
        with open(os.path.join(e.data, "recent.json")) as f:
            self.assertEqual(json.load(f)[0], "Python script.py")


class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        uids = [o["uid"] for o in p["objects"]]
        self.assertEqual(len(uids), len(set(uids)))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
        for o in p["objects"]:
            kw = o["config"].get("keyword")
            if kw:
                self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
            script = o["config"].get("script", "")
            if script:
                self.assertIn('"$1"', script)  # data only through argv
                self.assertNotIn("{query}", script)
        self.assertTrue(p["readme"].startswith("## Usage"))
        self.assertEqual(p["bundleid"], "io.github.x-o-r-r-o.new-file")
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)
        mods = sorted(c["modifiers"] for c in p["connections"][[o["uid"] for o in p["objects"] if o["type"].endswith("scriptfilter")][0]])
        self.assertEqual(mods, [0, 262144, 524288, 1048576])


if __name__ == "__main__":
    try:
        unittest.main(verbosity=1)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
