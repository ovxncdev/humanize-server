FROM ghcr.io/puppeteer/puppeteer:21.6.1

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /home/pptruser/app

# Copy package files as root, fix ownership
COPY --chown=pptruser:pptruser package*.json ./

# Install as the pptruser (matches the base image's user)
RUN npm install --production

# Copy rest of app
COPY --chown=pptruser:pptruser . .

EXPOSE 3000

CMD ["node", "server.js"]