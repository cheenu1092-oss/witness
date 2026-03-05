FROM node:22-slim

WORKDIR /app

# Install build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ src/

# Build
RUN npm run build

# Default command: run tests
CMD ["npm", "run", "test:run"]
