import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from hc_trace import append_event, source_address


class TraceTests(unittest.TestCase):
    def test_record_has_routes_but_never_message_content(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'messages.json'
            append_event(path,'t1','t2',now=1234)
            data=json.loads(path.read_text())['events'][0]
            self.assertEqual((data['source'],data['target'],data['at']),('t1','t2',1234))
            self.assertNotIn('text',data)
            for n in range(40):append_event(path,'t2','t3',now=2000+n)
            self.assertEqual(len(json.loads(path.read_text())['events']),32)

    def test_native_caller_wins_over_a_legacy_pane(self):
        self.assertEqual(source_address({'HC_TERMINAL_ID':'t8','HERDR_PANE_ID':'old'}),'t8')

    def test_failed_send_does_not_generate_a_route(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            real=root/'core'
            real.write_text('#!/bin/sh\nexit 9\n')
            real.chmod(0o755)
            env={**os.environ,'SIXFOLD_REAL_HC':str(real),'HERDR_APP_HOME':folder,'HC_TERMINAL_ID':'t1'}
            result=subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/'scripts/hc_trace.py'),
                                   'send','t2','private body'],env=env,capture_output=True)
            self.assertEqual(result.returncode,9)
            self.assertFalse((root/'data/sixfold/messages.json').exists())

    def test_unknown_send_options_are_forwarded_without_parser_noise(self):
        with tempfile.TemporaryDirectory() as folder:
            real=Path(folder)/'core'
            real.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            real.chmod(0o755)
            result=subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/'scripts/hc_trace.py'),
                                   'send','--future-option','t2','body'],
                                  env={**os.environ,'SIXFOLD_REAL_HC':str(real)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0)
            self.assertEqual(result.stderr,'')
            self.assertEqual(result.stdout.splitlines(),['send','--future-option','t2','body'])


if __name__=='__main__':unittest.main()
