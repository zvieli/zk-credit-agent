FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install essential dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    bash \
    libc6 \
    libstdc++6 \
    python3 \
    make \
    g++ \
    git \
    libc++1 \
    libc++abi1 \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 via Nodesource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install nargo (Noir)
RUN mkdir -p /root/.nargo/bin
RUN curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash || true
ENV PATH="/root/.nargo/bin:$PATH"
RUN /root/.nargo/bin/noirup -v 1.0.0-beta.19

# Install bb (Barretenberg) v4.0.0-nightly.20260120
# This is the exact version matching nargo 1.0.0-beta.19 per the official bb-versions.json mapping:
# https://raw.githubusercontent.com/AztecProtocol/aztec-packages/next/barretenberg/bbup/bb-versions.json
RUN mkdir -p /root/.bb \
    && curl -sL --fail \
       https://github.com/AztecProtocol/aztec-packages/releases/download/v4.0.0-nightly.20260120/barretenberg-amd64-linux.tar.gz \
       -o /tmp/bb.tar.gz \
    && tar xzf /tmp/bb.tar.gz -C /root/.bb \
    && rm /tmp/bb.tar.gz \
    && chmod +x /root/.bb/bb
ENV PATH="/root/.bb:$PATH"
ENV BB_BIN="/root/.bb/bb"

# Install Foundry (forge, cast)
RUN curl -L https://foundry.paradigm.xyz | bash || true
ENV PATH="/root/.foundry/bin:$PATH"
RUN /root/.foundry/bin/foundryup

WORKDIR /app

# Copy root and backend package files
COPY package.json ./
COPY packages/backend/package.json ./packages/backend/

# Install dependencies (ignoring scripts because source files are not copied yet)
RUN npm install --ignore-scripts && npm install -g tsx

# Copy the rest of the application code
COPY . .

# Set the working directory to the backend package
WORKDIR /app/packages/backend

EXPOSE 3001

# The command will be overridden by docker-compose for the worker service
CMD ["npm", "run", "api"]
