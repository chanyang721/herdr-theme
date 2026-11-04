"""Recover only a confirmed, unexpected Codex voice loss in the focused pane.

Never infer a disconnect from a missing footer alone, toggle a live call, or
restart the coding agent. Reads only bounded helper-failure metadata from logs.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

import focus_queue as queue

INTERVAL = 3
SETTLE_SECONDS = 3
COOLDOWN = 60
WINDOW = 900
MAX_ATTEMPTS = 3
STATE_FILE = Path(queue.STATE_DIR) / 'voice-recovery.json'
PID_FILE = Path(queue.STATE_DIR) / 'voice-recovery.pid'


def live(text):
    status = queue.footer(text, '›')
    return '/voice stop' in status or 'voice ● listening' in status or 'voice ◌ muted' in status


def manual_stop(text):
    text = queue.plain(text)
    stop = text.rfind('Voice conversation ended: requested')
    failed = max(text.rfind('Voice conversation failed:'), text.rfind('voice audio session stopped unexpectedly'),
                 text.rfind('Voice conversation ended: transport_closed'))
    return stop >= 0 and stop > failed


def eligible(record, text, focused, now, device_ready=False):
    if not focused or not record.get('seen') or not record.get('failure') or live(text) or manual_stop(text):
        return False
    failure = record['failure']
    if failure.get('kind') == 'device' and not device_ready:
        return False
    if failure['id'] == record.get('attempted') or failure['ts'] > now + 1:
        return False
    if now - record.get('absent_since', now) < SETTLE_SECONDS:
        return False
    attempts = [at for at in record.get('attempts', []) if now-at < WINDOW]
    if len(attempts) >= MAX_ATTEMPTS or (attempts and now-attempts[-1] < COOLDOWN):
        return False
    plain = queue.plain(text)
    error = max(plain.rfind('Voice conversation failed:'), plain.rfind('voice audio session stopped unexpectedly'),
                plain.rfind('Voice conversation ended: transport_closed'))
    if error < 0 and record.get('failure_ui') != failure['id'] and not failure.get('confirmed'):
        return False
    if plain.rfind('Voice conversation started.') > error:
        return False
    if 'for shortcuts' not in plain or not any(line.lstrip().startswith('›') for line in plain.splitlines()):
        return False
    return not queue.composer(text, '›')


def failures(connection, cursor):
    end = connection.execute('select coalesce(max(id),0) from logs').fetchone()[0]
    rows = connection.execute('''select id,ts,process_uuid,feedback_log_body from logs
        where id>? and id<=? and target='codex_realtime_webrtc::client'
        and feedback_log_body in (
          'voice helper output closed phase=Some(InspectAudio) exit_code=Some(28)',
          'voice helper output closed phase=Some(Device) exit_code=Some(37)')
        order by id''', (cursor, end)).fetchall()
    events=[]
    for row in rows:
        if not re.fullmatch(r'pid:\d+:[0-9a-f-]+', row[2] or ''):
            continue
        event={'id':row[0], 'ts':row[1], 'pid':row[2].split(':')[1]}
        if 'Some(Device)' in row[3]:
            event['kind']='device'
        events.append(event)
    return end, events


def confirmed_closure(connection, event):
    # The session actor's independent closed result corroborates the helper loss,
    # even after the UI caption has scrolled away. A missing footer alone is never evidence.
    row=connection.execute('''select 1 from logs where id>? and id<=? and ts between ? and ?
        and process_uuid glob ? and target='codex_realtime_webrtc::session'
        and feedback_log_body=? limit 1''',
        (event['id'],event['id']+10000,event['ts'],event['ts']+2,'pid:'+event['pid']+':*',
         'voice session operation failed stage=AudioSession kind="closed"')).fetchone()
    return row is not None


def failure_marker(text):
    plain=queue.plain(text)
    error=max(plain.rfind('Voice conversation failed:'),plain.rfind('voice audio session stopped unexpectedly'),
              plain.rfind('Voice conversation ended: transport_closed'))
    stopped=plain.rfind('Voice conversation ended: requested')
    started=plain.rfind('Voice conversation started.')
    if max(stopped,started)>error:
        return False
    return True if error>=0 else None


def recent_failure(pane_id):
    # Read bounded terminal history without moving the viewport. Store only a
    # matching event id, never the history text or a transcript.
    command=([queue.CORE,'read',pane_id[4:],'--lines','200'] if pane_id.startswith('app:') else
             [queue.HERDR,'pane','read',pane_id,'--source','recent','--lines','200','--ansi'])
    try:
        result=subprocess.run(command,capture_output=True,text=True,timeout=5)
        return failure_marker(result.stdout) if result.returncode==0 else None
    except (OSError,subprocess.SubprocessError):
        return None


def audio_selection():
    """Read ordinary audio device names. Unsupported configuration fails closed."""
    try:
        text=(Path.home()/'.codex/config.toml').read_text()
    except OSError:
        return None
    match=re.search(r'(?ms)^[ \t]*\[[ \t]*audio[ \t]*\][ \t]*(?:#[^\n]*)?\n(.*?)(?=^[ \t]*\[|\Z)',text)
    if not match:
        return {} if not re.search(r'^[ \t]*(?:audio[ \t]*=|\[[ \t]*audio[ \t]*\])',text,re.M) else None
    result={}
    for line in match[1].splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        item=re.fullmatch(r"\s*(microphone|speaker)\s*=\s*(\"(?:[^\"\\]|\\.)*\"|'[^']*')\s*(?:#.*)?",line)
        if item:
            value=item[2]
            try:result[item[1]]=json.loads(value) if value.startswith('"') else value[1:-1]
            except ValueError:return None
        elif not re.fullmatch(r'\s*channel\s*=\s*\d+\s*(?:#.*)?',line):
            return None
    return result


def device_signature(payload, selection):
    if selection is None:
        return None
    devices=[item for section in payload.get('SPAudioDataType',[]) for item in section.get('_items',[])]
    chosen=[]
    for kind,key in [('input','microphone'),('output','speaker')]:
        name=selection.get(key)
        device=next((d for d in devices if (d.get('_name')==name if name else
                    d.get('coreaudio_default_audio_'+kind+'_device')=='spaudio_yes')),None)
        if not device:
            return None
        try:
            channels=int(device.get('coreaudio_device_'+kind,0))
            rate=float(device.get('coreaudio_device_srate',0))
        except (ValueError,TypeError):return None
        if not 0<channels<=32 or not 8000<=rate<=384000:
            return None
        chosen.append([device.get('_name'),channels,rate])
    return chosen


def inspect_devices():
    # Enumeration does not open audio streams, change the default device or grant permission.
    try:
        result=subprocess.run(['/usr/sbin/system_profiler','-json','SPAudioDataType'],capture_output=True,text=True,timeout=5)
        if result.returncode:
            return None
        return device_signature(json.loads(result.stdout),audio_selection())
    except (OSError,ValueError,subprocess.SubprocessError):
        return None


def stable_devices(state, signature, now):
    if signature is None:
        state.pop('audio',None)
        return False
    previous=state.get('audio',{})
    if previous.get('signature')!=signature:
        state['audio']={'signature':signature,'since':now}
        return False
    return now-previous.get('since',now)>=SETTLE_SECONDS


def upgrade_state(state, connection, now):
    if state.get('version',1)<2:
        # One-time bounded catch-up of the new failure class, not a replay of old calls.
        row=connection.execute("select min(id) from logs where ts>=? and target=? and feedback_log_body=?",
            (now-WINDOW,'codex_realtime_webrtc::client',
             'voice helper output closed phase=Some(Device) exit_code=Some(37)')).fetchone()
        if row[0] is not None:
            state['cursor']=min(state['cursor'],row[0]-1)
        state['version']=2
    return state


def save(state):
    temp = STATE_FILE.with_suffix('.tmp')
    temp.write_text(json.dumps(state))
    os.replace(temp, STATE_FILE)


def send_start(pane_id):
    if pane_id.startswith('app:'):
        command = [queue.HC, 'send', pane_id[4:], '/voice']
    else:
        command = [queue.HERDR, 'pane', 'run', pane_id, '/voice']
    try:
        result = subprocess.run(command, capture_output=True, timeout=5)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        # A request can outlive voice startup: only the actual footer proves recovery.
        return False


def tick(state, connection):
    now = time.time()
    current = queue.panes()
    entries = state.setdefault('panes', {})
    by_pid = {}
    snapshots = {}
    for pane_id, pane in current.items():
        if pane.get('agent') != 'codex':
            continue
        try:
            session = queue.session_of(pane)
            pid = session.rsplit(':', 1)[-1]
            if not pid.isdigit():
                continue
            if entries.get(pane_id, {}).get('session') != session:
                entries[pane_id] = {'session':session, 'seen':False}
            record = entries[pane_id]
            text = queue.screen(pane_id)
            snapshots[pane_id] = text
            by_pid[pid] = pane_id
            if live(text):
                record['seen'] = True
                record.pop('absent_since', None)
                # Already recovered externally: stale errors must not toggle this connection.
                if now-record.get('failure', {}).get('ts', now) > 5:
                    record.pop('failure', None)
            else:
                record.setdefault('absent_since', now)
                if manual_stop(text):
                    record['seen'] = False
                    record.pop('failure', None)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            continue
    cursor, events = failures(connection, state['cursor'])
    state['cursor'] = cursor
    for event in events:
        pane_id = by_pid.get(event['pid'])
        if pane_id:
            entries[pane_id]['failure'] = event
    for pane_id,text in snapshots.items():
        record=entries[pane_id]
        event=record.get('failure')
        if not event or not record.get('seen') or live(text):
            continue
        if not event.get('confirmed') and confirmed_closure(connection,event):
            event['confirmed']=True
        marker=failure_marker(text)
        if marker is None and record.get('failure_ui')!=event['id']:
            marker=recent_failure(pane_id)
        if marker is True:
            record['failure_ui']=event['id']
        elif marker is False and manual_stop(text):
            record['seen']=False
            record.pop('failure',None)
    device_ready=False
    if any(r.get('failure',{}).get('kind')=='device' for r in entries.values()):
        device_ready=stable_devices(state,inspect_devices(),now)
    for pane_id, text in snapshots.items():
        record = entries[pane_id]
        if current[pane_id].get('agent_status') not in queue.LISTEN:
            continue
        if not eligible(record, text, current[pane_id].get('focused'), now, device_ready):
            continue
        # Focus, agent identity, live connection and draft are checked again at action time.
        fresh = queue.panes().get(pane_id, {})
        if (fresh.get('agent') != 'codex' or fresh.get('agent_status') not in queue.LISTEN
                or queue.session_of(fresh) != record['session']):
            continue
        if not eligible(record, queue.screen(pane_id), fresh.get('focused'), time.time(), device_ready):
            continue
        if record['failure'].get('kind')=='device' and inspect_devices()!=state.get('audio',{}).get('signature'):
            state.pop('audio',None)
            continue
        record['attempted'] = record['failure']['id']
        record['attempts'] = [at for at in record.get('attempts', []) if now-at < WINDOW]+[now]
        save(state)
        send_start(pane_id)
        queue.log(f"codex voice recovery requested {pane_id}; confirmed helper closure {record['attempted']}")
        deadline = time.monotonic()+12
        while time.monotonic() < deadline:
            if live(queue.screen(pane_id)):
                record.pop('failure', None)
                queue.main(advance=True)  # Serialize microphone routing with the normal focus actor.
                queue.log(f'codex voice recovery confirmed {pane_id}')
                break
            time.sleep(.3)
        else:
            queue.log(f'codex voice recovery unconfirmed {pane_id}; no repeated toggle')
    save(state)


def main():
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with (STATE_FILE.parent/'voice-recovery.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        PID_FILE.write_text(str(os.getpid()))
        path = Path.home()/'.codex/logs_2.sqlite'
        connection = sqlite3.connect('file:'+str(path)+'?mode=ro', uri=True, timeout=1)
        try:
            state = json.loads(STATE_FILE.read_text())
        except (OSError, ValueError):
            state = {'cursor':connection.execute('select coalesce(max(id),0) from logs').fetchone()[0]}
        state=upgrade_state(state,connection,time.time())
        queue.log('codex voice recovery monitor started; healthy calls are observation-only')
        while True:
            try:
                tick(state, connection)
            except Exception as error:
                queue.log(f'codex voice recovery observation failed: {type(error).__name__}')
            time.sleep(INTERVAL)


if __name__ == '__main__':
    main()
