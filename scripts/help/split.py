# Split a converted guide into one help topic per H2 (or per H1 with no H2),
# each with front matter the corpus loader reads. Mechanical: the titles and the
# numbering come from the document, so a re-run after the guides are corrected
# reproduces the same files.
import sys, os, re, json

def slug(s):
    s = re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
    return re.sub(r'-{2,}', '-', s)[:60]

def sections(md):
    """[(level, number, title, body)] in document order, H1 and H2 only."""
    lines = md.split('\n')
    marks = []
    for i, l in enumerate(lines):
        m = re.match(r'^(#{1,2}) +(.*)$', l)
        if m:
            marks.append((i, len(m.group(1)), m.group(2).strip()))
    out = []
    for idx, (i, lvl, title) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(lines)
        num = ''
        m = re.match(r'^((?:\d+\.?)+|Appendix [A-Z]\.?)\s+(.*)$', title)
        if m:
            num, title = m.group(1).rstrip('.'), m.group(2)
        body = '\n'.join(lines[i + 1:end]).strip()
        # an H1 that only introduces H2s carries no body of its own
        has_child = idx + 1 < len(marks) and marks[idx + 1][1] > lvl
        out.append({'level': lvl, 'num': num, 'title': title, 'body': body,
                    'has_child': has_child})
    return out

def main():
    src, prefix, outdir, metafile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    meta = json.load(open(metafile, encoding='utf-8'))
    drop = set(meta.get('drop', []))
    extra = meta.get('sections', {})
    md = open(src, encoding='utf-8').read()
    os.makedirs(outdir, exist_ok=True)
    written, skipped = [], []
    for s in sections(md):
        key = s['num'] or s['title']
        if key in drop or any(key.startswith(d + '.') for d in drop):
            skipped.append(key)
            continue
        if s['has_child'] and len(s['body']) < 400:
            skipped.append(key + ' (container)')
            continue
        if len(s['body']) < 120:
            skipped.append(key + ' (too short)')
            continue
        info = extra.get(key, {})
        name = '%s-%s-%s.md' % (prefix, (s['num'] or '0').replace('.', '-'), slug(s['title']))
        fm = ['---', 'title: %s' % json.dumps(s['title']),
              'audience: %s' % info.get('audience', 'client'),
              'source: %s %s' % (meta['source'], key)]
        if info.get('screens'):
            fm.append('screens: [%s]' % ', '.join(json.dumps(x) for x in info['screens']))
        if info.get('questions'):
            fm.append('questions:')
            fm += ['  - %s' % json.dumps(q) for q in info['questions']]
        if info.get('review'):
            fm.append('review: %s' % json.dumps(info['review']))
        fm.append('---')
        open(os.path.join(outdir, name), 'w', encoding='utf-8').write(
            '\n'.join(fm) + '\n\n# ' + s['title'] + '\n\n' + s['body'] + '\n')
        written.append(name)
    print('%s: %d topics written, %d skipped' % (prefix, len(written), len(skipped)))
    for k in skipped:
        print('   skipped: %s' % k)

main()
