FROM node:20-slim

# Install Python and dependencies for pa_jail_lookup.py
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip3 install --break-system-packages \
    requests \
    beautifulsoup4 \
    playwright \
    urllib3

# Install Playwright browsers
RUN playwright install chromium --with-deps

WORKDIR /app

# Copy package files and install Node deps
COPY package*.json ./
RUN npm ci

# Copy all source files
COPY . .

# Copy the PA jail lookup script
COPY pa_jail_lookup.py ./pa_jail_lookup.py

# Build the frontend + backend bundle
RUN npm run build

# Pre-fetch PA DOC roster and cache to disk so first request is instant
# This runs at build time — baked into the image
RUN python3 -c "
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
    print(f'Warning: PA DOC pre-fetch failed: {e} — will fetch on first request')
" || echo "PA DOC pre-fetch skipped"

# Expose port
EXPOSE 5000

# Start production server
CMD ["node", "dist/index.cjs"]
