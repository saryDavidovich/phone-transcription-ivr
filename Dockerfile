# בנייה ב-Railway בלי הכלי האוטומטי שלהם (railpack), שנכשל בהורדה
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "ivr.js"]
