import sys, re
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

def numfmt_map(doc):
    """numId -> {ilvl: numFmt}"""
    out = {}
    try:
        npart = doc.part.numbering_part.element
    except Exception:
        return out
    abst = {}
    for an in npart.findall(W + 'abstractNum'):
        aid = an.get(W + 'abstractNumId')
        lv = {}
        for l in an.findall(W + 'lvl'):
            f = l.find(W + 'numFmt')
            lv[l.get(W + 'ilvl')] = f.get(W + 'val') if f is not None else 'bullet'
        abst[aid] = lv
    for n in npart.findall(W + 'num'):
        nid = n.get(W + 'numId')
        a = n.find(W + 'abstractNumId')
        if a is not None:
            out[nid] = abst.get(a.get(W + 'val'), {})
    return out

DROP_B = False
DROP_I = False

def measure(doc):
    """Word documents often style ALL body text bold or italic. If a mark covers most of
    the text it is page styling, not emphasis, so drop it rather than emit noise."""
    global DROP_B, DROP_I
    tot = b = i = 0
    for t in doc.element.body.iter(W + 't'):
        n = len(t.text or '')
        if not n:
            continue
        tot += n
        rpr = t.getparent().find(W + 'rPr')
        if rpr is not None:
            if rpr.find(W + 'b') is not None:
                b += n
            if rpr.find(W + 'i') is not None:
                i += n
    if tot:
        DROP_B = b / tot > 0.5
        DROP_I = i / tot > 0.5
    return {'chars': tot, 'bold': b, 'italic': i, 'drop_b': DROP_B, 'drop_i': DROP_I}

def esc(t):
    return t.replace('|', '\|')

def runs_md(p, rels):
    """Inline markdown for a paragraph, honouring bold/italic and hyperlinks."""
    parts = []
    for child in p._p.iter():
        tag = child.tag
        if tag == W + 'hyperlink':
            txt = ''.join(n.text or '' for n in child.iter(W + 't'))
            rid = child.get(R + 'id')
            url = ''
            if rid and rid in rels:
                url = rels[rid]._target if hasattr(rels[rid], '_target') else ''
            parts.append('[%s](%s)' % (txt, url) if url and txt else txt)
            for n in child.iter(W + 't'):
                n.text = ''
        elif tag == W + 't':
            txt = child.text or ''
            if not txt:
                continue
            rpr = child.getparent().find(W + 'rPr')
            b = i = False
            if rpr is not None:
                b = rpr.find(W + 'b') is not None and not DROP_B
                i = rpr.find(W + 'i') is not None and not DROP_I
            if txt.strip():
                lead = txt[:len(txt) - len(txt.lstrip())]
                trail = txt[len(txt.rstrip()):]
                core = txt.strip()
                if b:
                    core = '**%s**' % core
                if i:
                    core = '*%s*' % core
                txt = lead + core + trail
            parts.append(txt)
        elif tag == W + 'br':
            parts.append('  \n')
        elif tag == W + 'tab':
            parts.append(' ')
    s = ''.join(parts)
    return re.sub(r'[ \t]+', ' ', s).strip()

def table_md(tbl, rels):
    rows = []
    for tr in tbl.rows:
        cells = []
        for tc in tr.cells:
            txt = ' '.join(runs_md(p, rels) for p in tc.paragraphs if runs_md(p, rels))
            cells.append(esc(txt).replace('\n', ' ').strip() or ' ')
        rows.append(cells)
    if not rows:
        return ''
    width = max(len(r) for r in rows)
    rows = [r + [' '] * (width - len(r)) for r in rows]
    # drop a fully-empty leading row
    out = ['| ' + ' | '.join(rows[0]) + ' |', '|' + '---|' * width]
    for r in rows[1:]:
        out.append('| ' + ' | '.join(r) + ' |')
    return '\n'.join(out)

def convert(path):
    doc = Document(path)
    rels = doc.part.rels
    nfmt = numfmt_map(doc)
    stats = measure(doc)
    print('  emphasis:', stats, file=sys.stderr)
    body = doc.element.body
    md, seen_title = [], False
    for el in body.iterchildren():
        if el.tag == W + 'p':
            p = Paragraph(el, doc)
            text = runs_md(p, rels)
            style = (p.style.name or '') if p.style is not None else ''
            if not text:
                continue
            m = re.match(r'^Heading (\d)$', style)
            if style == 'Title' and not seen_title:
                md.append('# ' + text); seen_title = True; continue
            if m:
                md.append('#' * min(int(m.group(1)) + (0 if seen_title else 0), 6) + ' ' + text)
                continue
            npr = el.find(W + 'pPr/' + W + 'numPr') if el.find(W + 'pPr') is not None else None
            if npr is not None:
                ilvl = npr.find(W + 'ilvl')
                numid = npr.find(W + 'numId')
                lvl = ilvl.get(W + 'val') if ilvl is not None else '0'
                nid = numid.get(W + 'val') if numid is not None else None
                fmt = nfmt.get(nid, {}).get(lvl, 'bullet')
                bullet = '-' if fmt == 'bullet' else '1.'
                md.append('  ' * int(lvl) + bullet + ' ' + text)
                continue
            md.append(text)
        elif el.tag == W + 'tbl':
            t = table_md(Table(el, doc), rels)
            if t:
                md.append(t)
    # one blank line between blocks, collapse runs of blanks
    txt = '\n\n'.join(md)
    return re.sub(r'\n{3,}', '\n\n', txt).strip() + '\n'

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    out = convert(sys.argv[1])
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        f.write(out)
    print('%s -> %s (%d bytes, %d lines)' % (sys.argv[1].split('/')[-1], sys.argv[2].split('/')[-1], len(out), out.count('\n')))
