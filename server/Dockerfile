# Breaker szinkron-kiszolgáló.
#
# Nincs függősége, tehát nincs npm install és nincs build lépés sem: a kép
# annyi, hogy a Node mellé bemásoljuk a két fájlt.
FROM node:22-alpine

# Nem rootként fut: ha valaki mégis kijutna a folyamatból, ne a gép legyen a
# jutalma. A node felhasználó a hivatalos képben már létezik.
WORKDIR /app
COPY server.js store.js package.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV BREAKER_SYNC_DIR=/data
ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
