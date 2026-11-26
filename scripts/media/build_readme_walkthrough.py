#!/usr/bin/env python3
"""Build the README walkthrough GIF from checked-in native demo captures.

Requires Pillow. Never captures a desktop, changes app state or synthesizes UI.
Every frame is one unchanged capture from docs/images/walkthrough, scaled down,
with a caption bar above it and an outline around the part the caption names.
The captions and outlines are documentation; the screen pixels are the app's.
"""
from pathlib import Path
import hashlib
import json
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'docs/images/walkthrough'
OUT = ROOT / 'docs/media'
CAPTURE = (1680, 1000)
SCALE = 1280 / CAPTURE[0]
BAR = 112
SIZE = (1280, BAR + round(CAPTURE[1] * SCALE))
BG, FG, MUTED, ACCENT = '#101923', '#edf4fa', '#b5c4d2', '#79d1dc'
HOLD, STEP, LAST = 2600, 220, 2200

# Regions are in capture pixels (1680x1000).
SIDEBAR = (4, 384, 470, 668)
SPACES = (4, 384, 470, 872)
# (number, title, lead, [(source, region, kind)]) where kind is 'hold' or 'step'.
SCENES = [
 ('00', 'The whole desk', 'Computers, repositories, spaces, agents, panes and the week in one window.',
  [('desk.png', None, 'hold')]),
 ('01', 'Start from an issue', 'Pick an issue, choose an agent and level, press 작업 시작. The result line says where it went.',
  [('issue-list.png', (458, 200, 898, 668), 'hold'), ('issue-detail.png', (458, 290, 898, 584), 'hold'),
   ('issue-sending.png', (458, 290, 898, 584), 'step'), ('issue-sent.png', (458, 290, 898, 584), 'hold')]),
 ('02', 'Split and hand out the work', 'A spawn adds a placeholder row under its issue; an assignment labels the lead row. Chips show the job.',
  [(f'split-{i}.png', SIDEBAR, 'step') for i in range(1, 6)] + [('split-6.png', SIDEBAR, 'hold')]),
 ('03', 'Four stages, seven states', 'Each row shows its stage bar and state: working, needs you, result to check, cleanup wait, idle, closing.',
  [('desk.png', SPACES, 'hold')]),
 ('04', 'Follow messages', 'Solid lines join spaces on this computer; dashed lines cross to another computer.',
  [(f'messages-{i}.png', (4, 100, 470, 872), 'step') for i in range(1, 6)] + [('messages-6.png', (4, 100, 470, 872), 'hold')]),
 ('05', 'Alerts per space', 'Each space keeps its own Slack, Linear and GitHub alerts, grouped by time in the 알림 tab.',
  [('alerts.png', (458, 205, 898, 666), 'hold')]),
 ('06', 'Requests wait beside the card', 'A tab beside the space opens its requests; a request from another space opens by itself.',
  [('ask-tab.png', (420, 384, 470, 768), 'hold'), ('ask-popup.png', (6, 6, 570, 242), 'hold'),
   ('ask-other-space.png', (6, 6, 570, 242), 'hold')]),
 ('07', 'Review, verdict, acceptance', 'A review request, the reviewer\'s verdict and the owner\'s acceptance are three separate events.',
  [('review-request-1.png', SIDEBAR, 'step'), ('review-request-2.png', SIDEBAR, 'hold'),
   ('verdict-1.png', SIDEBAR, 'step'), ('verdict-2.png', SIDEBAR, 'hold'),
   ('accept-1.png', SIDEBAR, 'step'), ('accept-2.png', SIDEBAR, 'hold')]),
 ('08', 'Push, CI and deploy', 'REPOS shows PUSH, CI and CD per repository; install chips show which computer runs which commit.',
  [('repos-before.png', (4, 132, 426, 326), 'hold'), ('repos-after.png', (4, 132, 426, 326), 'hold')]),
 ('09', 'Cleanup and memory', 'A finished row reports, saves its decisions, proposes memory (기억 제안 badge) and closes.',
  [(f'cleanup-{i}.png', SIDEBAR, 'hold') for i in range(1, 5)]),
 ('10', 'Pane header chips', 'Model, effort, permission, weekly usage, to-dos and running subagents, per pane.',
  [('desk.png', (476, 120, 1676, 164), 'hold')]),
 ('11', 'Find and read documents', 'Search a space\'s documents, or browse them in that space\'s 문서 tab.',
  [('docs-finder.png', (476, 210, 915, 606), 'hold'), ('docs-tab.png', (474, 80, 1676, 996), 'hold')]),
 ('12', 'This week', 'The band lists due issues by day; the timeline opens the week by project.',
  [('desk.png', (472, 0, 1680, 80), 'hold'), ('week.png', (40, 290, 1640, 710), 'hold')]),
]

