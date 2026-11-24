"""拼音查询：给错字治理做同音 / 近音校验。stdin 收 UTF-8 JSON，stdout 回 UTF-8 JSON。

注意：本机 python 的 stdin 编码是 cp1252（不是 utf-8），直接 json.load(sys.stdin)
会把中文按 cp1252 解成乱码，pypinyin 查不到拼音就原样返回——看起来「同音」，其实没验。
所以这里一律走 sys.stdin.buffer / sys.stdout.buffer。

输出给每个输入串：
  py   不带声调的全拼（同音校验用）
  ini  每个字的声母（近音校验用）
  fin  每个字的韵母+声调（近音校验用）
"""
import json
import sys

try:
    from pypinyin import lazy_pinyin, Style
except Exception as e:  # pypinyin 没装：明确告诉调用方不可用，由它进保守模式
    sys.stdout.buffer.write(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False).encode('utf-8'))
    sys.exit(0)

payload = sys.stdin.buffer.read().decode('utf-8')
try:
    items = json.loads(payload).get('items') or []
except Exception as e:
    sys.stdout.buffer.write(json.dumps({'ok': False, 'error': 'bad-json: ' + str(e)}, ensure_ascii=False).encode('utf-8'))
    sys.exit(0)

out = []
for s in items:
    s = str(s)
    py = ''.join(lazy_pinyin(s))
    ini = lazy_pinyin(s, style=Style.INITIALS, strict=False)
    fin = lazy_pinyin(s, style=Style.FINALS_TONE3, strict=False)
    # lazy_pinyin 对没有拼音的字（生僻字、外文、符号）会原样返回：这不是有效校验
    out.append({'py': py, 'ini': ini, 'fin': fin, 'known': py != s})

sys.stdout.buffer.write(json.dumps({'ok': True, 'items': out}, ensure_ascii=False).encode('utf-8'))
