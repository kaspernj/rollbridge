// JSON-compatible value parsed from config files or assembled for logs and control responses.
// `undefined` is included so optional and partially-built fields stay representable without `unknown`.
export type JsonValue = boolean | number | string | null | undefined | JsonValue[] | {[key: string]: JsonValue}
