import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('workflow_collector',Path(__file__).parents[1]/'scripts/collect_workflow.py')
collector=importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class WorkflowCollectorTests(unittest.TestCase):
    def test_history_is_baseline_and_only_a_new_child_generates_a_delegation(self):
        old={'id':'old','parent':'t5','terminal':'t5','status':'finished'}
        new={'id':'new','parent':'old','terminal':'t5','status':'recent'}
        events=[]
        with patch.object(collector,'collect',return_value=[old]),patch.object(collector,'publish'):
            seen=collector.step({},None,events)
        self.assertEqual(events,[])
        with patch.object(collector,'collect',return_value=[old,new]),patch.object(collector,'publish'):
            seen=collector.step({},seen,events)
        self.assertEqual([(e['source'],e['target'],e['kind']) for e in events],[('old','new','delegate')])
        new['status']='finished'
        with patch.object(collector,'collect',return_value=[old,new]),patch.object(collector,'publish'):
            collector.step({},seen,events)
        self.assertEqual(len(events),1,'status changes must not invent return messages')
        with patch.object(collector,'collect',return_value=[old,new]),patch.object(collector,'publish'):
            collector.step({},None,[])
