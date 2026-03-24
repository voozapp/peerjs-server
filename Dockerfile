FROM --platform=$BUILDPLATFORM node:22 AS build
ARG TARGETPLATFORM
ARG BUILDPLATFORM

WORKDIR /peer-server

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm test

FROM node:22-alpine AS production

WORKDIR /peer-server

LABEL org.opencontainers.image.source=https://github.com/voozapp/vooz-peerjs-server

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /peer-server/dist/bin/peerjs.js ./

# Add an environment variable so the app knows its version, This can be read by your code via process.env.APP_VERSION
ARG VERSION
ENV APP_VERSION=$VERSION

ENV PORT=9000
EXPOSE 9000

CMD ["node", "peerjs.js"]