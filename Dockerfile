FROM node:20-slim

# Install Python and dependencies for pa_jail_lookup.py
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    wget \
    gnupg \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip3 install --break-system-packages \
    requests \
    beautifulsoup4 \
    playwright \
    urllib3 \
    gender-guesser

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
RUN python3 /app/prefetch_padoc.py || echo "PA DOC pre-fetch skipped"

# Expose port
EXPOSE 5000

# Start production server
CMD ["node", "dist/index.cjs"]
