// Small JSON Schema subset checker for the keywords panel-feed.schema.json uses.
export function validate(schema, value, start = schema) {
  const errors = [];
  const resolve = ref => ref.slice(2).split('/').reduce((node, key) => node[key], schema);
  const type = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  const typeOk = (t, v) => (Array.isArray(t) ? t : [t]).some(name => name === type(v) || (name === 'number' && typeof v === 'number'));
  const run = (rule, v, path) => {
    const bad = message => { errors.push(`${path || '/'}: ${message}`); return false; };
    if (rule.$ref) return run(resolve(rule.$ref), v, path);
    let ok = true;
    if (rule.type && !typeOk(rule.type, v)) return bad(`type ${rule.type}`);
    if (rule.const !== undefined && v !== rule.const) ok = bad('const');
    if (rule.enum && !rule.enum.includes(v)) ok = bad('enum');
    if (typeof v === 'string') {
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(v)) ok = bad('pattern');
      if (rule.maxLength !== undefined && v.length > rule.maxLength) ok = bad('maxLength');
      if (rule.minLength !== undefined && v.length < rule.minLength) ok = bad('minLength');
    }
    if (Array.isArray(v)) {
      if (rule.maxItems !== undefined && v.length > rule.maxItems) ok = bad('maxItems');
      if (rule.items) v.forEach((item, i) => { ok = run(rule.items, item, `${path}/${i}`) && ok; });
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const key of rule.required || []) if (!(key in v)) ok = bad(`required ${key}`);
      for (const [key, sub] of Object.entries(rule.properties || {})) if (key in v) ok = run(sub, v[key], `${path}/${key}`) && ok;
      if (rule.additionalProperties === false)
        for (const key of Object.keys(v)) if (!(key in (rule.properties || {}))) ok = bad(`extra ${key}`);
    }
    for (const sub of rule.allOf || []) ok = run(sub, v, path) && ok;
    if (rule.anyOf && !rule.anyOf.some(sub => validate(schema, v, sub).length === 0)) ok = bad('anyOf');
    if (rule.oneOf && rule.oneOf.filter(sub => validate(schema, v, sub).length === 0).length !== 1) ok = bad('oneOf');
    if (rule.if) {
      const branch = validate(schema, v, rule.if).length === 0 ? rule.then : rule.else;
      if (branch) ok = run(branch, v, path) && ok;
    }
    return ok;
  };
  run(start, value, '');
  return errors;
}
