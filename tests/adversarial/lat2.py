import time,urllib.request,statistics,socket
def run(base,label):
    print("==",label,base)
    for p in ["/health","/events.json","/layers.json","/lines.geojson","/stations.geojson","/sandboxes.json","/forecast.json","/brief","/impact/Toei-Mita"]:
        xs=[]; hdr=None
        for _ in range(5):
            t0=time.time()
            with urllib.request.urlopen(base+p,timeout=60) as r:
                n=len(r.read()); hdr=(r.headers.get("X-Cache"),r.headers.get("Age"))
            xs.append((time.time()-t0)*1000)
        print(f"  {p:22} {n/1024:8.1f}KiB min={min(xs):7.0f} med={statistics.median(xs):7.0f} max={max(xs):7.0f}  X-Cache={hdr}")
run("http://127.0.0.1:8000","IPv4 literal")
run("http://localhost:8000","localhost name")
