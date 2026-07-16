// Aho-Corasick matcher 单测（Node 内置 node:test，零依赖）
// 运行：node --experimental-strip-types --test src/main/services/compliance/matcher.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrie, search } from './matcher.ts';
import type { RawTerm } from './matcher.ts';

const terms: RawTerm[] = [
  { term: '最便宜', level: 'high', platform: 'common' },
  { term: '便宜', level: 'mid', platform: 'common' },
  { term: '第一品牌', level: 'high', platform: 'common' },
  { term: 'WeChat', level: 'high', platform: 'common' },
  { term: '导流私信', level: 'high', platform: 'douyin' },
];

const trie = buildTrie(terms);

describe('matcher Aho-Corasick', () => {
  test('多词命中', () => {
    const hits = search(trie, '这是第一品牌且最便宜');
    const found = hits.map((h) => h.term).sort();
    assert.deepEqual(found, ['第一品牌', '便宜', '最便宜'].sort());
  });

  test('重叠词不漏（最便宜 / 便宜 均命中）', () => {
    const hits = search(trie, '最便宜');
    const found = hits.map((h) => h.term);
    assert.ok(found.includes('最便宜'));
    assert.ok(found.includes('便宜'));
  });

  test('分级正确', () => {
    const hits = search(trie, '最便宜');
    const cheap = hits.find((h) => h.term === '最便宜')!;
    assert.equal(cheap.level, 'high');
    const mid = hits.find((h) => h.term === '便宜')!;
    assert.equal(mid.level, 'mid');
  });

  test('空串返回空', () => {
    assert.equal(search(trie, '').length, 0);
  });

  test('英文忽略大小写', () => {
    const hits = search(trie, 'wechat 联系');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].term, 'WeChat');
  });

  test('字符索引正确', () => {
    const hits = search(trie, 'ABC第一品牌DEF');
    const h = hits.find((x) => x.term === '第一品牌')!;
    assert.equal(h.start, 3);
    assert.equal(h.end, 7);
  });

  test('无命中', () => {
    assert.equal(search(trie, '普通内容没有任何违禁词').length, 0);
  });

  test('特殊字符 / 标点不干扰', () => {
    const hits = search(trie, '！！最便宜！！，来吧');
    const found = hits.map((h) => h.term);
    assert.ok(found.includes('最便宜'));
  });

  test('平台词命中并标注 platform', () => {
    const hits = search(trie, '请勿导流私信给我');
    const h = hits.find((x) => x.term === '导流私信')!;
    assert.ok(h);
    assert.equal(h.platform, 'douyin');
  });
});
