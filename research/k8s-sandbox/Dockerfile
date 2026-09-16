FROM node:22-bookworm-slim
WORKDIR /app
COPY node_modules ./node_modules
COPY package.json package-lock.json ./
COPY cluster-access.mjs runner.mjs lease-holder.mjs ./
COPY k8s-scripts ./k8s-scripts
CMD ["node", "runner.mjs"]
