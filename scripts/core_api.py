"""Use herdr-core's documented plain JSON-RPC transport through hc connect."""
import json
import queue
import threading
import subprocess


def call(method, params):
    process = subprocess.Popen(['hc', 'connect'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        process.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params})+'\n')
        process.stdin.flush()
        replies = queue.Queue()
        threading.Thread(target=lambda: replies.put(process.stdout.readline()), daemon=True).start()
        try:
            reply = json.loads(replies.get(timeout=10))
        except queue.Empty:
            raise TimeoutError(method) from None
        if 'error' in reply:
            raise RuntimeError(reply['error'])
        return reply['result']
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()


def balance(document):
    def walk(node):
        children = node.get('children', [])
        if node.get('type') in ('row','column'):
            for child in children:
                child['size'] = {'weight':1}
        for child in children:
            walk(child)
    for space in document.get('spaces', []):
        for tab in space.get('tabs', []):
            walk(tab['root'])
    return document


if __name__ == '__main__':
    snapshot = call('doc.get', {'name':'herdr-app'})
    print(call('doc.set', {'name':'herdr-app','version':snapshot['version'],'value':balance(snapshot['value'])}))
