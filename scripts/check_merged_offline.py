import sys, tempfile, os, time
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from astropy.wcs import WCS
sys.path.insert(0,str(Path.cwd()/'backend'))
from app import main,batches
from app.adapters.spherex import SpherexAdapter,SpherexObservation
Path('.cache').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir='.cache') as d:
 os.environ['SKYFLIP_OBSERVATIONS_DB']=str(Path(d)/'db.sqlite'); main.cache_root=lambda:Path(d)
 w=WCS(naxis=2); w.wcs.crpix=[5,5]; w.wcs.cdelt=[-.001,.001]; w.wcs.crval=[133.795,-7.245]; w.wcs.ctype=['RA---TAN','DEC--TAN']
 obs=[SpherexObservation(obs_id=f'o{i}',bandpass='SPHEREx-D1',detector=1,mjd=60000+i,access_url=f'https://irsa.ipac.caltech.edu/ibe/data/spherex/o{i}.fits',cutout_url=f'https://irsa.ipac.caltech.edu/ibe/data/spherex/o{i}.fits',collection='spherex_dr1') for i in range(22)]
 SpherexAdapter.find_observations=lambda *a,**k:obs
 def fetch(self,o,**kw):
  if o.obs_id=='o2': raise ValueError('simulated image failure')
  return SimpleNamespace(image=np.arange(100).reshape(10,10),wcs=w,flag_summary={},central_wavelength_um=1.0,header_meta={})
 SpherexAdapter.fetch_cutout=fetch; main._ensure_frame_pyramid=lambda *a,**kw:{'shape':[2048,2048],'wcs':{},'stats':{}}
 for mode in ['target_crop','full_frame']:
  b=batches.create_batch(batches.BatchRequest(ra=133.795,dec=-7.245,fov=.1,view_mode=mode,idempotency_key='direct-test-'+mode))
  for i in range(200):
   b=batches.get_batch(b['batch_id'])
   if b['status'] not in ('queued','running'): break
   time.sleep(.05)
  assert b['status']=='ready' and b['image_count']==10,b
  assert [f['mjd'] for f in b['data']['frames']]==sorted(f['mjd'] for f in b['data']['frames'])
  assert batches.get_batch(b['batch_id'])['data']==b['data']
  print(mode,b['status'],b['image_count'],'failures',len(b['failures']))
  from app.observations.schema import ObservationCreate
  from app.observations.service import submit_observation
  from app.observations.db import connect
  frames=b['data']['frames'][:2]
  report=ObservationCreate(**{'idempotency_key':'report-test-'+mode,'description':'A faint point moved between the frames.','context':{'ra':133.795,'dec':-7.245,'batch_id':b['batch_id'],'image_mode':mode},'frames':frames,'highlights':[{'epoch_id':f['epoch_id'],'pixel':{'x0':1,'y0':1,'x1':3,'y1':3}} for f in frames],'answers':{'direction':'not_sure','confidence':3},'form_ms':5000})
  result=submit_observation(report,client_raw_key='test')
  assert result['ok'],result
  with closing(connect()) as conn:
   row=conn.execute('select payload_json from observation_submissions where submission_id=?',(result['submission_id'],)).fetchone()
   assert b['batch_id'] in row[0]
  print('report persisted',mode)
print('Batch assertions and database cleanup passed')
