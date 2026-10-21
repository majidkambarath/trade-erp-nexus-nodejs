import sys, re

def unwrap_once(s):
    """Strip a wrap that encloses the WHOLE string: ***x***, **x**, *x*."""
    s = s.strip()
    for n in (3, 2, 1):
        m = '*' * n
        if len(s) > 2 * n and s.startswith(m) and s.endswith(m):
            inner = s[n:-n]
            # only if the marker does not reappear inside (i.e. it really is one span)
            if m not in inner:
                return inner.strip()
    return s

def unwrap(s):
    prev = None
    while prev != s:
        prev, s = s, unwrap_once(s)
    return s

def line(l):
    if not l.strip():
        return l
    # table row: unwrap each cell
    if l.startswith('|') and l.rstrip().endswith('|') and '---|' not in l:
        cells = l.strip().strip('|').split('|')
        return '| ' + ' | '.join(unwrap(c) or ' ' for c in cells) + ' |'
    # heading / list prefix preserved
    m = re.match(r'^(\s*(?:#{1,6} |[-*] |\d+\.\s))(.*)$', l)
    if m:
        return m.group(1) + unwrap(m.group(2))
    return unwrap(l)

src = open(sys.argv[1], encoding='utf-8').read()
out = '\n'.join(line(l) for l in src.split('\n'))
# a bold step number left stranded on its own ("1." then text) is joined by the walker already
open(sys.argv[2], 'w', encoding='utf-8').write(out)
b = out.count('***')
print('%s: %d bytes, %d stray *** left' % (sys.argv[2].split('/')[-1], len(out), b))
