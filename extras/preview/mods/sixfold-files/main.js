import FilesPlus from './upstream/main.js';
import {props, shared, setShared, focused, run, readTextFile, appHome, nextCommand} from 'herdr';

// Integration only: upstream Files Plus stays separately installed and attributed.
export default class SixfoldFiles extends FilesPlus {
  init(p,cx) {
    super.init(p,cx);
    if(this.role)return;
    cx.spawn(async cx=>{
      for(;;){
        const command=await nextCommand();
        if(command!=='open')continue;
        const before=focused()?.space;
        try {
          const request=JSON.parse(await readTextFile(`${appHome()}/data/sixfold/preview-open.json`));
          if(request.space!==before || focused()?.space!==before)continue;
          setShared('preview-plus.target',{...(shared('preview-plus.target')||{}),[before]:{file:request.file,root:request.root,on:null}});
          run('layout.select',{stack:'files',child:'preview-plus'});
        }catch{ /* The normal Files tree remains available. */ }
      }
    });
  }
  openFile(path,root,cx) {
    if(!/\.html?$/i.test(path)||this.on||!props()?.previewStack)return super.openFile(path,root,cx);
    setShared('preview-plus.target',{...(shared('preview-plus.target')||{}),[this.spaceId]:{file:path,root,on:null}});
    run('layout.select',{stack:props().previewStack,child:'preview-plus'});
    cx.notify();
  }
}
