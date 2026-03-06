FROM node:22-slim

WORKDIR /app

# Install build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source and project files
COPY tsconfig.json ./
COPY src/ src/
COPY README.md LICENSE CONTRIBUTING.md CHANGELOG.md ./

# Build
RUN npm run build

# Default command: run tests
CMD ["npm", "run", "test:run"]
