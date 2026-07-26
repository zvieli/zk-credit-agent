FROM node:20-slim

WORKDIR /app

# Copy root and frontend package files
COPY package.json ./
COPY packages/frontend/package.json ./packages/frontend/

# Install dependencies (ignoring scripts because source files are not copied yet)
RUN npm install --ignore-scripts

# Copy the rest of the application code
COPY . .

# Set working directory to packages/frontend
WORKDIR /app/packages/frontend

EXPOSE 5173

# Start Vite server listening on all network interfaces
CMD ["npx", "vite", "--host", "0.0.0.0"]
