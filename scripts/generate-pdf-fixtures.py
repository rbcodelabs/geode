"""Generate fictional, deterministic PDF viewer fixtures; optional development tool (Pillow).

No production dependency: generated PDF bytes are committed. Image fixtures are
small checkerboards built here, never downloaded documents or personal data.
"""
from pathlib import Path
from io import BytesIO
import struct
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / 'tests/fixtures/pdf'
ROOT.mkdir(parents=True, exist_ok=True)
def write(name, objects):
    result = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'); offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(result)); result.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(result); result.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]: result.extend(f'{offset:010} 00000 n \n'.encode())
    result.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()); (ROOT/name).write_bytes(result)
def stream(data, props=b''):
    return b'<< /Length ' + str(len(data)).encode() + b' ' + props + b' >>\nstream\n' + data + b'\nendstream'

def basic(name, content, resources=b'<< /Font << /F1 4 0 R >> >>', extra=None):
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ' + resources + b' /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream(content)]
    if extra: objects.extend(extra)
    write(name,objects)

objects=[b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
for number, heading in enumerate(['Trail preparation', 'Navigation basics', 'Field observations'],1):
    content=f'0.13 0.29 0.24 rg 48 690 516 54 re f 1 1 1 rg BT /F1 24 Tf 64 708 Td (Field Guide - {heading}) Tj ET 0 0 0 rg BT /F1 16 Tf 64 650 Td (Synthetic page {number} of 3. Select this text.) Tj ET'.encode()
    objects.extend([b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents '+str(3+number*2).encode()+b' 0 R >>',stream(content)])
write('FieldGuide.pdf', objects)
basic('CMYK.pdf', b'0.2 0.8 0.3 0 k 64 560 240 140 re f BT /F1 18 Tf 64 730 Td (Synthetic CMYK color fixture) Tj ET')
image=Image.new('RGB',(32,32))
for y in range(32):
    for x in range(32): image.putpixel((x,y), (24,118,86) if (x//8+y//8)%2 else (245,203,82))
encoded=BytesIO(); image.save(encoded,format='JPEG2000',irreversible=False)
basic('JPX.pdf',b'q 256 0 0 256 64 400 cm /Im1 Do Q',b'<< /XObject << /Im1 6 0 R >> >>',[stream(encoded.getvalue(),b'/Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode')])
mono=image.convert('1'); encoded=BytesIO();mono.save(encoded,format='TIFF',compression='group4');tiff=encoded.getvalue();info=Image.open(BytesIO(tiff));offsets=info.tag_v2[273];counts=info.tag_v2[279];mmr=b''.join(tiff[o:o+c] for o,c in zip(offsets,counts))
def segment(number, kind, page, data): return struct.pack('>IBBBI',number,kind,0,page,len(data))+data
jbig2=segment(1,48,1,struct.pack('>IIIIBH',32,32,0,0,0,0))+segment(2,38,1,struct.pack('>IIIIBB',32,32,0,0,0,1)+mmr)
basic('JBIG2.pdf',b'q 256 0 0 256 64 400 cm /Im1 Do Q',b'<< /XObject << /Im1 6 0 R >> >>',[stream(jbig2,b'/Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode')])
# Predefined CMap triggers packaged bcmap loading; no external font or URI.
font=b'<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticCID /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>'
# Rebuild instead of rewriting bytes, to preserve valid offsets.
write('CMap.pdf',[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',font,stream(b'BT /F1 24 Tf 64 700 Td <00410042> Tj ET'),b'<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 >>',b'<< /Type /FontDescriptor /FontName /SyntheticCID /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>'])
print('Generated five fictional PDFs in',ROOT)
