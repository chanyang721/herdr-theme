import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import file_lock


class PortableHelpers(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows desktop integration')
    def test_browser_reuses_ego_profile_and_hides_console(self):
        import desktop
        with tempfile.TemporaryDirectory() as tmp:
            document = Path(tmp) / '한글 보고서.html'
            document.write_text('<p>document</p>', encoding='utf-8')
            original = Path.is_file
            with patch.object(Path, 'is_file', lambda p: p.name == 'ego.exe' or original(p)), patch.object(desktop.subprocess, 'Popen') as launch:
                desktop.launch('browser', document)
                argv = launch.call_args.args[0]
                self.assertEqual(Path(argv[0]).name, 'ego.exe')
                self.assertEqual(argv[1:], [str(document.resolve())])
                self.assertEqual(launch.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)

    def test_lock_contends_across_processes_and_keeps_owner_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'owner.json'
            path.write_text('{"owner":"test"}', encoding='utf-8')
            with path.open('a+') as lock:
                file_lock.flock(lock, file_lock.LOCK_EX | file_lock.LOCK_NB)
                self.assertEqual(path.read_text(encoding='utf-8'), '{"owner":"test"}')
                code = ('import sys;sys.path.insert(0,sys.argv[1]);import file_lock;'
                        'f=open(sys.argv[2],"a+");file_lock.flock(f,file_lock.LOCK_EX|file_lock.LOCK_NB)')
                child = subprocess.run([sys.executable, '-c', code, str(SCRIPTS), str(path)],
                    capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.assertNotEqual(child.returncode, 0)
                self.assertIn(b'BlockingIOError', child.stderr)
            with path.open('a+') as lock:
                file_lock.flock(lock, file_lock.LOCK_EX | file_lock.LOCK_NB)
                file_lock.flock(lock, file_lock.LOCK_UN)

    def test_document_and_message_helpers_import_on_windows(self):
        for name in ('route', 'collaborate', 'collect_docs', 'resolve_doc_pins', 'install_doc_tabs', 'open_doc_tab'):
            spec = importlib.util.spec_from_file_location('sixfold_' + name, SCRIPTS / (name + '.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
