import sys,tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path.cwd()/'backend'))
from app import main, frame_pyramid as p
Path('.cache').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir='.cache') as d:
 root=Path(d); main.cache_root=lambda:root
 image=np.arange(1500*1500,dtype=np.float32).reshape(1500,1500)
 meta=p.PyramidMeta(obs_id='test',detector=1,shape=image.shape,tile_size=256,n_levels=4,subtract_zodi=False,bunit='MJy/sr',source_url='',mjd=60000,time_iso='',bandpass='',wcs_header={},stats={})
 p.write_pyramid(root,obs_id='test',detector=1,image=image,flags=np.zeros(image.shape,dtype=np.int32),subtract_zodi=False,meta=meta)
 response=main.full_frame_preview('test',1,False)
 assert response.body[:8]==b'\x89PNG\r\n\x1a\n'
 print('Full-frame preview PNG generated from cached synthetic pixels')
