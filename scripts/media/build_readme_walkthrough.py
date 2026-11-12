#!/usr/bin/env python3
"""Build an editorial walkthrough from checked-in native demo captures.

Requires Pillow. Never captures a desktop, changes app state or synthesizes UI.
Source screenshots remain unchanged; text beside them is documentation.
"""
from pathlib import Path
import hashlib
import json
import textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/media'
SIZE = (1280, 1000)
BG, FG, MUTED, ACCENT = '#101923', '#edf4fa', '#b5c4d2', '#79d1dc'
SCENES = [
 ('01', 'Choose the project', 'issues-milestone.png',
  'Start with the issue and its context.',
  ['Inspect project issues, milestones and supplied progress.', 'Cached data is labelled; missing data is not a completed task.'],
  'The optional producer owns issue data and refresh.'),
 ('02', 'Delegate the work', 'event-dispatch-existing.png',
  'Follow allocation to a worker.',
  ['An allocation event highlights the target agent.', 'Existing workers and new sessions have distinct event states.'],
  'The harness allocates work. The theme displays its feed.'),
 ('03', 'Work in parallel', 'tree-expanded.png',
  'Keep parent and child work together.',
  ['Expand independent work beneath its parent.', 'Task titles, issue groups and worker states remain visible.'],
  'A rendered tree is not proof of automatic task splitting.'),
 ('04', 'Follow messages', 'local-message.png',
  'See the direction of an observed send.',
  ['Sender and recipient anchors define the route.', 'Message travel and arrival are different from task completion.'],
  'Native send events require a compatible app/core build.'),
 ('05', 'Request a review', 'event-review_request.png',
  'Show the handoff to a reviewer.',
  ['Review requests are separate from ordinary messages.', 'Work stays attached to its project and issue.'],
  'The reviewer produces the verdict; the theme does not infer it.'),
 ('06', 'Inspect the result', 'event-verdict.png',
  'Distinguish review from acceptance.',
  ['A verdict is its own event.', 'Acceptance, delivery ACK and successful work are separate facts.'],
  'PASS in this demo is supplied fixture data, not a live review.'),
 ('07', 'Accept the report', 'event-accept.png',
  'Let the owner confirm the result.',
  ['Acceptance is shown independently of the verdict.', 'Remaining work and decision waits stay with the task.'],
  'A finished response alone must not mean the task succeeded.'),
 ('08', 'Preserve the context', 'closing-memory-2.png',
  'Show the saved-result stage.',
  ['Cleanup progresses through reporting and retained context.', 'Stored outcomes may include HOLD, failure and remaining work.'],
  'The harness owns storage and policy; this is a rendered state.'),
 ('09', 'Finish the lifecycle', 'closing-memory-4-hidden.png',
  'Remove the closed row from the sidebar.',
  ['Closed work no longer fills the active list.', 'Pinned spaces and active work follow the producer policy.'],
  'This fixture shows row removal, not a live terminal-kill test.'),
]

def font(size, bold=False):
 candidates = [
  Path('/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf'),
  Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
  Path('C:/Windows/Fonts/arialbd.ttf' if bold else 'C:/Windows/Fonts/arial.ttf'),
 ]
 for p in candidates:
  if p.exists(): return ImageFont.truetype(str(p), size)
 return ImageFont.load_default(size=size)

def wrapped(draw, text, xy, width=41, size=26, color=FG):
 x,y=xy
 for line in textwrap.wrap(text, width=width):
  draw.text((x,y),line,font=font(size),fill=color);y+=size+12
 return y

def slide(scene):
 number,title,name,lead,points,note=scene
 im=Image.new('RGB',SIZE,BG);d=ImageDraw.Draw(im)
 d.text((56,48),'HERDR THEME / WORKFLOW WALKTHROUGH',font=font(17,True),fill=ACCENT)
 d.text((56,132),number+' / 09',font=font(24,True),fill=ACCENT)
 d.text((56,192),title,font=font(44,True),fill=FG)
 y=wrapped(d,lead,(56,280),size=29)
 for point in points:
  y=wrapped(d,point,(72,y+48),width=36,size=25,color=MUTED)
 y=wrapped(d,note,(56,730),width=46,size=20,color=ACCENT)
 d.text((56,918),'Native demo capture + editorial captions',font=font(18),fill=MUTED)
 d.text((56,947),'Synthetic data. Not a continuous live E2E recording.',font=font(17),fill=MUTED)
 path=ROOT/'docs/images/panel-feed'/name
 screen=Image.open(path).convert('RGB')
 screen.thumbnail((510,880),Image.Resampling.LANCZOS)
 x=SIZE[0]-56-screen.width;y=56
 im.paste(screen,(x,y))
 return im,path

def build():
 OUT.mkdir(parents=True,exist_ok=True)
 frames=[];durations=[];manifest=[]
 overview_path=ROOT/'docs/images/overview-native.gif'
 overview=Image.open(overview_path)
 intro_ms=0
 for i in range(min(34,overview.n_frames)):
  overview.seek(i)
  frame=Image.new('RGB',SIZE,BG);d=ImageDraw.Draw(frame)
  d.text((48,36),'HERDR THEME / NATIVE DEMO',font=font(28,True),fill=ACCENT)
  d.text((48,90),'Watch the workspace, then follow nine workflow chapters.',font=font(24),fill=FG)
  frame.paste(overview.convert('RGB'),(0,160))
  d.text((48,960),'Synthetic data. Workflow chapters use separate native captures.',font=font(18),fill=MUTED)
  duration=overview.info.get('duration',150)
  frames.append(frame);durations.append(duration);intro_ms+=duration
 poster=None
 for scene in SCENES:
  im,path=slide(scene);frames.append(im);durations.append(4500)
  if poster is None:poster=im
  manifest.append({'step':scene[0],'title':scene[1],'source':str(path.relative_to(ROOT)),
                   'source_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'duration_ms':4500})
 frames[0].save(ROOT/'preview.gif',save_all=True,append_images=frames[1:],duration=durations,
                loop=0,optimize=True,disposal=2)
 poster.save(OUT/'workflow-poster.png')
 (OUT/'workflow-manifest.json').write_text(json.dumps({'schema':1,'kind':'editorial walkthrough of native fixtures',
  'canvas':SIZE,'duration_ms':sum(durations),'intro':{'source':str(overview_path.relative_to(ROOT)),'frames':34,'duration_ms':intro_ms,'source_sha256':hashlib.sha256(overview_path.read_bytes()).hexdigest()},'scenes':manifest},indent=2)+'\n')
 print(f'{len(SCENES)} chapters; {sum(durations)/1000}s; {(ROOT/"preview.gif").stat().st_size} bytes')

if __name__=='__main__':build()
