// 集成测试：模拟 scanText 字段扫描，验证"全网最低"+douyin 能被命中
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrie, search } from './matcher.ts'
import type { RawTerm } from './matcher.ts'
import type { ComplianceLevel } from '../../../types/compliance'

function buildTerms(): RawTerm[] {
  const common = ['第一品牌', '最便宜', '国家级', '加微信']
  const douyin = ['全网最低', '导流私信', '微信下单']
  const out: RawTerm[] = []
  for (const t of common) out.push({ term: t, level: 'mid' as ComplianceLevel, platform: 'common' })
  for (const t of douyin) out.push({ term: t, level: 'high' as ComplianceLevel, platform: 'douyin' })
  return out
}

const trie = buildTrie(buildTerms())

test('"全网最低" 在抖音平台被命中（高危）', () => {
  const hits = search(trie, '全网最低')
  assert.ok(hits.length >= 1, '应至少命中 1 个词')
  const hit = hits.find((h) => h.term === '全网最低')
  assert.ok(hit, '应命中"全网最低"')
  assert.equal(hit!.level, 'high')
  assert.equal(hit!.platform, 'douyin')
})

test('标题含"全网最低 第一品牌"应同时命中两个词（跨 common+douyin）', () => {
  const hits = search(trie, '全网最低 第一品牌 限时抢购')
  const terms = hits.map((h) => h.term)
  assert.ok(terms.includes('全网最低'), '命中 douyin 词')
  assert.ok(terms.includes('第一品牌'), '命中 common 词')
})

test('正常文案不应误报', () => {
  const hits = search(trie, '今天天气真好，分享一个日常 vlog')
  assert.equal(hits.length, 0)
})
