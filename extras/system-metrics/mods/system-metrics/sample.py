#!/usr/bin/env python3
"""Read host metrics; does not inspect agent prompts or account credentials."""
import json, re, subprocess, sys

def command(*args):
    return subprocess.check_output(args, text=True, timeout=6)

def sample():
    if sys.platform != 'darwin':
        return {'error': 'System metrics currently supports macOS only'}
    cpu = re.findall(r'CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle', command('/usr/bin/top','-l','2','-s','1','-n','0'))
    if not cpu: raise ValueError('CPU sample unavailable')
    vm = command('/usr/bin/vm_stat')
    page = int(re.search(r'page size of (\d+) bytes', vm).group(1))
    values = {k: int(v) for k,v in re.findall(r'^([^:\n]+):\s+(\d+)\.',vm,re.M)}
    used = sum(values.get(k,0) for k in ('Pages active','Pages wired down','Pages occupied by compressor')) * page
    total = int(command('/usr/sbin/sysctl','-n','hw.memsize').strip())
    return {'cpu':round(100-float(cpu[-1][2]),1),'memory':used,'total':total,'memoryDefinition':'active + wired + compressed physical pages'}

if __name__ == '__main__':
    try: print(json.dumps(sample()))
    except Exception as error: print(json.dumps({'error':str(error)}))
