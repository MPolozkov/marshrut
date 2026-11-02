FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
CMD ["node", "dist/main.js"]
