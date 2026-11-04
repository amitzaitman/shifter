import re, pathlib
root = pathlib.Path(__file__).parent
app = (root/'app.html').read_text()
eng = (root/'engine.js').read_text()
# build stamp (Israel time), shown at the bottom of the settings screen so you can tell which version is loaded
import datetime, zoneinfo
stamp = datetime.datetime.now(zoneinfo.ZoneInfo('Asia/Jerusalem')).strftime('%d.%m.%Y %H:%M')
page = app.replace('/*ENGINE*/', eng).replace('__BUILD__', stamp)
out = root/'dist'; out.mkdir(exist_ok=True)
(out/'shift-coach.html').write_text(page)
# hosted version: full document for GitHub Pages / any HTTPS host
i = page.index('<div id="app"')
head, body = page[:i], page[i:]
head = head.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
reset = ('<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
         'body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>')
doc = ('<!doctype html>\n<html lang="he" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
       '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="theme-color" content="#0b0e10">\n'
       + reset + '\n' + head + '</head>\n<body>\n' + body + '\n</body>\n</html>\n')
(root/'index.html').write_text(doc)  # GitHub Pages serves this from the repo root
print(len(page), len(doc))
