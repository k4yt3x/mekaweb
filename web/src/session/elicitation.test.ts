import { expect, it } from 'vitest';
import { openableUrl, questionContent, questionDefaults, questionFields } from './elicitation';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name', minLength: 2 },
    email: { type: 'string', format: 'email', description: 'For the receipt' },
    age: { type: 'integer', minimum: 0, default: 30 },
    ratio: { type: 'number' },
    subscribe: { type: 'boolean', default: true },
    color: { type: 'string', enum: ['red', 'blue'], enumNames: ['Red', 'Blue'] },
    size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l' }], default: 'l' },
    tags: {
      type: 'array',
      items: { type: 'string', enum: ['a', 'b', 'c'] },
      maxItems: 2,
      default: ['a', 'x'],
    },
    when: { type: 'string', format: 'date-time' },
  },
  required: ['name', 'tags'],
};

it('reads each kind of field MCP allows in a form, in the order the server wrote them', () => {
  expect(questionFields(schema)).toEqual([
    { name: 'name', label: 'Name', required: true, type: 'text', minLength: 2 },
    {
      name: 'email',
      label: 'email',
      description: 'For the receipt',
      required: false,
      type: 'text',
      format: 'email',
    },
    { name: 'age', label: 'age', required: false, type: 'number', integer: true, minimum: 0 },
    { name: 'ratio', label: 'ratio', required: false, type: 'number', integer: false },
    { name: 'subscribe', label: 'subscribe', required: false, type: 'boolean' },
    {
      name: 'color',
      label: 'color',
      required: false,
      type: 'choice',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'blue', label: 'Blue' },
      ],
    },
    {
      name: 'size',
      label: 'size',
      required: false,
      type: 'choice',
      options: [
        { value: 's', label: 'Small' },
        { value: 'l', label: 'l' },
      ],
    },
    {
      name: 'tags',
      label: 'tags',
      required: true,
      type: 'choices',
      options: ['a', 'b', 'c'].map((value) => ({ value, label: value })),
      maxItems: 2,
    },
    { name: 'when', label: 'when', required: false, type: 'text', format: 'date-time' },
  ]);
});

it('starts from the server’s defaults where they fit the field', () => {
  expect(questionDefaults(schema, questionFields(schema))).toEqual({
    name: '',
    email: '',
    age: '30',
    ratio: '',
    subscribe: true,
    color: '',
    size: 'l',
    tags: ['a'],
    when: '',
  });
});

it('sends typed values, leaves out empty optional ones, and says what is missing', () => {
  const fields = questionFields(schema);
  const values = questionDefaults(schema, fields);
  expect(questionContent(fields, values)).toEqual({ error: 'Name is required.' });
  expect(questionContent(fields, { ...values, name: 'Ada', tags: [] })).toEqual({
    error: 'tags: pick at least 1.',
  });
  expect(questionContent(fields, { ...values, name: 'Ada', tags: ['a', 'b', 'c'] })).toEqual({
    error: 'tags: pick at most 2.',
  });
  expect(questionContent(fields, { ...values, name: 'Ada', age: '2.5' })).toEqual({
    error: 'age must be a whole number.',
  });
  expect(
    questionContent(fields, { ...values, name: 'Ada', ratio: ' 0.5 ', when: '2026-10-28T09:30' }),
  ).toEqual({
    content: {
      name: 'Ada',
      age: 30,
      ratio: 0.5,
      subscribe: true,
      size: 'l',
      tags: ['a'],
      when: new Date('2026-10-28T09:30').toISOString(),
    },
  });
});

it('opens only a web address', () => {
  expect(openableUrl('https://example.com/a')).toBe(true);
  expect(openableUrl('http://localhost:1455/')).toBe(true);
  expect(openableUrl('javascript:alert(1)')).toBe(false);
  expect(openableUrl('file:///etc/passwd')).toBe(false);
  expect(openableUrl('not a url')).toBe(false);
});
