/**
 * ATLAS Field Mapper
 * Transforms raw API/file records into ATLAS standard models via config-defined mapping.
 *
 * Mapping syntax (in config.yml):
 *   field: "$.path.to.value"         — JSONPath-lite (dot notation)
 *   field: "static string"           — static value
 *   field:                           — value map (status codes → standard names)
 *     source: "$.status_code"
 *     map: { "1": "pending", "2": "in_transit" }
 *     default: "unknown"
 *   field:                           — nested object
 *     city: "$.from_city"
 *     country: "$.from_country"
 */

/** Resolve dot-path like "$.a.b.c" from an object */
export function getPath(obj, path) {
  const clean = path.startsWith('$.') ? path.slice(2) : path;
  return clean.split('.').reduce((o, k) => (o == null ? undefined : Array.isArray(o) ? o[parseInt(k, 10)] : o[k]), obj);
}

/** Resolve "${MY_TOKEN}" → process.env.MY_TOKEN */
export function resolveEnv(val) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? '');
}

/**
 * Apply a mapping spec to a source object.
 * @param {object} source — raw record from API/file
 * @param {object} mapping — mapping spec from config.yml
 */
export function applyMapping(source, mapping) {
  if (!mapping || typeof mapping !== 'object') return source;
  const result = {};
  for (const [targetKey, spec] of Object.entries(mapping)) {
    result[targetKey] = resolveField(source, spec);
  }
  return result;
}

function resolveField(source, spec) {
  if (spec === null || spec === undefined) return undefined;

  // Static string (no $ = static value)
  if (typeof spec === 'string' && !spec.startsWith('$')) return spec;

  // Simple JSONPath: "$.tracking_number"
  if (typeof spec === 'string' && spec.startsWith('$')) return getPath(source, spec);

  if (typeof spec === 'object') {
    // Value map: { source: "$.status_code", map: {"1":"pending"}, default: "unknown" }
    if (spec.source && spec.map) {
      const raw = getPath(source, spec.source);
      const mapped = spec.map[String(raw)];
      return mapped !== undefined ? mapped : (spec.default ?? raw);
    }
    // Nested object: { city: "$.from_city", country: "$.from_country" }
    const nested = {};
    for (const [k, v] of Object.entries(spec)) nested[k] = resolveField(source, v);
    return nested;
  }

  return spec;
}

/**
 * Validate minimum required fields for an entity.
 * Returns { valid: bool, errors: string[] }
 */
export function validateMapped(entity, record) {
  const errors = [];
  if (!record.id) errors.push('Missing required field: id');
  if (entity === 'shipments' && !record.status) errors.push('Missing field: status');
  if (entity === 'carriers' && !record.name) errors.push('Missing field: name');
  if (entity === 'rates') {
    if (!record.origin_country && !record.origin?.country) errors.push('Missing field: origin');
    if (!record.destination_country && !record.destination?.country) errors.push('Missing field: destination');
  }
  return { valid: errors.length === 0, errors };
}