def font(size, bold=False):
 # Captions quote Korean UI labels, so the font must cover Hangul.
 candidates = [
  Path('C:/Windows/Fonts/malgunbd.ttf' if bold else 'C:/Windows/Fonts/malgun.ttf'),
  Path('/System/Library/Fonts/AppleSDGothicNeo.ttc'),
  Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc' if bold else '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
 ]
 for p in candidates:
  if p.exists(): return ImageFont.truetype(str(p), size)
 return ImageFont.load_default(size=size)

def frame(number, title, lead, source, region):
 im = Image.new('RGB', SIZE, BG); d = ImageDraw.Draw(im)
 d.text((32, 20), f'{number} / {len(SCENES) - 1:02d}', font=font(20, True), fill=ACCENT)
 d.text((112, 16), title, font=font(30, True), fill=FG)
 d.text((32, 64), lead, font=font(20), fill=MUTED)
 d.text((SIZE[0] - 32, 22), 'Native capture · synthetic data', font=font(15), fill=MUTED, anchor='ra')
 screen = Image.open(SRC / source).convert('RGB').resize((SIZE[0], SIZE[1] - BAR), Image.Resampling.LANCZOS)
 im.paste(screen, (0, BAR))
 if region:
  x0, y0, x1, y1 = (round(v * SCALE) for v in region)
  d.rounded_rectangle((x0 - 2, BAR + y0 - 2, x1 + 2, BAR + y1 + 2), radius=6, outline=ACCENT, width=3)
 return im

def palette(images):
 strip = Image.new('RGB', (SIZE[0], SIZE[1] * len(images)))
 for i, im in enumerate(images): strip.paste(im, (0, SIZE[1] * i))
 return strip.resize((SIZE[0] // 2, SIZE[1] * len(images) // 2)).quantize(255, method=Image.Quantize.MEDIANCUT)

def build():
 OUT.mkdir(parents=True, exist_ok=True)
 frames, durations, manifest = [], [], []
 for number, title, lead, shots in SCENES:
  scene_ms, sources = 0, []
  for i, (source, region, kind) in enumerate(shots):
   frames.append(frame(number, title, lead, source, region))
   ms = STEP if kind == 'step' else (LAST if i == len(shots) - 1 and len(shots) > 1 else HOLD)
   durations.append(ms); scene_ms += ms
   path = SRC / source
   sources.append({'source': path.relative_to(ROOT).as_posix(), 'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                   'duration_ms': ms, 'region': list(region) if region else None})
  manifest.append({'step': number, 'title': title, 'duration_ms': scene_ms, 'frames': sources})
 pal = palette(frames[::3])
 gif = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in frames]
 gif[0].save(ROOT / 'preview.gif', save_all=True, append_images=gif[1:], duration=durations, loop=0, optimize=False, disposal=1)
 frames[0].save(OUT / 'workflow-poster.png', optimize=True)
 (OUT / 'workflow-manifest.json').write_text(json.dumps({'schema': 2, 'kind': 'captioned native captures of synthetic demo data',
  'canvas': list(SIZE), 'capture': list(CAPTURE), 'frames': len(frames), 'duration_ms': sum(durations), 'scenes': manifest}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
 print(f'{len(SCENES)} scenes; {len(frames)} frames; {sum(durations) / 1000}s; {(ROOT / "preview.gif").stat().st_size} bytes')

if __name__ == '__main__': build()
