"""Decode a Goodnotes page's ink straight from the share API and write it as SVG.

    python3 decode.py https://web.goodnotes.com/s/<alias> <page> out.svg

Read only. See PROTOCOL.md for the format.
"""
import json, struct, sys, urllib.request

API = 'https://api.goodnotes.com'
HEADERS = {'Accept': 'application/protobuf', 'Content-Type': 'application/protobuf', 'Origin': 'https://web.goodnotes.com'}


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i


def fields(b):
    """Protobuf message -> {field: last value} (enough here, no repeated fields are used at this level)."""
    i, out = 0, {}
    while i < len(b):
        k, i = varint(b, i); f, t = k >> 3, k & 7
        if t == 0: v, i = varint(b, i)
        elif t == 1: v = b[i:i + 8]; i += 8
        elif t == 5: v = b[i:i + 4]; i += 4
        elif t == 2: n, i = varint(b, i); v = b[i:i + n]; i += n
        else: raise ValueError(f'wire type {t}')
        out[f] = v
    return out


def delimited(b):
    i, out = 0, []
    while i < len(b):
        n, i = varint(b, i); out.append(b[i:i + n]); i += n
    return out


def lz4_block(src, n):
    dst, i = bytearray(), 0
    while i < len(src):
        tok = src[i]; i += 1
        L = tok >> 4
        if L == 15:
            while True:
                c = src[i]; i += 1; L += c
                if c != 255: break
        dst += src[i:i + L]; i += L
        if i >= len(src): break
        off = src[i] | src[i + 1] << 8; i += 2
        M = tok & 15
        if M == 15:
            while True:
                c = src[i]; i += 1; M += c
                if c != 255: break
        for _ in range(M + 4): dst.append(dst[-off])
    assert len(dst) == n
    return bytes(dst)


def apple_lz4(b):
    """Apple compression_lz4 stream: 'bv41' raw_size csize block | 'bv4-' size raw ... 'bv4$'."""
    out, i = bytearray(), 0
    while (magic := b[i:i + 4]) != b'bv4$':
        if magic == b'bv41':
            n, c = struct.unpack_from('<II', b, i + 4); out += lz4_block(b[i + 12:i + 12 + c], n); i += 12 + c
        elif magic == b'bv4-':
            n, = struct.unpack_from('<I', b, i + 4); out += b[i + 8:i + 8 + n]; i += 8 + n
        else: raise ValueError(magic)
    return bytes(out)


def tpl(d):
    """'tpl\\0' u32 len, type signature\\0, values. v=u16, u/f=f32, A(x)=u32 count + items, S(..)=struct."""
    assert d[:4] == b'tpl\0'
    end = d.index(b'\0', 8); sig = d[8:end].decode(); pos = end + 1

    def node(k):
        if sig[k] in 'vuf': return sig[k], k + 1
        kind, k, kids = sig[k], k + 2, []
        while sig[k] != ')': n, k = node(k); kids.append(n)
        return (kind, kids), k + 1

    def read(n):
        nonlocal pos
        if n == 'v': pos += 2; return struct.unpack_from('<H', d, pos - 2)[0]
        if n in ('u', 'f'): pos += 4; return struct.unpack_from('<f', d, pos - 4)[0]
        kind, kids = n
        if kind == 'S': return [read(x) for x in kids]
        pos += 4
        return [read(kids[0]) for _ in range(struct.unpack_from('<I', d, pos - 4)[0])]

    k, out = 0, []
    while k < len(sig): n, k = node(k); out.append(read(n))
    assert pos == len(d)
    return sig, out


def f32(b): return struct.unpack('<f', b)[0]


def page_svg(link, page):
    alias = link.rstrip('/').split('/')[-1]
    doc = json.load(urllib.request.urlopen(f'{API}/v3/documents/{alias}'))['document']
    p = doc['pages'][doc['pageIds'][page - 1]]
    w, h = p['dimension']['width'], p['dimension']['height']
    req = urllib.request.Request(
        f"{API}/v3/document/{alias}/getNotes/{p['groupId'].upper()}?documentToken={doc['documentToken']}",
        data=bytes([0x10, 0x90, 0x4e]), headers=HEADERS)  # {2: 10000} = page size
    # ponytail: no pagination; a page with more than 10000 items would need the cursor ({3: ...} message) sent back.
    paths = []
    for msg in delimited(urllib.request.urlopen(req).read()):
        item = fields(msg).get(1)
        if not item: continue  # cursor message
        content = fields(fields(item).get(2, b''))
        if 7 not in content: continue  # only ink for now; 1 = image/box
        s = fields(content[7])
        sig, v = tpl(apple_lz4(s[2]))
        if not sig.startswith('vuA(v)A(S(uu))A(S(uuuu))'): continue
        width, (x0, y0), segs = v[1], v[3][0], v[4]
        off = fields(s[6]) if s.get(6) else {}
        dx, dy = f32(off.get(1, bytes(4))), f32(off.get(2, bytes(4)))
        r, g, b, a = (f32(x) for x in fields(s[4]).values())
        d = f'M{x0:.2f} {y0:.2f}' + ''.join(f'Q{cx:.2f} {cy:.2f} {x:.2f} {y:.2f}' for cx, cy, x, y in segs)
        paths.append(f'<path d="{d}" transform="translate({dx:.2f} {dy:.2f})" stroke="rgb({r*255:.0f},{g*255:.0f},{b*255:.0f})" '
                     f'stroke-opacity="{a:.3f}" stroke-width="{width:.2f}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
            f'<rect width="100%" height="100%" fill="#2d2d2d"/><g fill="none" stroke-linecap="round" stroke-linejoin="round">'
            + ''.join(paths) + '</g></svg>')


if __name__ == '__main__':
    open(sys.argv[3], 'w').write(page_svg(sys.argv[1], int(sys.argv[2])))
