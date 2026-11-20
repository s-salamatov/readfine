"""Variant C v2: the f crossbar grows into a feed card (width first, then height, constant corner
radius), the other cards slide in, the feed scrolls by one card, and everything folds back into the
real f. SVG + SMIL only. Writes the inner SVG (without the tile) to variant_c.svgfrag."""
S = __import__('os').path.dirname(__import__('os').path.abspath(__file__))
R = open(f'{S}/glyph_R.txt').read().strip()
F = open(f'{S}/glyph_F.txt').read().strip()
DUR = '4.2s'
EASE = '0.42 0 0.58 1'

# The real crossbar of the f glyph (from icon.svg): x 287.9..386.07, y 229.97..243.14.
BX, BY, BW, BH = 287.9, 229.97, 98.17, 13.17
RX = BH / 2                      # constant corner radius: the card keeps the bar's roundness
CX, CW, CH = 304.0, 112.0, 40.0  # card geometry (right of the R's leg)
MID = BY + BH / 2 - CH / 2       # card centred on the crossbar: 216.555
STEP = CH + 10                   # one card plus gap


def a(attr, pts, add=''):
    """SMIL animate from (time, value) points over the loop, eased between points."""
    if pts[0][0] != 0:
        pts = [(0, pts[0][1])] + pts
    if pts[-1][0] != 1:
        pts = pts + [(1, pts[-1][1])]
    vals = ';'.join(str(v) for _, v in pts)
    kts = ';'.join(f'{t:g}' for t, _ in pts)
    spl = ';'.join([EASE] * (len(pts) - 1))
    return (f'<animate attributeName="{attr}" dur="{DUR}" repeatCount="indefinite" values="{vals}" '
            f'keyTimes="{kts}" calcMode="spline" keySplines="{spl}"{add}/>')


def tr(pts):
    if pts[0][0] != 0:
        pts = [(0, pts[0][1])] + pts
    if pts[-1][0] != 1:
        pts = pts + [(1, pts[-1][1])]
    vals = ';'.join(v for _, v in pts)
    kts = ';'.join(f'{t:g}' for t, _ in pts)
    spl = ';'.join([EASE] * (len(pts) - 1))
    return (f'<animateTransform attributeName="transform" type="translate" dur="{DUR}" repeatCount="indefinite" '
            f'values="{vals}" keyTimes="{kts}" calcMode="spline" keySplines="{spl}"/>')


def content(y, op):
    """Title bar and one text line inside a card at local y; fades through op points."""
    return (f'<g opacity="0">{a("opacity", op)}'
            f'<rect x="{CX + 12}" y="{y + 11}" width="60" height="8" rx="4" fill="#3b82f6" opacity=".6"/>'
            f'<rect x="{CX + 12}" y="{y + 25}" width="82" height="6" rx="3" fill="#3b82f6" opacity=".32"/></g>')


def card(y, op, move):
    return (f'<g opacity="0">{a("opacity", op)}{tr(move)}'
            f'<rect x="{CX}" y="{y}" width="{CW}" height="{CH}" rx="{RX:.2f}" fill="#fff"/>'
            f'{content(y, [(0, 1)])}</g>')


# Timeline (fractions of 4.2 s):
#  0.00-0.06 static mark | 0.06-0.18 stem and hook fade, bar widens | 0.14-0.30 bar grows in height
#  0.28-0.34 card text appears | 0.34-0.46 neighbour cards slide in | 0.48-0.62 feed scrolls one card
#  0.64-0.72 cards leave, text fades | 0.70-0.78 centre card loses height | 0.76-0.86 then width
#  0.82-0.92 stem and hook return | 0.92-0.95 hand back to the real glyph | 0.95-1.00 static mark
real_f = f'<path d="{F}" fill="#fff">{a("opacity", [(0.06, 1), (0.18, 0), (0.82, 0), (0.92, 1)])}</path>'

# B: the crossbar itself, growing into the first card. Starts exactly on the glyph's bar.
grow = (f'<rect rx="{RX:.2f}" fill="#fff" x="{BX}" y="{BY}" width="{BW}" height="{BH}">'
        + a('x', [(0.06, BX), (0.18, CX), (0.975, CX), (0.985, BX)]) + a('width', [(0.06, BW), (0.18, CW), (0.975, CW), (0.985, BW)])
        + a('y', [(0.14, BY), (0.30, MID), (0.975, MID), (0.985, BY)]) + a('height', [(0.14, BH), (0.30, CH), (0.975, CH), (0.985, BH)])
        + a('opacity', [(0.64, 1), (0.72, 0), (0.999, 0), (1, 1)]) + '</rect>'
        + content(MID, [(0.28, 0), (0.34, 1), (0.64, 1), (0.70, 0)]))

# The neighbours: the top card slides down into place, the bottom one slides up.
top = card(MID - STEP, [(0.34, 0), (0.44, 1), (0.50, 1), (0.60, 0)], [(0.34, '0 -18'), (0.46, '0 0')])
# The bottom card becomes the centre card after the scroll and is the one that folds back.
bot_y = MID + STEP
bot = (f'<g opacity="0">{a("opacity", [(0.36, 0), (0.46, 1), (0.92, 1), (0.95, 0)])}{tr([(0.36, "0 18"), (0.46, "0 0")])}'
       f'<rect rx="{RX:.2f}" fill="#fff" x="{CX}" y="{bot_y}" width="{CW}" height="{CH}">'
       + a('y', [(0.70, bot_y), (0.78, BY + STEP)]) + a('height', [(0.70, CH), (0.78, BH)])
       + a('x', [(0.76, CX), (0.86, BX)]) + a('width', [(0.76, CW), (0.86, BW)])
       + '</rect>' + content(bot_y, [(0.64, 1), (0.69, 0)]) + '</g>')
fourth = card(MID + 2 * STEP, [(0.50, 0), (0.62, 1), (0.64, 1), (0.72, 0)], [(0.64, '0 0'), (0.72, '0 18')])

# The whole feed scrolls by one card; it is reset only at the loop end, when only the real glyph shows.
feed = (f'<g>{tr([(0.48, "0 0"), (0.62, f"0 {-STEP}"), (0.999, f"0 {-STEP}"), (1, "0 0")])}'
        + grow + top + bot + fourth + '</g>')

svg = f'<path d="{R}" fill="#fff"/>' + real_f + feed
open(f'{S}/variant_c.svgfrag', 'w', encoding='utf-8').write(svg)
print('ok', len(svg), round(MID, 2))
