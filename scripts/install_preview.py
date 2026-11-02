#!/usr/bin/env python3
"""Install optional upstream viewers plus the theme's local HTML adapter."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tempfile

COMMIT='089d87d6c5651f9950c68d10612cd8462058b83b'
REPOSITORY='https://github.com/linziyanleo/herdr-mods'
NAMES=('preview-plus','files-plus','sixfold-docs','sixfold-files')


def compile_html(repo,output):
    candidates=[Path('/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk'),Path('/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk')]
    result=subprocess.run(['xcrun','--show-sdk-path'],capture_output=True,text=True)
    if result.returncode==0:candidates.append(Path(result.stdout.strip()))
    errors=[]
    for sdk in dict.fromkeys(candidates):
        if not sdk.exists():continue
        attempt=subprocess.run(['swiftc','-sdk',str(sdk),str(repo/'scripts/render_html.swift'),'-o',str(output)],capture_output=True,text=True)
        if not attempt.returncode:return
        errors.append(attempt.stderr)
    raise RuntimeError('A compatible macOS Swift SDK is required for HTML preview.\n'+'\n'.join(errors)[-2000:])


def has_files(node):
    return node.get('id')=='files' or any(has_files(child) for child in node.get('children',[]))


def replace_files(node,stack):
    if node.get('id')=='files':
        for key in ('content','type','children','active'):node.pop(key,None)
        node.update(stack)
        return True
    return any(replace_files(child,stack) for child in node.get('children',[]))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,help='a clean checkout of the exact reviewed upstream commit')
    parser.add_argument('--markdown-only',action='store_true')
    parser.add_argument('--layout',default='sixfold',help='personal layout filename, without .json')
    args=parser.parse_args()
    repo=Path(__file__).resolve().parents[1]
    app=Path(os.environ.get('HERDR_APP_HOME',Path.home()/'.config/herdr-app'))
    if Path(args.layout).name!=args.layout or args.layout in ('.','..'):parser.error('use a personal layout name')
    layout=app/'layouts'/f'{args.layout}.json'
    doc=json.loads(layout.read_text())
    if not has_files(doc):raise SystemExit("Choose a personal layout with a Files panel before installing. No files were changed.")
    for name in NAMES:
        if (app/'mods'/name).exists():raise SystemExit(f'Preserving existing mod; inspect it before updating: {name}')
    upstream=args.source or Path.home()/'.local/share/herdr-sixfold/vendor/herdr-mods'
    if not upstream.exists():
        upstream.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['git','clone','--filter=blob:none','--no-checkout',REPOSITORY,str(upstream)],check=True)
        subprocess.run(['git','-C',str(upstream),'fetch','--depth','1','origin',COMMIT],check=True)
        subprocess.run(['git','-C',str(upstream),'checkout','--detach',COMMIT],check=True)
    head=subprocess.check_output(['git','-C',str(upstream),'rev-parse','HEAD'],text=True).strip()
    if head!=COMMIT:raise SystemExit('Upstream checkout differs from the reviewed commit; no files installed.')
    if subprocess.check_output(['git','-C',str(upstream),'status','--porcelain'],text=True).strip():raise SystemExit('Upstream has local changes; no files installed.')
    data=app/'data/sixfold';data.mkdir(parents=True,exist_ok=True)
    renderer=data/'html-preview/render-html';renderer.parent.mkdir(parents=True,exist_ok=True)
    # Validate an isolated staging tree before making any mod visible to the app.
    with tempfile.TemporaryDirectory(prefix='preview-setup-',dir=data) as temporary:
        stage=Path(temporary)
        if sys.platform=='darwin' and not args.markdown_only:compile_html(repo,stage/'render-html')
        for name in ('preview-plus','files-plus'):
            shutil.copytree(upstream/name/'mods'/name,stage/name,ignore=shutil.ignore_patterns('.cache','gpui-kit.d.ts','jsconfig.json'))
            shutil.copytree(upstream/name/'licenses',stage/name/'licenses',dirs_exist_ok=True)
            manifest=stage/name/'mod.json'
            metadata=json.loads(manifest.read_text());metadata['place']='none';manifest.write_text(json.dumps(metadata))
        for name,base in [('sixfold-docs','preview-plus'),('sixfold-files','files-plus')]:
            shutil.copytree(repo/'extras/preview/mods'/name,stage/name)
            shutil.copytree(upstream/base/'mods'/base,stage/name/'upstream',ignore=shutil.ignore_patterns('.cache','gpui-kit.d.ts','jsconfig.json'))
            shutil.copytree(upstream/base/'licenses',stage/name/'licenses',dirs_exist_ok=True)
        for name in NAMES:subprocess.run(['herdr-app','check',str(stage/name)],check=True)
        installed=[]
        try:
            for name in NAMES:
                (stage/name).replace(app/'mods'/name);installed.append(name)
            if (stage/'render-html').exists():
                shutil.copy2(stage/'render-html',renderer.with_suffix('.next'));renderer.with_suffix('.next').replace(renderer)
        except Exception:
            for name in installed:shutil.rmtree(app/'mods'/name)
            raise
    stack={'id':'files','type':'stack','active':'files-plus-tree','children':[
        {'id':'files-plus-tree','type':'block','content':{'mod':'sixfold-files','props':{'previewStack':'files'}}},
        {'id':'preview-plus','type':'block','content':{'mod':'sixfold-docs','props':{'previewStack':'files'}}}]}
    if not replace_files(doc,stack):raise SystemExit('Files block not found; mod files are installed but layout was preserved.')
    backup=layout.with_name(f'sixfold.before-preview-{int(time.time())}.backup');shutil.copy2(layout,backup)
    temp=layout.with_suffix('.tmp');temp.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n');temp.replace(layout)
    (data/'preview-install.json').write_text(json.dumps({'repository':REPOSITORY,'commit':COMMIT,'mods':NAMES,'html':renderer.exists()}))
    print('Installed live Markdown preview and local HTML rendering. Existing panes are preserved.')


if __name__=='__main__':main()
