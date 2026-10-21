# Remove developer-facing citations from a converted guide, so the client corpus names no
# file, service or test. The source documents cite the code deliberately ("every statement
# comes from the code or its tests"); a client must not read any of it.
import sys, re

SERVICES = [
    'DefaultChartService.onOpenThrottled', 'DefaultChartService.onOpen',
    'stockReportsService.SOURCES', 'PostingService.catchUp',
]

def clean(s):
    # 1. a parenthetical that is only a test citation: (test: x.test.js, 'name') / (x.test.js)
    s = re.sub(r'\s*\((?:tests?:\s*)?[^()]*\.test\.js[^()]*\)', '', s)
    # 2. a parenthetical that is only file paths: (utils/foo.js, utils/bar.js)
    s = re.sub(r'\s*\((?:see\s+)?[A-Za-z0-9_./-]+\.js(?:\s*,\s*[A-Za-z0-9_./-]+\.js)*\)', '', s)
    # 3. a "Test: ..." clause in a bullet or sentence, up to the next bullet or the end
    s = re.sub(r'(?:•\s*)?\bTests?:\s*[^•|\n]*?(?=(?:•)|(?:\s*\|)|$)', '', s, flags=re.M)
    # 4. "asserted in the test" / "pinned by a test" asides
    s = re.sub(r'\s*\((?:asserted in the test|pinned by a test|and the test[^()]*)\)', '', s)
    # 5. the handful of bare service identifiers left in prose
    for name in SERVICES:
        s = s.replace(name, 'the system')
    # 6. anything still naming a .js file: drop the sentence it sits in, not the whole line
    out = []
    for line in s.split('\n'):
        if '.js' in line:
            parts = re.split(r'(?<=[.!?])\s+', line)
            parts = [p for p in parts if '.js' not in p]
            line = ' '.join(parts)
        out.append(line)
    s = '\n'.join(out)
    # tidy the punctuation the removals leave behind
    s = re.sub(r'\s+([.,;:])', r'\1', s)
    s = re.sub(r'\(\s*\)', '', s)
    s = re.sub(r'[ \t]{2,}', ' ', s)
    s = re.sub(r'\|\s*\.\s*\|', '|  |', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s

src = open(sys.argv[1], encoding='utf-8').read()
out = clean(src)
open(sys.argv[2], 'w', encoding='utf-8').write(out)
left = len(re.findall(r'\.js\b|__tests__', out))
print('%s -> %d bytes, %d code references left' % (sys.argv[2].split('/')[-1], len(out), left))
