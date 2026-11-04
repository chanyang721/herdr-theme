import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import file_lock


class PortableHelpers(unittest.TestCase):
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
