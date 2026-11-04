"""voice/install.py into a throwaway home, with a fake herdr: every entry point
moves from an earlier folder to the installed copy, nothing is started, and
the person's other settings survive."""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _isolate  # noqa: F401  (before any plugin module)
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest

VOICE = Path(__file__).resolve().parents[1]
FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, sys
db = os.environ["FAKE_HERDR_DB"]
state = json.load(open(db)) if os.path.exists(db) else {}
args = sys.argv[1:]
open(db + ".log", "a").write(" ".join(args) + "\n")
if args[:2] == ["plugin", "list"]:
    plugins = [{"plugin_id": "local.focus-queue", "manifest_path": state["root"] + "/herdr-plugin.toml",
                "enabled": state.get("enabled", True)}] if state.get("root") else []
    print(json.dumps({"result": {"plugins": plugins}}))
elif args[:2] == ["plugin", "link"]:
    state["root"], state["enabled"] = args[2], True
elif args[:2] == ["plugin", "unlink"]:
    state.pop("root", None)
elif args[:2] == ["plugin", "enable"]:
    state["enabled"] = True
json.dump(state, open(db, "w"))
'''


@unittest.skipUnless(sys.platform == "darwin", "macOS only")
class InstallTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="voice-home-")).resolve()
        bin_dir = self.home / "fakebin"
        bin_dir.mkdir()
        (bin_dir / "herdr").write_text(FAKE_HERDR)
        (bin_dir / "herdr").chmod(0o755)
        self.db = self.home / "herdr.json"
        old = self.home / "work/herdr-focus-queue"
        old.mkdir(parents=True)
        self.db.write_text(json.dumps({"root": str(old), "enabled": True}))
        claude = self.home / ".claude"
        claude.mkdir()
        (claude / "settings.json").write_text(json.dumps({
            "model": "kept",
            "hooks": {"UserPromptSubmit": [
                {"hooks": [{"type": "command", "command": f"/usr/bin/python3 {old}/voice_submit_hook.py"}]},
                {"hooks": [{"type": "command", "command": "echo other-hook"}]}]}}))
        sixfold = self.home / ".config/herdr-app/data/sixfold"
        sixfold.mkdir(parents=True)
        (sixfold / "voice-integration.json").write_text(json.dumps({"script": f"{old}/focus_queue.py"}))
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("HERDR_", "FAKE_"))}
        self.env.update(PATH=f"{bin_dir}:/usr/bin:/bin", FAKE_HERDR_DB=str(self.db))

    def run_install(self, *args):
        return subprocess.run([sys.executable, str(VOICE / "install.py"), "--home", str(self.home), *args],
                              env=self.env, capture_output=True, text=True)

    def test_everything_moves_to_the_installed_copy(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        target = self.home / ".local/share/herdr-focus-queue/plugin"
        self.assertTrue((target / "focus_queue.py").is_file())
        self.assertFalse(list(target.rglob("__pycache__")))
        self.assertEqual(json.loads(self.db.read_text())["root"], str(target))
        settings = json.loads((self.home / ".claude/settings.json").read_text())
        commands = [h["command"] for e in settings["hooks"]["UserPromptSubmit"] for h in e["hooks"]]
        self.assertEqual(commands, ["echo other-hook", f"/usr/bin/python3 {target}/voice_submit_hook.py"])
        self.assertEqual(settings["model"], "kept")
        self.assertTrue(settings["voice"]["enabled"])
        integration = self.home / ".config/herdr-app/data/sixfold/voice-integration.json"
        self.assertEqual(json.loads(integration.read_text())["script"], f"{target}/focus_queue.py")
        plist = self.home / "Library/LaunchAgents/co.lukuku.herdr-codex-focus.plist"
        self.assertIn(f"{target}/codex_focus.py", plistlib.loads(plist.read_bytes())["ProgramArguments"])
        self.assertIn("all voice entry points run", result.stdout)
        # Nothing of this home's own voice state is created by installing.
        self.assertFalse((self.home / ".config/herdr-app/data/sixfold/voice.local.json").exists())

    def test_a_second_run_changes_nothing(self):
        self.assertEqual(self.run_install().returncode, 0)
        before = (self.home / ".claude/settings.json").read_text()
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("already current", result.stdout)
        self.assertEqual((self.home / ".claude/settings.json").read_text(), before)
        self.assertNotIn("plugin link", (self.home / "herdr.json.log").read_text().split("plugin link", 1)[1])

    def test_check_fails_while_an_old_folder_is_linked(self):
        result = self.run_install("--check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not this copy", result.stdout)

    def test_an_update_swaps_the_copy_in_place(self):
        self.assertEqual(self.run_install().returncode, 0)
        target = self.home / ".local/share/herdr-focus-queue/plugin"
        (target / "focus_queue.py").write_text("# stale\n")
        inode = target.stat().st_ino
        result = self.run_install()
        self.assertIn("updated", result.stdout)
        self.assertNotEqual((target / "focus_queue.py").read_text(), "# stale\n")
        self.assertNotEqual(target.stat().st_ino, inode)
        self.assertEqual([p.name for p in target.parent.iterdir()], ["plugin"])


if __name__ == "__main__":
    unittest.main()
