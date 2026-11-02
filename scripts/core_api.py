"""Use herdr-core's documented plain JSON-RPC transport through hc connect."""
import json
import select
import subprocess


def call(method, params):
    process = subprocess.Popen(['hc', 'connect'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        process.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params})+'\n')
        process.stdin.flush()
        if not select.select([process.stdout], [], [], 10)[0]:
            raise TimeoutError(method)
        reply = json.loads(process.stdout.readline())
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
