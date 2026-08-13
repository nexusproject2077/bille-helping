# ============================================================
# Bille Helping — Backend (Cloud Run)
# ============================================================
FROM node:20-slim

# Cloud Run fournit le port via la variable d'environnement PORT
ENV NODE_ENV=production
WORKDIR /app

# Installe les dependances de production a partir du manifeste
COPY package*.json ./
RUN npm install --omit=dev

# Copie le code de l'application
COPY . .

# Cloud Run route le trafic vers $PORT (8080 par defaut)
EXPOSE 8080
CMD ["node", "server.js"]
