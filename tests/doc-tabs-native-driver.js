// Disposable-app acceptance driver. Never installed in the user's app.
import Panel from './panel.js';
import { props, readTextFile, writeTextFile } from 'herdr';
export default class Driver extends Panel {
  init(p, cx) {
    super.init(p, cx);
    this.control = props().control;
    cx.timer.every(200, cx => {
      if (this.reporting) return;
      this.reporting = true;
      cx.spawn(async cx => {
        try {
          const command = JSON.parse(await readTextFile(`${this.control}/command.json`) || '{}');
          if (command.sequence !== this.sequence) {
            this.sequence = command.sequence;
            if (command.select) this.choose(command.select, cx);
            if (command.refresh) this.refresh(cx);
          }
          const state = JSON.stringify({ selected: this.selected, path: this.lastPath, text: this.bodyText,
            error: this.bodyError, listError: this.listError, documents: this.documents, sequence: this.sequence,
            lastSuccess: this.lastSuccess, truncated: this.truncated, blocks: this.blocks?.length });
          const path = `${this.control}/state.json`, old = await readTextFile(path);
          if (old !== state) await writeTextFile(path, state, old);
        } finally { this.reporting = false; }
      });
    });
  }
}
