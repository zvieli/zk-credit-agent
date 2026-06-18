FROM node:20-slim

# Install build dependencies and tools
RUN apt-get update && apt-get install -y curl bash libc6 libstdc++6 python3 make g++ git

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

WORKDIR /app

# Copy root and backend package files
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/

# Install dependencies
RUN npm install && npm install -g tsx

# Copy the rest of the application code
COPY . .

# Set the working directory to the backend package
WORKDIR /app/packages/backend

EXPOSE 3001

# The command will be overridden by docker-compose for the worker service
CMD ["npm", "run", "api"]
