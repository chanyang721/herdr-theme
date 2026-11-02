#!/usr/bin/env python3
"""Clearly labelled fixture for a public screenshot, not a real coding agent."""
import argparse
import signal
import sys

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('name');p.add_argument('state',choices=['working','blocked','done','idle']);a=p.parse_args()
sys.stdout.write('\033[2J\033[H'+f'\033]0;DEMO / {a.name}\007')
sys.stdout.write(f'\033]7501;state={a.state}:app=sixfold-demo\033\\')
color={'working':94,'blocked':93,'done':92,'idle':96}[a.state]
print(f'\033[1;{color}mDEMO / {a.name}\033[0m\n')
print('Example workspace · no real project data\n')
for line in {
 'working':['Inspecting the next change…','Running the focused checks','Keeping the workspace responsive'],
 'blocked':['A decision is ready for review.','Choose an option in this terminal.','Focus stays where you left it.'],
 'done':['Focused checks passed.','The change is ready to inspect.','Waiting for your review.'],
 'idle':['Session ready.','Settings remain attached to this terminal.','Waiting for a task.']
}[a.state]:print('  '+line)
print('\n\033[2mStatus fixture for the Sixfold preview\033[0m',flush=True)
signal.pause()
