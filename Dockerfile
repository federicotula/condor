FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY config ./config
RUN ln -s /app/src/cli.js /usr/local/bin/condor
ENV HOST=0.0.0.0 PORT=8000 CONDOR_CONFIG=/app/config/modules.json CONDOR_DATA=/app/data NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8000
CMD ["node", "src/cli.js", "web"]
