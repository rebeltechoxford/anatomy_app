"""Convert a stage-1/2 .npz mesh cache into the raw bundle read by build-tiers.mjs."""
import sys, json
import numpy as np
src, out = sys.argv[1:3]
d = np.load(src)
json.dump({'counts': d['counts'].tolist()}, open(out + '.json', 'w'))
d['v'].astype(np.float32).tofile(out + '.v.bin')
d['f'].astype(np.uint32).tofile(out + '.f.bin')
