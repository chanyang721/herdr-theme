#!/usr/bin/env python3
"""Index configured project documents and maintain only explicitly owned symlinks."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))
import site_config  # noqa: E402

EXTENSIONS={'.md','.html','.htm','.pdf','.docx','.xlsx'}
OWNER='herdr-project-docs-v1'


def atomic_json(path,value):
    text=json.dumps(value,ensure_ascii=False,indent=2)+'\n'
    try:
        if path.read_text()==text:return False
    except FileNotFoundError:pass
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as file:file.write(text)
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
    return True


def is_archived(path):
    """Classify the original path without changing its spelling on disk."""
    normalized=unicodedata.normalize('NFC',str(path)).casefold()
    return any(term in normalized for term in ('archive','아카이브','보관','.before-'))


def documents(folders,warnings=None,include_archived=False):
    warnings=warnings if warnings is not None else []
    found={}
    for entry in folders:
        if isinstance(entry,str):entry={'path':entry}
        root=Path(entry['path']).expanduser()
        filters=entry.get('match',[])
        if isinstance(filters,str):filters=[filters]
        filters=[unicodedata.normalize('NFC',term).casefold() for term in filters]
        try:
            if not root.is_dir():warnings.append('source_unavailable');continue
        except OSError:warnings.append('source_unavailable');continue
        for directory,subdirs,files in os.walk(root,followlinks=False,onerror=lambda error:warnings.append('source_unavailable')):
            subdirs[:]=[name for name in subdirs if not name.startswith('.')]
            for name in files:
                path=Path(directory)/name
                if path.is_symlink() or path.suffix.lower() not in EXTENSIONS or name.lower()=='latest.md':continue
                archived=is_archived(path)
                if archived and not include_archived:continue
                if filters and not any(term in unicodedata.normalize('NFC',name).casefold() for term in filters):continue
                try:
                    if not path.is_file():continue
                    info=path.stat();source=str(path.resolve())
                except OSError:continue
                found[source]={'path':source,'name':name,'mtime':info.st_mtime_ns//1000000,'size':info.st_size,
                               'archived':archived,'folder':str(Path(source).parent),
                               'sourceRoot':str(root.resolve()),'relativePath':str(path.relative_to(root))}
    return sorted(found.values(),key=lambda item:(-item['mtime'],item['path']))


def owned_links(folder,items):
    folder.mkdir(parents=True,exist_ok=True)
    manifest=folder/'.herdr-document-links.json'
    try:
        previous=json.loads(manifest.read_text())
        if previous.get('owner')!=OWNER or not isinstance(previous.get('links'),dict):return 'manifest_conflict'
        managed=previous['links']
    except FileNotFoundError:managed={}
    except (OSError,ValueError,AttributeError):return 'manifest_conflict'
    # Only our recorded symlinks whose source has disappeared may be removed.
    retained={}
    for name,source in managed.items():
        if not isinstance(name,str) or Path(name).name!=name or not isinstance(source,str):continue
        link=folder/name
        try:
            if not link.is_symlink() or os.readlink(link)!=source:continue
            if not Path(source).exists():link.unlink()
            else:retained[name]=source
        except OSError:continue
    for item in items:
        source=item['path'];base=item['name'];existing=[name for name,value in retained.items() if value==source]
        if existing:continue
        name=base
        link=folder/name
        if os.path.lexists(link):
            digest=hashlib.sha256(source.encode()).hexdigest()[:12]
            name=f'{digest}-{base[:180]}';link=folder/name
        try:
            # symlink creation refuses any pre-existing path, including actual files.
            link.symlink_to(source);retained[name]=source
        except FileExistsError:pass
    atomic_json(manifest,{'owner':OWNER,'links':dict(sorted(retained.items()))})
    return None


def collect(config,index,pins=None):
    data=json.loads(config.read_text()) if config.exists() else {'version':1,'spaces':{}}
    if data.get('version')!=1 or not isinstance(data.get('spaces'),dict):raise ValueError('Expected version:1 and spaces mapping')
    output={'version':1,'spaces':{}}
    for space,settings in data['spaces'].items():
        folders=settings.get('folders',[])
        if not isinstance(folders,list):raise ValueError('folders must be an array')
        target=Path(settings.get('target',str(site_config.folder('projects_dir')/space))).expanduser()
        warnings=[]
        items=documents(folders,warnings,include_archived=True)
        problem=owned_links(target,[item for item in items if not item['archived']])
        if problem:warnings.append(problem)
        output['spaces'][space]={'folder':str(target.resolve()),'files':items}
        if warnings:output['spaces'][space]['warning']=','.join(sorted(set(warnings)))
    # Spaces that only have 문서 tab rules are indexed by id from those folders, without links.
    try:
        rules=json.loads(pins.read_text()).get('spaces',{}) if pins else {}
    except (OSError,ValueError,AttributeError):rules={}
    for space_id,settings in rules.items():
        if space_id in output['spaces'] or settings.get('name') in output['spaces'] or not isinstance(settings.get('folders'),list):continue
        warnings=[]
        items=documents(settings['folders'],warnings,include_archived=True)
        output['spaces'][space_id]={'folder':'','files':items}
        if warnings:output['spaces'][space_id]['warning']=','.join(sorted(set(warnings)))
    atomic_json(index,output)
    return output


def main():
    home=Path(os.environ.get('HERDR_APP_HOME',Path.home()/'.config/herdr-app'))/'data/sixfold'
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,default=home/'project-docs.json')
    parser.add_argument('--output',type=Path,default=home/'project-docs-index.json')
    parser.add_argument('--pins',type=Path,default=home/'project-docs-pins.json')
    args=parser.parse_args()
    if not args.config.exists() and not args.pins.exists():return
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        result=collect(args.config,args.output,args.pins)
    print(json.dumps({'spaces':len(result['spaces']),'documents':sum(len(x['files']) for x in result['spaces'].values())}))


if __name__=='__main__':main()
