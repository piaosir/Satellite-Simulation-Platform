import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
a = int(sys.argv[2]) if len(sys.argv) > 2 else 1
b = int(sys.argv[3]) if len(sys.argv) > 3 else len(r.pages)
out = []
for i in range(a-1, min(b, len(r.pages))):
    out.append(f"===== page {i+1} =====\n" + (r.pages[i].extract_text() or ''))
sys.stdout.reconfigure(encoding='utf-8')
print("\n".join(out))
