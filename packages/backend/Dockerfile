FROM node:20-slim

# Install build dependencies and tools
RUN apt-get update && apt-get install -y curl bash libc6 libstdc++6 python3 make g++ git libc++1 libc++abi1

# Install nargo (Noir)
RUN mkdir -p /root/.nargo/bin
RUN curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash || true
ENV PATH="/root/.nargo/bin:$PATH"
RUN /root/.nargo/bin/noirup -v 1.0.0-beta.19

# Install bb (Barretenberg)
RUN mkdir -p /root/.bb
RUN curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/cpp/installation/install | bash || true
ENV PATH="/root/.bb:$PATH"
RUN /root/.bb/bbup -v 0.47.1

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
