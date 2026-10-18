// Minimal JSON-Schema subset validator: type, enum, minimum, maximum,
// required, properties, additionalProperties:false, items, default.
export class ValidationError extends Error {
  constructor(msg) { super(msg); this.status = 400; this.code = 'invalid_args'; }
}

export function validate(schema, value, path = 'args') {
  if (value === undefined) return value;
  const t = schema.type;
  if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${path} must be a number`);
    if (t === 'integer' && !Number.isInteger(value)) throw new ValidationError(`${path} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new ValidationError(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new ValidationError(`${path} must be <= ${schema.maximum}`);
  } else if (t === 'string') {
    if (typeof value !== 'string') throw new ValidationError(`${path} must be a string`);
    if (schema.maxLength && value.length > schema.maxLength) throw new ValidationError(`${path} is too long`);
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') throw new ValidationError(`${path} must be a boolean`);
  } else if (t === 'array') {
    if (!Array.isArray(value)) throw new ValidationError(`${path} must be an array`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`));
  } else if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${path} must be an object`);
    for (const r of schema.required || []) {
      if (value[r] === undefined) throw new ValidationError(`${path}.${r} is required`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`);
      else if (schema.additionalProperties === false) throw new ValidationError(`${path}.${k} is not a known field (allowed: ${Object.keys(props).join(', ')})`);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) throw new ValidationError(`${path} must be one of: ${schema.enum.join(', ')}`);
  return value;
}
