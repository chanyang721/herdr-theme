// Classic-sidebar fixtures have no task feed. Keep their native UI fake small,
// and fail loudly if a task-only helper is accidentally exercised here. The
// task-enabled integration uses the real renderer in sidebar-coexist.test.mjs.
export function classicPanelImports(source){
  return source.replace(/import \{([^}]+)\} from '\.\/panel-view\.js';/g,(_line,names)=>{
    const imports=names.split(',').map(name=>name.trim());
    if(imports.some(name=>!['renderPanelTracking','panelCounts','panelHeaderMetrics'].includes(name)))throw new Error('Update the classic task-view import boundary');
    return `const ${imports.map(name=>`${name}=()=>{throw new Error('Task renderer requires a task-enabled fixture');}`).join(',')};`;
  });
}
