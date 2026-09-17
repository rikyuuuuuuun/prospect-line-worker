import json
import sys
import time
import urllib.parse
import urllib.request

BASE = 'https://prospect-line-webhook.line-harness-trampoline.workers.dev'
ROUTES = [
    'a/saitama-shibakawa', 'a/sugishita', 'a/mizuhodai', 'a/kamekubo',
    'a/ageo-fujimi', 'a/ageo-shibakawa', 'a/kasumigaseki-nishi',
    'b/tsuruse', 'b/meiho', 'b/omiya-higashi', 'b/tsurugashima-daiichi',
    'b/okegawa-nishi', 'b/kitamoto-higashi', 'b/kamihira-kita',
    'c/katayanagi', 'c/muneoka-daini', 'c/kamine', 'c/kumagaya-nishi',
    'c/gyoda-nishi', 'c/asaka-dai10', 'c/tokorozawa-minami', 'c/kurohama-minami',
    'd/obukuro-higashi', 'd/shimooshi', 'd/izumi', 'd/yagisaki',
    'd/nakano', 'd/ebinuma', 'd/komatsu', 'd/shima',
]

def get_json(url, timeout=20):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.status, dict(response.headers), json.loads(response.read().decode('utf-8'))

def post_availability(route, timeout=30):
    data = json.dumps({'route': route}).encode('utf-8')
    request = urllib.request.Request(
        BASE + '/api/reservations/availability',
        data=data,
        headers={'content-type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read().decode('utf-8'))
        return response.status, dict(response.headers), body

def health(route):
    url = BASE + '/health/availability-snapshot?route=' + urllib.parse.quote(route, safe='')
    return get_json(url)

# Wait until the new snapshot-enabled production Worker is live.
ready = False
for attempt in range(72):
    try:
        status, _, body = health('b/tsuruse')
        if status == 200 and body.get('ok') is True:
            print('snapshot endpoint live:', body, flush=True)
            ready = True
            break
    except Exception as exc:
        if attempt in (0, 11, 23, 35, 47, 59, 71):
            print('waiting for deployment:', type(exc).__name__, str(exc), flush=True)
    time.sleep(5)
if not ready:
    raise SystemExit('snapshot-enabled Worker deployment was not observed')

# One request per venue. This creates the durable daily snapshot through the production path.
for index, route in enumerate(ROUTES, 1):
    last = None
    for attempt in range(3):
        try:
            status, headers, body = post_availability(route)
            last = (status, headers, body)
            if status == 200 and body.get('ok') is True:
                cache = headers.get('x-prospect-cache') or headers.get('X-Prospect-Cache') or 'none'
                print(f'{index:02d}/30 {route} http={status} cache={cache} ok=true', flush=True)
                break
        except Exception as exc:
            last = exc
        time.sleep(1 + attempt)
    else:
        print('warmup failed:', route, repr(last), file=sys.stderr, flush=True)
        raise SystemExit(1)
    time.sleep(0.35)

# Verify the durable snapshot, not merely the edge response.
failed = []
for route in ROUTES:
    state = ''
    body = None
    for _ in range(6):
        try:
            status, _, body = health(route)
            state = body.get('state', '') if status == 200 else ''
            if state == 'ready':
                break
        except Exception:
            pass
        time.sleep(1)
    print(f'{route} snapshot={state or "unknown"}', flush=True)
    if state != 'ready':
        failed.append((route, body))

if failed:
    print('snapshots not ready:', failed, file=sys.stderr, flush=True)
    raise SystemExit(1)
print('ALL_30_SNAPSHOTS_READY', flush=True)
