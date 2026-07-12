const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function canonicalJSONStringify(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

export function strictJSONSnapshot<T>(value: T): T {
  return snapshot(value, "$", new Set<object>()) as T;
}

function snapshot(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not a JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const expectedKeys = new Set<PropertyKey>([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key))) {
        throw new TypeError(`${path} must be a dense JSON array`);
      }
      return Object.freeze(Array.from({ length: value.length }, (_item, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError(`${path}[${index}] must be plain data`);
        }
        return snapshot(descriptor.value, `${path}[${index}]`, ancestors);
      }));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || PROTOTYPE_KEYS.has(key)) {
        throw new TypeError(`${path} contains a prohibited key`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${path}.${key} must be plain enumerable data`);
      }
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshot(descriptor.value, `${path}.${key}`, ancestors),
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not a JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => serialize(item, `${path}[${index}]`, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    for (const key of keys) {
      if (PROTOTYPE_KEYS.has(key)) throw new TypeError(`${path}.${key} is not permitted`);
    }
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
