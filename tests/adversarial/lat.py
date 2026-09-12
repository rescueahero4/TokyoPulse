import json,time,urllib.request,statistics
BASE="http://localhost:8000"
def t(p):
    t0=time.time()
    with urllib.request.urlopen(BASE+p,timeout=60) as r: r.read()
    return (time.time()-t0)*1000
for p in ["/health","/events.json","/layers.json","/lines.geojson","/stations.geojson","/sandboxes.json","/forecast.json","/brief"]:
    xs=[t(p) for _ in range(5)]
    print(f"{p:22} min={min(xs):8.0f} med={statistics.median(xs):8.0f} max={max(xs):8.0f}")
