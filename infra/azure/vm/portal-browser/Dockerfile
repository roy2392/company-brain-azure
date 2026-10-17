# A real Chromium in Azure, viewable through noVNC: for using portals (Foundry, OpenMetadata) from networks that block
# them, and for recording demos of those portals. You sign in yourself; the demo driver attaches over CDP.
FROM mcr.microsoft.com/playwright:v1.55.0-noble
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify ffmpeg fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm i --no-audit --no-fund playwright@1.55.0 >/dev/null
COPY start.sh browser.mjs ./
EXPOSE 6080
CMD ["bash", "/app/start.sh"]
