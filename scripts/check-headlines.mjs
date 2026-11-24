/**
 * 大字的离线检查：长度、接地（只能用这一句的字）、连续性、词边界、开头结尾。
 * 模型说的话靠真素材跑片看，这里只验「规则有没有漏洞」——尤其兜底路径。
 */
import { checkHeadline, pickHeadline, HEADLINE, onWordBoundary } from '../src/headlines.mjs'

let pass = 0
const fails = []
const ok = (cond, name, extra = '') => { if (cond) pass++; else fails.push(name + (extra ? '：' + extra : '')) }

const S1 = '真正的机会是在OPC结合内容'
const S2 = '我们真正的内容生产力'
const S3 = '但是我今天就要给大家泼一瓶冷水'
const S4 = '大家用GPT用Claude用'

// ── 1. 校验器：不该过的必须拦 ──
ok(!checkHeadline('的内容生产力', S2).ok, '校验 · 以「的」开头拦下')
ok(/以连接词开头/.test(checkHeadline('的内容生产力', S2).why || ''), '校验 · 理由说清是起头问题')
ok(!checkHeadline('用C', S4).ok, '校验 · 把英文词切成 C 拦下')
ok(!checkHeadline('机会是在', S1).ok, '校验 · 结尾是虚词拦下')
ok(checkHeadline('机会是在OPC', S1).ok, '校验 · 正常摘句放行')
ok(!checkHeadline('另一个句子', S1).ok, '校验 · 用了本句没有的字拦下')
ok(onWordBoundary('今天大街都在', '今天大街都在卷AI技术'), '词边界 · 整词边界放行')

// ── 2. 兜底路径也不许拿虚词起头（自测20 就出过「的机会是在OPC」）──
const p1 = pickHeadline(S1)
ok(!/^[的了着过地得]/.test(p1), '兜底 · 不以「的」起头', p1)
ok(S1.includes(p1), '兜底 · 是这一句连续的一段', p1)
ok([...p1].length >= HEADLINE.minChars && [...p1].length <= HEADLINE.maxChars, '兜底 · 长度在 2–8 之间', p1)
const p2 = pickHeadline(S3)
ok(!/^(但是|然后|所以|因为|就是)/.test(p2), '兜底 · 不以连接词起头', p2)
const p3 = pickHeadline('机会')
ok(p3 === '机会', '兜底 · 短句照旧给（2 字）', p3)
const p4 = pickHeadline('的的确确')
ok(!/^的/.test(p4) || p4.length < HEADLINE.minChars + 1, '兜底 · 连着的「的的」也能剥掉', p4)

// ── 3. 门槛常量 ──
ok(HEADLINE.minChars === 2 && HEADLINE.maxChars === 8, '门槛 · 长度常量在位')
ok(HEADLINE.badHead.test('的了着过地得'), '门槛 · 结构助词在 badHead 里')

console.log(fails.length ? 'FAIL ' + fails.length + ' / ' + (pass + fails.length) : 'PASS ' + pass)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }
