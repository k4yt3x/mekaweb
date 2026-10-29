import { record } from './events';

/**
 * One field of an MCP server's form. MCP restricts a form's schema to an object of flat fields:
 * text, a number, a yes or no, or a pick of one or more listed values.
 */
export type QuestionField = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
} & (
  | {
      type: 'text';
      format?: 'email' | 'uri' | 'date' | 'date-time';
      minLength?: number;
      maxLength?: number;
    }
  | { type: 'number'; integer: boolean; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'choice'; options: QuestionOption[] }
  | { type: 'choices'; options: QuestionOption[]; minItems?: number; maxItems?: number }
);
export interface QuestionOption {
  value: string;
  label: string;
}
/** What the person has entered: text as typed, numbers included, until it is sent. */
export type QuestionValues = Record<string, string | boolean | string[]>;

const formats = ['email', 'uri', 'date', 'date-time'] as const;
function count(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function text(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}
/** The listed values of an enum, titled by `oneOf`/`anyOf` consts or the older `enumNames`. */
function options(schema: Record<string, unknown>): QuestionOption[] | undefined {
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf;
  if (Array.isArray(titled))
    return titled.flatMap((option) =>
      record(option) && typeof option.const === 'string'
        ? [{ value: option.const, label: text(option.title) ?? option.const }]
        : [],
    );
  if (!Array.isArray(schema.enum)) return undefined;
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return schema.enum.flatMap((value, index) =>
    typeof value === 'string' ? [{ value, label: text(names[index]) ?? value }] : [],
  );
}

/** The fields of a form's schema, in the order the server wrote them. */
export function questionFields(schema: Record<string, unknown>): QuestionField[] {
  const properties = record(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties).map(([name, property]) => {
    const field = record(property) ? property : {};
    const description = text(field.description);
    const common = {
      name,
      label: text(field.title) ?? name,
      ...(description ? { description } : {}),
      required: required.includes(name),
    };
    if (field.type === 'boolean') return { ...common, type: 'boolean' };
    if (field.type === 'number' || field.type === 'integer') {
      const minimum = count(field.minimum);
      const maximum = count(field.maximum);
      return {
        ...common,
        type: 'number',
        integer: field.type === 'integer',
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
      };
    }
    if (field.type === 'array' && record(field.items)) {
      const minItems = count(field.minItems);
      const maxItems = count(field.maxItems);
      return {
        ...common,
        type: 'choices',
        options: options(field.items) ?? [],
        ...(minItems !== undefined ? { minItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
      };
    }
    const listed = options(field);
    if (listed) return { ...common, type: 'choice', options: listed };
    const format = formats.find((name) => name === field.format);
    const minLength = count(field.minLength);
    const maxLength = count(field.maxLength);
    return {
      ...common,
      type: 'text',
      ...(format ? { format } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
    };
  });
}

/** `datetime-local` takes the local wall-clock time, without seconds or an offset. */
function localDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** Each field's starting value: the server's default where it gave one of the right kind. */
export function questionDefaults(
  schema: Record<string, unknown>,
  fields: QuestionField[],
): QuestionValues {
  const properties = record(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    fields.map((field) => {
      const property = properties[field.name];
      const fallback = record(property) ? property.default : undefined;
      if (field.type === 'boolean') return [field.name, fallback === true];
      if (field.type === 'choices')
        return [
          field.name,
          Array.isArray(fallback)
            ? fallback.filter((value): value is string =>
                field.options.some((option) => option.value === value),
              )
            : [],
        ];
      if (field.type === 'number')
        return [field.name, count(fallback) !== undefined ? String(fallback) : ''];
      if (typeof fallback !== 'string') return [field.name, ''];
      if (field.type === 'choice')
        return [
          field.name,
          field.options.some((option) => option.value === fallback) ? fallback : '',
        ];
      return [field.name, field.format === 'date-time' ? localDateTime(fallback) : fallback];
    }),
  );
}

/**
 * The answer's `content`, or why it cannot be sent. The inputs check what a browser can, so this
 * checks the rest: how many of a list are picked, and that a number is one.
 */
export function questionContent(
  fields: QuestionField[],
  values: QuestionValues,
): { content: Record<string, unknown> } | { error: string } {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'boolean') {
      content[field.name] = value === true;
    } else if (field.type === 'choices') {
      const picked = Array.isArray(value) ? value : [];
      const least = Math.max(field.minItems ?? 0, field.required ? 1 : 0);
      if (picked.length < least)
        return { error: `${field.label}: pick at least ${String(least)}.` };
      if (field.maxItems !== undefined && picked.length > field.maxItems)
        return { error: `${field.label}: pick at most ${String(field.maxItems)}.` };
      if (picked.length || field.required) content[field.name] = picked;
    } else {
      const entered = typeof value === 'string' ? value : '';
      if (!entered.trim()) {
        if (field.required) return { error: `${field.label} is required.` };
        continue;
      }
      if (field.type === 'number') {
        const number = Number(entered.trim());
        if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number)))
          return {
            error: `${field.label} must be ${field.integer ? 'a whole number' : 'a number'}.`,
          };
        content[field.name] = number;
      } else if (field.type === 'text' && field.format === 'date-time') {
        const date = new Date(entered);
        if (Number.isNaN(date.getTime()))
          return { error: `${field.label} is not a date and time.` };
        content[field.name] = date.toISOString();
      } else content[field.name] = entered;
    }
  }
  return { content };
}

/** Whether a URL question's address may be opened from here: the web, not a script or a file. */
export function openableUrl(url: string) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
