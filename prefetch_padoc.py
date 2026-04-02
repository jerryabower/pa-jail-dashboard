#!/usr/bin/env python3
"""Pre-fetches PA DOC roster at Docker build time and saves to cache file."""
import sys, json, time
sys.path.insert(0, '/app')
import pa_jail_lookup as pj
import urllib3
urllib3.disable_warnings()

print('Pre-fetching PA DOC roster...')
try:
    inmates = pj.fetch_padoc('', 'PA DOC')
    cache = {'data': inmates, 'ts': int(time.time() * 1000)}
    with open('/app/padoc_cache.json', 'w') as f:
        json.dump(cache, f)
    print(f'Cached {len(inmates)} inmates to padoc_cache.json')
except Exception as e:
    print(f'Warning: PA DOC pre-fetch failed: {e} - will fetch on first request')
