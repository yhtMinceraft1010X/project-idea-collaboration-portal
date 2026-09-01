'use strict';

// Pure helper tests - no AWS access, so nothing is mocked.
const {
  entityKey,
  entityRef,
  buildEntityItem,
  relationshipItem,
  vectorMetadata,
  textForEmbedding,
} = require('../src/lib/entities');
const { isoWeek, dateKey, deterministicId } = require('../src/lib/ids');

test('entityKey builds the PROBLEM#/METADATA key shape', () => {
  expect(entityKey('problems', 'abc')).toEqual({ pk: 'PROBLEM#abc', sk: 'METADATA' });
  expect(entityRef('initiatives', 'x')).toBe('INITIATIVE#x');
});

test('buildEntityItem sets defaults and merges fields', () => {
  const item = buildEntityItem('findings', 'f1', { title: 'T', content: 'C' });
  expect(item.pk).toBe('FINDING#f1');
  expect(item.sk).toBe('METADATA');
  expect(item.entityType).toBe('findings');
  expect(item.status).toBe('published');
  expect(item.title).toBe('T');
});

test('relationshipItem builds a directed edge', () => {
  const edge = relationshipItem('initiatives', 'i1', 'problems', 'p1', 'addresses');
  expect(edge.pk).toBe('ENTITY#initiatives#i1');
  expect(edge.sk).toBe('REL#problems#p1');
  expect(edge.relationType).toBe('addresses');
});

test('vectorMetadata exposes filterable fields + a snippet', () => {
  const md = vectorMetadata('problems', 'p1', { title: 'Slow', tags: ['ci', 'build'], status: 'published' });
  expect(md.entityType).toBe('problems');
  expect(md.entityId).toBe('p1');
  expect(md.tags).toBe('ci,build');
  expect(typeof md.snippet).toBe('string');
});

test('textForEmbedding concatenates the salient fields', () => {
  const text = textForEmbedding({ title: 'A', description: 'B', tags: ['c'] });
  expect(text).toContain('A');
  expect(text).toContain('B');
});

test('id helpers produce stable shapes', () => {
  expect(isoWeek(new Date('2026-02-03T00:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  expect(dateKey(new Date('2026-02-03T00:00:00Z'))).toBe('2026-02-03');
  expect(deterministicId('github', '42')).toBe(deterministicId('github', '42'));
});
