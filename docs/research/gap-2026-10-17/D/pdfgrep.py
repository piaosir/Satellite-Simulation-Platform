import sys, re
from pypdf import PdfReader
path = sys.argv[1]
pats = [re.compile(p, re.I) for p in sys.argv[2:]]
r = PdfReader(path)
sys.stdout.reconfigure(encoding='utf-8')
for i, pg in enumerate(r.pages):
    try:
        t = pg.extract_text() or ''
    except Exception as e:
        continue
    hits = [p.pattern for p in pats if p.search(t)]
    if hits:
        first = t.strip().splitlines()[:3]
        print(f"p{i+1}: {hits} | {' / '.join(x.strip() for x in first)[:160]}")
