import sys
from pypdf import PdfReader
src = sys.argv[1]; out = sys.argv[2]
r = PdfReader(src)
with open(out, 'w', encoding='utf-8') as f:
    for i, p in enumerate(r.pages):
        try:
            t = p.extract_text() or ''
        except Exception as e:
            t = '<<err %s>>' % e
        f.write('\n\n=====PAGE %d=====\n' % (i + 1))
        f.write(t)
print(len(r.pages))
