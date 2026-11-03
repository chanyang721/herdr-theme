// Mermaid blocks become native image() blocks rendered by scripts/render_mermaid.py.
// The fence rules match that script so each block is found by its exact code.
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*$/;

export function mermaidFences(text) {
  const lines = text.split('\n'), fences = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(FENCE);
    if (!opening) { offset += lines[index].length + 1; continue; }
    const start = offset, marker = opening[2], close = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`), body = [];
    offset += lines[index].length + 1;
    let end = -1;
    for (index++; index < lines.length; index++) {
      if (close.test(lines[index])) { end = offset + lines[index].length; offset = end + 1; break; }
      body.push(lines[index]); offset += lines[index].length + 1;
    }
    if (end < 0) break;
    fences.push({ start, end, code: body.join('\n') });
  }
  return fences;
}

// Split text blocks around rendered diagrams; unrendered ones stay as code.
export function applyDiagrams(blocks, diagrams) {
  if (!diagrams.size) return blocks;
  return blocks.flatMap(block => {
    if (!block.text) return [block];
    const parts = [];
    let cursor = 0;
    for (const fence of mermaidFences(block.text)) {
      const media = diagrams.get(fence.code);
      if (!media) continue;
      if (fence.start > cursor) parts.push({ text: block.text.slice(cursor, fence.start) });
      parts.push({ media, diagram: true });
      cursor = fence.end;
    }
    if (!parts.length) return [block];
    if (cursor < block.text.length) parts.push({ text: block.text.slice(cursor) });
    return parts.filter(part => !part.text || part.text.trim());
  });
}
