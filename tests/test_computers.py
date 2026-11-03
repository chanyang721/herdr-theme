import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import subprocess
import io
import json
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[1]/'scripts/collect_computers.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class ComputersTest(unittest.TestCase):
    def test_desktop_names_status_and_mobile_exclusion(self):
        peers = collector.computers({'BackendState':'Running', 'Peer':{
            'a':{'DNSName':'desktop-test.tail.example.', 'HostName':'DESKTOP-TEST', 'OS':'windows','Online':True},
            'b':{'HostName':'offline', 'OS':'linux','Online':False},
            'c':{'HostName':'phone', 'OS':'iOS','Online':True},
        }})
        self.assertEqual([(p['name'],p['online']) for p in peers], [('desktop-test',True),('offline',False)])
        with self.assertRaises(ValueError):
            collector.computers({'BackendState':'Stopped'})

    def test_only_local_status_is_executed_and_failure_is_explicit(self):
        with patch.object(collector.shutil,'which',return_value='/test/tailscale'), patch.object(collector.subprocess,'run') as run:
            run.side_effect=subprocess.TimeoutExpired('tailscale',8)
            output=io.StringIO()
            with redirect_stdout(output): collector.main()
            self.assertTrue(json.loads(output.getvalue())['error'])
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.args[0],['/test/tailscale','status','--json'])


if __name__ == '__main__':
    unittest.main()
